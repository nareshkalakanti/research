"use client";

import { useCallback, useEffect, useState } from "react";
import {
  StrategyExpandDetail,
  type StrategyExpandPanel,
  type StrategyRowLinks,
  type StrategyCorpEnrichment,
} from "@/components/StrategyExpandDetail";
import { SecCell } from "@/components/SecCell";
import { FundWatchlistTags } from "@/components/FundWatchlistTags";
import type { FundWatchlistKey } from "@/lib/fund-watchlist-meta";
import type { ConcallDocLinks } from "@/lib/strategy/concall-drift-types";
import { highlightsFromMaterials } from "@/lib/strategy/concall-highlights";
import { parseFetchJson } from "@/lib/fetch-json";

export type { StrategyCorpEnrichment };

export type StrategyConcallDriftRowData = {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  sub_sector: string | null;
  market_cap_cr: number | null;
  price: number | null;
  earn_at: string;
  concall_at: string | null;
  quarter_fy: string | null;
  baseline_close: number | null;
  drift_pct: number | null;
  has_baseline: boolean;
  earn_subject: string | null;
  has_bb: boolean;
  has_bb_w: boolean;
  has_bb_m: boolean;
  has_tq: boolean;
  has_edge: boolean;
  has_hold: boolean;
  fund_tags: FundWatchlistKey[];
  docs: ConcallDocLinks;
  highlights: string[];
  keyword?: string | null;
  corp?: StrategyCorpEnrichment | null;
} & StrategyRowLinks;

function fmtEventParts(iso: string | null): { date: string; time: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    date: d.toLocaleString("en-IN", { day: "numeric", month: "short" }),
    time: d.toLocaleString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }),
  };
}

