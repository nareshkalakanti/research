"use client";

import { useEffect, useState } from "react";
import { QuarterPanel } from "@/components/QuarterPanel";
import { QuoteTapeCard } from "@/components/QuoteTapeCard";
import { useExpandQuarters } from "@/lib/use-expand-quarters";
type NapkinAboutPayload = {
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

export function NapkinCompanyContext({
  ticker,
  exchange,
  price,
  companyName,
}: {
  ticker: string;
  exchange?: string | null;
  price: number | null;
  companyName?: string | null;
}) {
  const market = (exchange || "").trim() || null;
  const qtr = useExpandQuarters(ticker, market, price, true);
  const [about, setAbout] = useState<NapkinAboutPayload | null>(null);
  const [aboutLoading, setAboutLoading] = useState(false);
  const [aboutError, setAboutError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const t = ticker.trim().toUpperCase();
    if (!t) {
      setAbout(null);
      setAboutError(null);
      return;
    }
    setAboutLoading(true);
    setAboutError(null);
    void (async () => {
      try {
        const q = new URLSearchParams({ ticker: t });
        if (market) q.set("market", market);
        if (companyName?.trim()) q.set("name", companyName.trim());
        const res = await fetch(`/api/napkin/about?${q}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(45_000),
        });
        const json = (await res.json()) as NapkinAboutPayload;
        if (dead) return;
        if (!res.ok || json.ok === false) {
          setAbout(null);
          setAboutError(json.error || `About HTTP ${res.status}`);
          return;
        }
        setAbout(json);
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
  }, [ticker, market, companyName]);

  const meta = [about?.sector, about?.sub_sector, about?.headquarters, about?.market]
    .map((x) => (x || "").trim())
    .filter(Boolean);
  // Prefer sector · sub_sector first (CUPID-style); HQ/market after if present.
  const metaLine = (() => {
    const sectorBits = [about?.sector, about?.sub_sector]
      .map((x) => (x || "").trim())
      .filter(Boolean);
    const rest = [about?.headquarters, about?.market]
      .map((x) => (x || "").trim())
      .filter(Boolean);
    if (sectorBits.length) {
      return [...sectorBits, ...rest].join(" · ");
    }
    return meta.length ? meta.join(" · ") : null;
  })();

  const hasAbout =
    !!(about?.headline || about?.about || (about?.products?.length ?? 0) > 0);

  return (
    <>
      <div className="napkin-sheet-section">
        <h2 className="napkin-block-title">About</h2>
        {aboutLoading ? (
          <p className="napkin-debug">Loading about…</p>
        ) : aboutError ? (
          <p className="napkin-missing">{aboutError}</p>
        ) : hasAbout ? (
          <div className="napkin-about-rich">
            {about?.headline ? (
              <p className="napkin-about-headline">{about.headline}</p>
            ) : null}
            {metaLine ? <p className="napkin-meta-row">{metaLine}</p> : null}
            {about?.about ? (
              <p className="napkin-about-body">{about.about}</p>
            ) : null}
            {about?.products?.length ? (
              <ul className="napkin-about-products">
                {about.products.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </div>
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
