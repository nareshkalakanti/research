"use client";

import { Loading } from "@/components/Loading";
import { useEffect, useState } from "react";

export type CompanyAboutPayload = {
  ok: boolean;
  ticker: string;
  name: string | null;
  headline: string | null;
  sector: string | null;
  sub_sector: string | null;
  about: string | null;
  products: string[];
  headquarters: string | null;
  market: string | null;
  source: "company_about" | "yahoo" | "none";
  error?: string;
};

type Props = {
  ticker: string;
  market?: string | null;
  companyName?: string | null;
  active?: boolean;
  className?: string;
};

export function CompanyAboutCard({
  ticker,
  market,
  companyName,
  active = true,
  className,
}: Props) {
  const [about, setAbout] = useState<CompanyAboutPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let dead = false;
    const t = ticker.trim().toUpperCase();
    if (!t) {
      setAbout(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const q = new URLSearchParams({ ticker: t });
        const mkt = (market || "").trim();
        if (mkt) q.set("market", mkt);
        if (companyName?.trim()) q.set("name", companyName.trim());
        const res = await fetch(`/api/napkin/about?${q}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(45_000),
        });
        const json = (await res.json()) as CompanyAboutPayload;
        if (dead) return;
        if (!res.ok || json.ok === false) {
          setAbout(null);
          setError(json.error || `About HTTP ${res.status}`);
          return;
        }
        setAbout(json);
      } catch (e) {
        if (!dead) {
          setAbout(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, [ticker, market, companyName, active]);

  const sectorBits = [about?.sector, about?.sub_sector]
    .map((x) => (x || "").trim())
    .filter(Boolean);
  const rest = [about?.headquarters, about?.market]
    .map((x) => (x || "").trim())
    .filter(Boolean);
  const metaLine = sectorBits.length
    ? [...sectorBits, ...rest].join(" · ")
    : rest.length
      ? rest.join(" · ")
      : null;

  const hasAbout =
    !!(about?.headline || about?.about || (about?.products?.length ?? 0) > 0);

  return (
    <section className={`company-about-card ${className || ""}`.trim()}>
      <h3 className="company-about-card-title">About</h3>
      {loading ? (
        <Loading label="Loading about" variant="inline" />
      ) : error ? (
        <p className="company-about-card-muted">{error}</p>
      ) : hasAbout ? (
        <div className="company-about-card-rich">
          {about?.headline ? (
            <p className="company-about-card-headline">{about.headline}</p>
          ) : null}
          {metaLine ? (
            <p className="company-about-card-meta">{metaLine}</p>
          ) : null}
          {about?.about ? (
            <p className="company-about-card-body">{about.about}</p>
          ) : null}
          {about?.products?.length ? (
            <ul className="company-about-card-products">
              {about.products.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <p className="company-about-card-muted">No about text yet.</p>
      )}
    </section>
  );
}