function fmtLtp(n: number | null): string {
  if (n == null) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtDrift(n: number | null): string {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function fmtMcap(n: number | null): string {
  if (n == null) return "—";
  if (n >= 100_000) return `₹${(n / 100_000).toFixed(1)}L Cr`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(1)}K Cr`;
  return `₹${Math.round(n).toLocaleString("en-IN")} Cr`;
}

const COL_SPAN = 9;

type Props = {
  index: number;
  row: StrategyConcallDriftRowData;
  open: boolean;
  panel: StrategyExpandPanel;
  onToggle: () => void;
  onPanel: (panel: StrategyExpandPanel) => void;
  onDocsChange?: () => void;
};

export function StrategyConcallDriftRow({
  index,
  row: r,
  open,
  panel,
  onToggle,
  onPanel,
  onDocsChange,
}: Props) {
  const when = fmtEventParts(r.concall_at || r.earn_at);
  const [highlights, setHighlights] = useState<string[]>(r.highlights ?? []);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    setHighlights(r.highlights ?? []);
  }, [r.ticker, r.highlights]);

  const fetchDocs = useCallback(async () => {
    if (fetching) return;
    setFetching(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/investor-materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "import_latest",
          ticker: r.ticker,
          limit: 2,
          kinds: ["concall", "ppt", "transcript"],
          distill: true,
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const j = await parseFetchJson<{
        ok?: boolean;
        error?: string;
        materials?: Array<{
          kind: string;
          source_url?: string | null;
          brief_text?: string | null;
          raw_text?: string | null;
        }>;
      }>(res);
      const materials = j.materials ?? [];
      setHighlights(highlightsFromMaterials(materials));
      if (!res.ok || j.ok === false) {
        throw new Error(j.error || "Firecrawl / LLM fetch failed");
      }
      onDocsChange?.();
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setFetching(false);
    }
  }, [fetching, onDocsChange, r.ticker]);

  return (
    <>
      <tr className={open ? "row-open" : undefined}>
        <td className="cd-idx">{index}</td>
        <td className="cd-co">
          <button type="button" className="company-cell cd-co-btn" onClick={onToggle}>
            <span className="company-name">{r.name}</span>
            {!open ? <span className="cd-co-sub">{r.ticker}</span> : null}
            <span className="result-tags">
              {/\bSME\b/i.test(r.market) ? (
                <span className="result-tag tag-mkt-sme" title={r.market}>
                  SME
                </span>
              ) : null}
              {r.has_hold ? (
                <span className="result-tag tag-hold" title="In your holdings">
                  Hold
                </span>
              ) : null}
              {r.has_bb_w ? (
                <span className="result-tag tag-scan-bb-w" title="BB NEW weekly">
                  BB W
                </span>
              ) : null}
              {r.has_bb_m ? (
                <span className="result-tag tag-scan-bb-m" title="BB NEW monthly">
                  BB M
                </span>
              ) : null}
              {r.has_tq ? (
                <span className="result-tag tag-scan-tq" title="TQ weekly signal">
                  TQ
                </span>
              ) : null}
              {r.has_edge ? (
                <span className="result-tag tag-edge" title="Early Edge watchlist">
                  Edge
                </span>
              ) : null}
              <FundWatchlistTags tags={r.fund_tags} />
            </span>
          </button>
        </td>
        <td className="cd-date">
          {when ? (
            <>
              <span className="cd-date-d">{when.date}</span>
              <span className="cd-date-t">{when.time}</span>
              {r.quarter_fy ? <span className="cd-date-q">{r.quarter_fy}</span> : null}
            </>
          ) : (
            r.quarter_fy || "—"
          )}
        </td>
        <td className="cd-mcap num" title={r.market_cap_cr != null ? `₹${r.market_cap_cr.toLocaleString("en-IN")} Cr` : undefined}>
          {fmtMcap(r.market_cap_cr)}
        </td>
        <SecCell sector={r.sector} subSector={r.sub_sector} />
        <td className="num cd-ltp">{fmtLtp(r.price)}</td>
        <td
          className="num cd-drift"
          title={
            r.baseline_close != null
              ? `Close before concall announcement ₹${r.baseline_close.toLocaleString("en-IN")}`
              : undefined
          }
        >
          {r.drift_pct == null ? (
            <span className="mom-tag mom-tag--empty">—</span>
          ) : (
            <span
              className={`mom-tag ${
                r.drift_pct > 0
                  ? "mom-tag--pos"
                  : r.drift_pct < 0
                    ? "mom-tag--neg"
                    : "mom-tag--flat"
              }`}
            >
              {fmtDrift(r.drift_pct)}
            </span>
          )}
        </td>
        <td
          className="cd-kw"
          title={r.keyword || r.corp?.keyword || r.earn_subject || undefined}
        >
          {r.keyword || r.corp?.keyword ? (
            <span className="cd-kw-pill">
              {r.keyword || r.corp?.keyword}
            </span>
          ) : (
            <span className="ann-muted">—</span>
          )}
        </td>
        <td className="col-links cd-links">
          <div className="cd-link-row">
            {r.web ? (
              <a
                href={r.web}
                target="_blank"
                rel="noopener noreferrer"
                className="cd-link"
              >
                Web
              </a>
            ) : (
              <span className="cd-link is-off">Web</span>
            )}
            <a
              href={r.sc}
              target="_blank"
              rel="noopener noreferrer"
              className="cd-link"
            >
              SC
            </a>
            <a
              href={r.tv}
              target="_blank"
              rel="noopener noreferrer"
              className="cd-link"
            >
              TV
            </a>
          </div>
        </td>
      </tr>
      <StrategyExpandDetail
        ticker={r.ticker}
        name={r.name}
        market={r.market}
        price={r.price}
        links={{ sc: r.sc, tv: r.tv, web: r.web }}
        open={open}
        panel={panel}
        onPanel={onPanel}
        colSpan={COL_SPAN}
        showFilingTabs
        highlights={highlights}
        docsFetching={fetching}
        docsError={fetchError}
        onFetchDocs={fetchDocs}
        onDocsChange={onDocsChange}
        corp={r.corp ?? null}
      />
    </>
  );
}
