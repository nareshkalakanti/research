"use client";

import {
  StrategyExpandDetail,
  type StrategyExpandPanel,
  type StrategyRowLinks,
} from "@/components/StrategyExpandDetail";
import { FundWatchlistTags } from "@/components/FundWatchlistTags";
import { WatchButton } from "@/components/WatchButton";
import { secDisplay } from "@/components/SecCell";
import type { FundWatchlistKey } from "@/lib/fund-watchlist-meta";
import type { ConcallDocLinks } from "@/lib/strategy/concall-drift-types";

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
  drift_block?: "stale" | "pending" | null;
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
} & StrategyRowLinks;

/** Reference-style: 30-Apr-2026 · 12:12 PM */
function fmtEventParts(
  iso: string | null,
): { date: string; time: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const date = d
    .toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    })
    .replace(/ /g, "-");
  const time = d.toLocaleString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return { date, time };
}

function fmtLtp(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
}

function fmtDrift(n: number | null): string {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function fmtMcap(n: number | null): string {
  if (n == null) return "—";
  if (n >= 100_000) return `${(n / 100_000).toFixed(1)}L Cr`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K Cr`;
  return `${Math.round(n).toLocaleString("en-IN")} Cr`;
}

export const PCD_COL_SPAN = 7;

function EventWhen({ iso }: { iso: string | null }) {
  const when = fmtEventParts(iso);
  if (!when) return <span className="pcd-muted">—</span>;
  return (
    <span className="pcd-when" title={iso || undefined}>
      <span className="pcd-when-d">{when.date}</span>
      <span className="pcd-when-t">{when.time}</span>
    </span>
  );
}

type Props = {
  row: StrategyConcallDriftRowData;
  open: boolean;
  panel: StrategyExpandPanel;
  onToggle: () => void;
  onPanel: (panel: StrategyExpandPanel) => void;
  onDocsChange?: () => void;
  /** Which event timestamp to show in the date column. Default earn filing. */
  dateField?: "earn" | "concall";
  /** Hide watch / fund chips for the lean Drift tab. */
  compactMeta?: boolean;
  /** Show “since DD-Mon” under the % (Drift tab). */
  showSinceHint?: boolean;
  /** Optional remove control (Track tab). */
  onRemove?: () => void;
};

export function StrategyConcallDriftRow({
  row: r,
  open,
  panel,
  onToggle,
  onPanel,
  dateField = "earn",
  compactMeta = false,
  showSinceHint = false,
  onRemove,
}: Props) {
  const sec = secDisplay(r.sector, r.sub_sector);
  const whenIso = dateField === "concall" ? r.concall_at || r.earn_at : r.earn_at;
  const sinceParts = fmtEventParts(whenIso);
  const driftTitle =
    r.drift_pct == null && r.drift_block === "stale" && r.baseline_close != null
      ? `Need live price (quote older than call) — baseline ₹${r.baseline_close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
      : r.drift_pct == null && r.baseline_close != null
        ? `Pending next session — baseline ₹${r.baseline_close.toLocaleString("en-IN", { maximumFractionDigits: 2 })} (call-day close)`
        : r.baseline_close != null && sinceParts
          ? `% change since ${sinceParts.date}: LTP / baseline − 1 (baseline ₹${r.baseline_close.toLocaleString("en-IN", { maximumFractionDigits: 2 })})`
          : r.baseline_close != null
            ? `Baseline ₹${r.baseline_close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
            : "No pre-event baseline yet";

  const expandable = !compactMeta;

  return (
    <>
      <tr
        className={open && expandable ? "pcd-row is-open" : "pcd-row"}
        onClick={expandable ? onToggle : undefined}
        style={expandable ? { cursor: "pointer" } : undefined}
      >
        <td className="pcd-td-ticker">
          <a
            className="pcd-ticker"
            href={r.tv}
            target="_blank"
            rel="noopener noreferrer"
            title={`${r.ticker} — TradingView`}
            onClick={(e) => e.stopPropagation()}
          >
            {r.ticker}
          </a>
        </td>
        <td className="pcd-td-co">
          <div className="pcd-co-cell">
            {compactMeta ? null : <WatchButton ticker={r.ticker} />}
            {expandable ? (
              <button
                type="button"
                className="pcd-co-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle();
                }}
              >
                <span className="pcd-co-name">{r.name}</span>
                {/\bSME\b/i.test(r.market) ? (
                  <span className="pcd-badge">SME</span>
                ) : null}
                {r.has_hold ? (
                  <span className="pcd-badge pcd-badge-hold">Hold</span>
                ) : null}
                <FundWatchlistTags tags={r.fund_tags} />
              </button>
            ) : (
              <span className="pcd-co-name">
                {r.name}
                {/\bSME\b/i.test(r.market) ? (
                  <span className="pcd-badge"> SME</span>
                ) : null}
              </span>
            )}
          </div>
        </td>
        <td className="pcd-td-sec" title={sec.title}>
          <span className="pcd-sec-stack">
            <span className="pcd-sec-primary">{sec.primary}</span>
            {sec.secondary ? (
              <span className="pcd-sec-sub">{sec.secondary}</span>
            ) : null}
          </span>
        </td>
        <td
          className="pcd-td-mcap num"
          title={
            r.market_cap_cr != null
              ? `₹${r.market_cap_cr.toLocaleString("en-IN")} Cr`
              : undefined
          }
        >
          <span className="pcd-mcap-val">{fmtMcap(r.market_cap_cr)}</span>
        </td>
        <td className="pcd-td-ltp num">{fmtLtp(r.price)}</td>
        <td className="pcd-td-earn">
          <EventWhen iso={whenIso} />
        </td>
        <td className="pcd-td-drift" title={driftTitle}>
          {r.drift_pct == null ? (
            <span className="pcd-muted">—</span>
          ) : (
            <span className="pcd-drift-stack">
              <span
                className={`pcd-drift ${
                  r.drift_pct > 0
                    ? "is-up"
                    : r.drift_pct < 0
                      ? "is-down"
                      : "is-flat"
                }`}
              >
                {r.drift_pct > 0 ? "▲" : r.drift_pct < 0 ? "▼" : "·"}
                {fmtDrift(r.drift_pct)}
              </span>
              {showSinceHint && sinceParts ? (
                <span className="pcd-drift-since">since {sinceParts.date}</span>
              ) : null}
            </span>
          )}
        </td>
        {onRemove ? (
          <td className="pcd-td-track-rm num">
            <button
              type="button"
              className="pcd-ghost-btn concall-track-rm"
              title={`Stop tracking ${r.ticker}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              Remove
            </button>
          </td>
        ) : null}
      </tr>
      {expandable ? (
        <StrategyExpandDetail
          ticker={r.ticker}
          name={r.name}
          market={r.market}
          price={r.price}
          links={{ sc: r.sc, tv: r.tv, web: r.web }}
          open={open}
          panel={panel}
          onPanel={onPanel}
          colSpan={onRemove ? PCD_COL_SPAN + 1 : PCD_COL_SPAN}
        />
      ) : null}
    </>
  );
}
