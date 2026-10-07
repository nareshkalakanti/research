"use client";

import { useEffect, useState } from "react";
import { QuarterPanel } from "@/components/QuarterPanel";
import { QuoteTapeCard } from "@/components/QuoteTapeCard";
import { useExpandQuarters } from "@/lib/use-expand-quarters";

type AboutHit = {
  ticker: string;
  name?: string | null;
  about?: string | null;
  sector?: string | null;
  market?: string | null;
  headquarters?: string | null;
};

function usableAbout(text: string | null | undefined): string | null {
  const t = (text || "").trim();
  if (t.replace(/\s/g, "").length < 40) return null;
  if (/^not disclosed$/i.test(t)) return null;
  if (/business summary unavailable/i.test(t)) return null;
  return t;
}

export function NapkinCompanyContext({
  ticker,
  exchange,
  price,
}: {
  ticker: string;
  exchange?: string | null;
  price: number | null;
}) {
  const market = (exchange || "").trim() || null;
  const qtr = useExpandQuarters(ticker, market, price, true);
  const [about, setAbout] = useState<string | null>(null);
  const [aboutMeta, setAboutMeta] = useState<string | null>(null);
  const [aboutLoading, setAboutLoading] = useState(false);
  const [aboutError, setAboutError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const t = ticker.trim().toUpperCase();
    if (!t) {
      setAbout(null);
      setAboutMeta(null);
      setAboutError(null);
      return;
    }
    setAboutLoading(true);
    setAboutError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/companies?q=${encodeURIComponent(t)}&pageSize=20`,
          { cache: "no-store", signal: AbortSignal.timeout(20_000) },
        );
        const json = (await res.json()) as { rows?: AboutHit[] };
        if (!res.ok) throw new Error(`About HTTP ${res.status}`);
        const rows = Array.isArray(json.rows) ? json.rows : [];
        const hit =
          rows.find((r) => (r.ticker || "").toUpperCase() === t) ?? rows[0];
        if (dead) return;
        if (!hit || (hit.ticker || "").toUpperCase() !== t) {
          setAbout(null);
          setAboutMeta(null);
          return;
        }
        setAbout(usableAbout(hit.about));
        const meta = [hit.sector, hit.headquarters, hit.market]
          .map((x) => (x || "").trim())
          .filter(Boolean);
        setAboutMeta(meta.length ? meta.join(" · ") : null);
      } catch (e) {
        if (!dead) {
          setAbout(null);
          setAboutError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!dead) setAboutLoading(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, [ticker]);

  return (
    <>
      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">About</h2>
        {aboutLoading ? (
          <p className="napkin-debug">Loading about…</p>
        ) : aboutError ? (
          <p className="napkin-missing">{aboutError}</p>
        ) : about ? (
          <>
            {aboutMeta ? <p className="napkin-meta-row">{aboutMeta}</p> : null}
            <p className="napkin-about-body">{about}</p>
          </>
        ) : (
          <p className="napkin-missing">No about text in company_about yet.</p>
        )}
      </div>

      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">Quarters</h2>
        <div className="about-qtr-with-tape napkin-qtr-with-tape">
          <div className="about-qtr-main">
            {qtr.loading ? (
              <p className="napkin-debug">Loading quarters…</p>
            ) : qtr.error ? (
              <p className="napkin-missing">{qtr.error}</p>
            ) : qtr.panel?.labels?.length ? (
              <QuarterPanel
                panel={qtr.panel}
                yoy={qtr.yoy}
                price={price}
                sourceNote={qtr.source}
                compact
              />
            ) : (
              <p className="napkin-missing">No quarterly data.</p>
            )}
          </div>
          <QuoteTapeCard ticker={ticker} market={market} active />
        </div>
      </div>
    </>
  );
}
