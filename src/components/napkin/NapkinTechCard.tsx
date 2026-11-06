"use client";

import { useEffect, useState } from "react";
import type { NapkinTechSignals } from "@/lib/napkin/tech-signals";

type Props = {
  ticker: string;
  market?: string | null;
  active?: boolean;
};

export function NapkinTechCard({
  ticker,
  market = null,
  active = true,
}: Props) {
  const [tech, setTech] = useState<NapkinTechSignals | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !ticker.trim()) {
      setTech(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ ticker: ticker.trim().toUpperCase() });
    if (market) q.set("market", market);
    void fetch(`/api/napkin/tech?${q}`, { signal: AbortSignal.timeout(90_000) })
      .then(async (res) => {
        const json = (await res.json()) as {
          ok?: boolean;
          tech?: NapkinTechSignals;
          error?: string;
        };
        if (cancelled) return;
        if (!json.ok || !json.tech) {
          setTech(null);
          setError(json.error || "Tech signals failed");
          return;
        }
        setTech(json.tech);
      })
      .catch(() => {
        if (!cancelled) {
          setTech(null);
          setError("Tech signals failed");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, market, active]);

  if (!active) return null;

  return (
    <section className="napkin-tech-card">
      <h3 className="napkin-block-title">Tech</h3>
      {loading && !tech ? (
        <p className="wl-card-muted">Scanning tech…</p>
      ) : null}
      {error && !tech ? <p className="napkin-error">{error}</p> : null}
      {tech ? (
        <ul className="napkin-tech-list">
          {tech.groups.map((g) => (
            <li
              key={g.id}
              className={`napkin-tech-block is-${g.status}`}
              title={g.detail || undefined}
            >
              <div className="napkin-tech-item">
                <span className="napkin-tech-dot" aria-hidden />
                <span className="napkin-tech-item-label">{g.label}</span>
                <span className="napkin-tech-item-status">{g.statusText}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
