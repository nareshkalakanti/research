"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addWatch,
  listWatchedTickers,
  removeWatch,
  subscribeWatchlist,
} from "@/lib/user-watchlist";
import { WatchButton } from "@/components/WatchButton";
import { TickerSuggest } from "@/components/TickerSuggest";
import { SecCell } from "@/components/SecCell";
import { tradingviewUrl } from "@/lib/links";
import { formatRsiM } from "@/lib/types";
import { GOV_BOARD_SCORE_TITLE } from "@/lib/gov-score";
import { useExpandQuarters } from "@/lib/use-expand-quarters";
import { useExpandBrief } from "@/lib/use-expand-brief";
import {
  cfProfitClass,
  fmtQVal,
  qCellClass,
  type QuarterPanel,
} from "@/lib/quarter-panel";
import {
  classifyQuarterTrend,
  describeQuarterTable,
  overallTrendLabel,
} from "@/lib/quarter-trend";
import { formatPeDisplay, forwardPeClass } from "@/lib/valuation";
import type { CompanyBrief, CompanyBriefContext, OfferingItem } from "@/lib/company-brief";
import { isPlaceholderWatch } from "@/lib/brief-placeholder";
import { useOptionalAppTab } from "@/lib/app-tab";
import { writeFocusTicker } from "@/lib/workspace-ticker";

type ChipList = "watch" | "holdings" | "named" | "common";

/** Distinct hues for named-list chips (not tied to any list label). */
const NAMED_LIST_HUES = [
  32, 262, 338, 195, 48, 285, 12, 220, 168, 300, 75, 250,
];

function namedListChipHue(index: number): number {
  return NAMED_LIST_HUES[index % NAMED_LIST_HUES.length]!;
}

function sharedAcrossLists(lists: string[][], min = 2): string[] {
  const counts = new Map<string, number>();
  for (const xs of lists) {
    const seen = new Set(
      xs.map((t) => t.trim().toUpperCase()).filter(Boolean),
    );
    if (!seen.size) continue;
    for (const t of seen) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= min)
    .map(([t]) => t)
    .sort((a, b) => a.localeCompare(b));
}

type WatchRow = {
  ticker: string;
  company: string;
  market: string | null;
  price: number | null;
  change_pct?: number | null;
  board_score?: number | null;
  market_cap_cr: number | null;
  sector: string | null;
  sub_sector?: string | null;
  about?: string | null;
  headquarters?: string | null;
  momentum_pct?: number | null;
  rsi_m?: number | null;
  crossed_200dma_recently?: boolean;
  has_bb_w?: boolean;
  has_bb_m?: boolean;
  has_tq?: boolean;
  has_ema?: boolean;
  has_ath?: boolean;
  has_high52?: boolean;
  has_mrsi?: boolean;
  has_mrsi85?: boolean;
  tq_score?: number | null;
  has_concall?: boolean;
};

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })} Cr`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

type QuoteTapeMa = {
  period: 20 | 50 | 100 | 200;
  value: number | null;
  above: boolean | null;
};

type QuoteTape = {
  price: number | null;
  prev_close: number | null;
  pe: number | null;
  cagr_pct: number | null;
  cagr_years: number | null;
  week52_low: number | null;
  week52_high: number | null;
  dma200: number | null;
  breakout20: number | null;
  dma200_alert: "below_200_breakout" | null;
  mas: QuoteTapeMa[];
};

function crossedAbove200Dma(tape: QuoteTape | null): boolean {
  if (!tape) return false;
  if (tape.price == null || tape.dma200 == null || tape.prev_close == null) {
    return false;
  }
  return tape.prev_close <= tape.dma200 && tape.price > tape.dma200;
}

function WlQuoteTape({
  ticker,
  market,
}: {
  ticker: string;
  market: string | null;
}) {
  const [tape, setTape] = useState<QuoteTape | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const q = new URLSearchParams({ ticker });
    if (market) q.set("market", market);
    void fetch(`/api/quote-tape?${q}`, { signal: AbortSignal.timeout(45_000) })
      .then(async (res) => {
        const json = (await res.json()) as { ok?: boolean; tape?: QuoteTape };
        if (!cancelled && json.ok && json.tape) setTape(json.tape);
      })
      .catch(() => {
        if (!cancelled) setTape(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, market]);

  if (loading && !tape) {
    return <p className="wl-card-muted">Price…</p>;
  }
  if (!tape || (tape.price == null && tape.mas.every((m) => m.value == null))) {
    return null;
  }

  const low = tape.week52_low;
  const high = tape.week52_high;
  const px = tape.price;
  const span = low != null && high != null && high > low ? high - low : null;
  const pct =
    span != null && px != null
      ? Math.min(100, Math.max(0, ((px - low!) / span) * 100))
      : null;
  const cagrCls =
    tape.cagr_pct == null
      ? undefined
      : tape.cagr_pct >= 0
        ? "q-up"
        : "q-down";
  const dma200Label =
    tape.dma200_alert === "below_200_breakout"
      ? "Below 200 DMA · Fresh breakout"
        : null;

  return (
    <div className="wl-tape">
      <table className="wl-mini-q">
        <thead>
          <tr>
            <th></th>
            <th>Price</th>
            <th>PE</th>
            <th>{tape.cagr_years ? `${tape.cagr_years}Y CAGR` : "CAGR"}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>Last</th>
            <td>{fmtPrice(tape.price)}</td>
            <td>{tape.pe != null ? tape.pe.toFixed(2) : "—"}</td>
            <td className={cagrCls}>
              {tape.cagr_pct == null
                ? "—"
                : `${tape.cagr_pct >= 0 ? "+" : ""}${tape.cagr_pct.toFixed(1)}%`}
            </td>
          </tr>
        </tbody>
      </table>
      <table className="wl-mini-q">
        <thead>
          <tr>
            <th></th>
            {tape.mas.map((m) => (
              <th key={m.period}>{m.period}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>SMA</th>
            {tape.mas.map((m) => (
              <td
                key={m.period}
                className={
                  m.above === true ? "q-up" : m.above === false ? "q-down" : undefined
                }
                title={
                  m.above === true
                    ? "Price above SMA"
                    : m.above === false
                      ? "Price below SMA"
                      : undefined
                }
              >
                {m.value != null
                  ? m.value.toLocaleString("en-IN", {
                      maximumFractionDigits: 2,
                    })
                  : "—"}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      {dma200Label ? (
        <div className="wl-dma-alert" role="status" aria-live="polite">
          <span className="wl-dma-alert-pill">{dma200Label}</span>
          {tape.dma200 != null && tape.price != null ? (
            <span className="wl-dma-alert-text">
              200 DMA {tape.dma200.toLocaleString("en-IN", { maximumFractionDigits: 2 })} ·
              Breakout {tape.breakout20 != null
                ? tape.breakout20.toLocaleString("en-IN", {
                    maximumFractionDigits: 2,
                  })
                : "—"} · Price{" "}
              {tape.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
            </span>
          ) : null}
        </div>
      ) : null}
      {low != null && high != null ? (
        <div className="wl-tape-range">
          <span className="wl-tape-label">52-week</span>
          <div className="wl-range-track">
            <span className="wl-range-lo">{fmtPrice(low)}</span>
            <span className="wl-range-bar">
              {pct != null ? (
                <i className="wl-range-dot" style={{ left: `${pct}%` }} />
              ) : null}
            </span>
            <span className="wl-range-hi">{fmtPrice(high)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChangeCell({ value }: { value: number | null | undefined }) {
  if (value == null || Number.isNaN(value)) {
    return <span className="chg-empty">—</span>;
  }
  const tone = value > 0 ? "pos" : value < 0 ? "neg" : "flat";
  const label = `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
  return (
    <span className={`chg-1d chg-1d--${tone}`} title="Today vs previous close">
      {label}
    </span>
  );
}

function RsiCell({
  value,
  crossed,
  great,
}: {
  value: number | null | undefined;
  crossed?: boolean;
  great?: boolean;
}) {
  const label = formatRsiM(value);
  if (value == null || Number.isNaN(value)) {
    return <span className="mom-tag mom-tag--empty">—</span>;
  }
  const tone =
    value >= 90
      ? "rsi-hot"
      : value >= 85 || great
        ? "rsi-great"
        : value >= 70
          ? "rsi-ok"
          : "flat";
  const titleParts = [
    "Monthly RSI(14)",
    value >= 90
      ? "extended / overbought"
      : value >= 85
        ? "excellent momentum window"
        : value >= 70
          ? "constructive"
          : "below 70",
  ];
  if (crossed) titleParts.push("new cross above 70");
  return (
    <span className={`mom-tag mom-tag--${tone}`} title={titleParts.join(" · ")}>
      {label}
    </span>
  );
}

function Dma200Badge({ crossed }: { crossed: boolean }) {
  if (!crossed) return null;
  return (
    <span className="result-tag tag-dma200" title="Crossed above 200 DMA today">
      200 DMA ↑
    </span>
  );
}

function SignalChips({
  row,
  hideEmpty,
}: {
  row: WatchRow;
  hideEmpty?: boolean;
}) {
  const tabs = useOptionalAppTab();
  const chips: Array<{ key: string; label: string; title: string; className: string }> =
    [];
  if (row.has_bb_w) {
    chips.push({
      key: "bbw",
      label: "BB W",
      title: "BB NEW weekly",
      className: "tag-scan-bb-w",
    });
  }
  if (row.has_bb_m) {
    chips.push({
      key: "bbm",
      label: "BB M",
      title: "BB NEW monthly",
      className: "tag-scan-bb-m",
    });
  }
  if (row.has_tq) {
    chips.push({
      key: "tq",
      label: row.tq_score != null ? `TQ ${Math.round(row.tq_score)}` : "TQ",
      title: "TQ weekly crossover",
      className: "tag-scan-tq",
    });
  }
  if (row.has_ema) {
    chips.push({
      key: "ema",
      label: "EMA",
      title: "Daily close above 10/20/50/200 EMA",
      className: "tag-scan-ema",
    });
  }
  if (row.has_ath) {
    chips.push({
      key: "ath",
      label: "ATH",
      title: "NEW all-time high",
      className: "tag-scan-ath",
    });
  }
  if (row.has_high52) {
    chips.push({
      key: "52w",
      label: "52W",
      title: "NEW 52-week high",
      className: "tag-scan-high52",
    });
  }
  if (row.has_mrsi) {
    chips.push({
      key: "mrsi",
      label: "RSI↑",
      title: "New monthly RSI cross above 70",
      className: "tag-scan-mrsi",
    });
  }
  if (row.has_concall) {
    chips.push({
      key: "cc",
      label: "CC",
      title: "Research concall PASS",
      className: "tag-scan-cc",
    });
  }
  if (!chips.length) {
    return hideEmpty ? null : <span className="mom-tag mom-tag--empty">—</span>;
  }
  return (
    <div className="wl-signal-chips">
      {chips.map((c) =>
        c.key === "cc" ? (
          <button
            key={c.key}
            type="button"
            className={`result-tag ${c.className}`}
            title={c.title}
            onClick={(e) => {
              e.stopPropagation();
              writeFocusTicker(row.ticker);
              tabs?.setTab("research", { ticker: row.ticker });
            }}
          >
            {c.label}
          </button>
        ) : (
          <span
            key={c.key}
            className={`result-tag ${c.className}`}
            title={c.title}
          >
            {c.label}
          </span>
        ),
      )}
    </div>
  );
}

function MiniQtr({ panel }: { panel: QuarterPanel }) {
  const labels = panel.labels;
  const offset = panel.labels.length - labels.length;
  const rows = panel.rows.filter((r) =>
    /sales|operating profit|^opm|net profit/i.test(r.label),
  );
  return (
    <table className="wl-mini-q">
      <thead>
        <tr>
          <th></th>
          {labels.map((l) => (
            <th key={l}>{l.replace(/ 20/, " '")}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th>{row.label.replace("Operating Profit", "OP")}</th>
            {labels.map((_, i) => {
              const idx = offset + i;
              const cls = qCellClass(row, idx);
              return (
                <td key={`${row.label}-${idx}`} className={cls || undefined}>
                  {fmtQVal(row.values[idx] ?? null, row.decimals)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function isUsable(text: string | null | undefined): boolean {
  const t = (text || "").trim();
  if (t.replace(/\s/g, "").length < 8) return false;
  if (/^not disclosed$/i.test(t)) return false;
  if (/business summary unavailable/i.test(t)) return false;
  if (/not specified|unclear from sources|₹X\b|not explicitly stated/i.test(t)) {
    return false;
  }
  if (isPlaceholderWatch(t)) return false;
  return true;
}

function splitTriggers(text: string): string[] {
  const t = (text || "").trim();
  if (!t) return [];
  const parts =
    /[·\n]/.test(t)
      ? t.split(/\s*·\s*|\n+/)
      : t.split(/\s*;\s*|\s*,\s+(?=[A-Z0-9])/);
  return parts.map((p) => p.trim()).filter((p) => isUsable(p));
}

function parseLabeledFields(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const text = (raw ?? "").trim();
  if (!text) return out;
  for (const line of text.split(/\n+/)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9 /&'_-]{1,48}):\s*(.+)$/);
    if (!m) continue;
    const val = m[2]!.trim();
    if (!val || val === "—" || /^[—\-–]+$/.test(val) || /^n\/?a$/i.test(val)) {
      continue;
    }
    out[m[1]!.trim().toLowerCase()] = val;
  }
  return out;
}

function collectTriggers(
  brief: CompanyBrief | null,
  context: CompanyBriefContext | null,
  fallbackAbout: string | null,
): string[] {
  const blobs: string[] = [];
  if (brief?.growth_triggers) blobs.push(brief.growth_triggers);
  if (brief?.capex && !/unclear from sources|not disclosed|unavailable/i.test(brief.capex)) {
    blobs.push(brief.capex);
  }
  if (context?.recent_moves) blobs.push(context.recent_moves);
  const fields = {
    ...parseLabeledFields(fallbackAbout),
    ...parseLabeledFields(context?.scraped_about_clean),
  };
  for (const key of [
    "growth triggers",
    "growth trigger",
    "catalysts",
    "catalyst",
    "capex",
    "expansion",
    "recent moves",
  ]) {
    if (fields[key]) blobs.push(fields[key]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const blob of blobs) {
    for (const part of splitTriggers(blob)) {
      const key = part.toLowerCase().slice(0, 48);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(part);
    }
  }
  return out.slice(0, 6);
}

function firstAboutLine(about: string | null | undefined): string {
  const t = (about || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const sentence = t.match(/^.{12,180}?(?:[.!?](?=\s|$)|$)/);
  return (sentence ? sentence[0] : t.slice(0, 180)).trim();
}

function storyFromBrief(
  brief: CompanyBrief | null,
  context: CompanyBriefContext | null,
  fallbackAbout: string | null,
) {
  const aboutLine = firstAboutLine(fallbackAbout);
  const headline =
    (brief?.headline && isUsable(brief.headline) ? brief.headline.trim() : "") ||
    (brief?.niche && isUsable(brief.niche) ? brief.niche.trim() : "") ||
    aboutLine;
  const model =
    (brief?.model && isUsable(brief.model) ? brief.model.trim() : "") ||
    (brief?.capabilities && isUsable(brief.capabilities)
      ? brief.capabilities.trim()
      : "") ||
    (context?.business_model && isUsable(context.business_model)
      ? context.business_model.trim()
      : "");
  const offerings: OfferingItem[] = brief
    ? brief.offerings?.length
      ? brief.offerings.slice(0, 4).filter((o) => isUsable(o.name))
      : (brief.products ?? [])
          .slice(0, 4)
          .filter((n) => isUsable(n))
          .map((name) => ({ name, line: "" }))
    : [];
  if (!offerings.length && context?.products) {
    for (const name of context.products.split(/\s*[;|]\s*|\s*,\s+/).slice(0, 4)) {
      if (isUsable(name)) offerings.push({ name: name.trim(), line: "" });
    }
  }
  const triggers = collectTriggers(brief, context, fallbackAbout);
  const meta = [brief?.sector, brief?.sub_sector]
    .map((s) => (s || "").trim())
    .filter((s) => s && !/not explicitly stated/i.test(s));
  const fallback =
    headline && headline === aboutLine
      ? ""
      : !headline && !model
        ? (fallbackAbout || "").trim()
        : !headline
          ? (fallbackAbout || "").trim()
          : "";
  return {
    headline,
    model,
    offerings,
    triggers,
    meta,
    fallback,
  };
}

function WlKpis({
  qtr,
  row,
}: {
  qtr: ReturnType<typeof useExpandQuarters>;
  row: WatchRow;
}) {
  if (qtr.loading) {
    return <p className="wl-card-muted">Reading quarters…</p>;
  }
  const overall = qtr.panel
    ? classifyQuarterTrend(qtr.panel, qtr.yoy)
    : null;
  const story =
    (qtr.panel ? describeQuarterTable(qtr.panel, qtr.yoy) : null) ||
    overall?.reason ||
    null;
  const cf = qtr.extras?.cf_profit ?? null;
  const gov =
    row.board_score != null && Number.isFinite(row.board_score)
      ? row.board_score.toFixed(1)
      : "—";
  return (
    <div className="wl-kpis">
      <div className="wl-kpi">
        <span>Fwd PE</span>
        <strong className={forwardPeClass(qtr.forward_pe)}>
          {qtr.forward_pe != null ? formatPeDisplay(qtr.forward_pe) : "—"}
        </strong>
      </div>
      <div className="wl-kpi" title="Operating cash flow ÷ net profit">
        <span>CF/P</span>
        <strong className={cfProfitClass(cf)}>
          {cf != null ? cf.toFixed(2) : "—"}
        </strong>
      </div>
      <div className="wl-kpi" title={GOV_BOARD_SCORE_TITLE}>
        <span>Gov</span>
        <strong>{gov}</strong>
      </div>
      <div className="wl-kpi" title="Monthly RSI(14)">
        <span>RSI M</span>
        <RsiCell
          value={row.rsi_m}
          crossed={row.has_mrsi}
          great={row.has_mrsi85}
        />
      </div>
      {overall ? (
        <div
          className={`wl-kpi-signal wl-kpi-signal--${overall.signal.toLowerCase()}`}
          title={overall.reason}
        >
          {overallTrendLabel(overall.signal)}
        </div>
      ) : null}
      <SignalChips row={row} hideEmpty />
      {story ? <p className="wl-kpi-story">{story}</p> : null}
    </div>
  );
}

function WatchlistRow({
  r,
  canRemove,
  onRemoveHold,
  rank,
  showMomentumColumn,
}: {
  r: WatchRow;
  canRemove: boolean;
  onRemoveHold?: (ticker: string) => void;
  rank?: number | null;
  showMomentumColumn: boolean;
}) {
  const [open, setOpen] = useState(false);
  const qtr = useExpandQuarters(r.ticker, r.market, r.price, open);
  const brief = useExpandBrief(r.ticker, r.market, r.price, qtr, open);
  const tv = tradingviewUrl(r.ticker, r.market);

  return (
    <>
      <tr className={open ? "wl-row-open" : undefined}>
        <td className="col-name">
          <div className="company-watch-cell">
            <button
              type="button"
              className={`wl-expand-btn${open ? " on" : ""}`}
              aria-expanded={open}
              aria-label={open ? "Hide about and quarters" : "Show about and quarters"}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "−" : "+"}
            </button>
            <WatchButton ticker={r.ticker} />
            <Dma200Badge crossed={!!r.crossed_200dma_recently} />
            {rank != null ? (
              <span className="wl-rank-pill" title="Momentum rank">
                #{rank}
              </span>
            ) : null}
            <div className="company-watch-name">
              <a
                className="company-name wl-tv-name"
                href={tv}
                target="_blank"
                rel="noreferrer"
                title={`Open ${r.ticker} on TradingView`}
              >
                {r.company}
              </a>
              <span className="company-meta">
                <span className="ticker">{r.ticker}</span>
                {/\bSME\b/i.test(r.market || "") ? (
                  <span
                    className="result-tag tag-mkt-sme"
                    title={`${r.market} listing`}
                  >
                    SME
                  </span>
                ) : null}
              </span>
            </div>
          </div>
        </td>
        <SecCell
          className="col-sec"
          sector={r.sector}
          subSector={r.sub_sector}
        />
        <td className="num col-mcap_cr">{fmtCr(r.market_cap_cr)}</td>
        <td className="num col-price">{fmtPrice(r.price)}</td>
        <td className="num col-chg">
          <ChangeCell value={r.change_pct} />
        </td>
        {showMomentumColumn ? (
          <td className="num col-mom" title="12-1 momentum">
            {r.momentum_pct != null ? (
              <span
                className={`mom-tag mom-tag--${
                  Math.round(r.momentum_pct) > 0
                    ? "pos"
                    : Math.round(r.momentum_pct) < 0
                      ? "neg"
                      : "flat"
                }`}
              >
                {`${Math.round(r.momentum_pct) > 0 ? "+" : ""}${Math.round(
                  r.momentum_pct,
                )}%`}
              </span>
            ) : (
              <span className="mom-tag mom-tag--empty">—</span>
            )}
          </td>
        ) : null}
        <td className="col-remove">
          {canRemove ? (
            <button
              type="button"
              className="wl-remove-chip"
              title={`Remove ${r.ticker}`}
              onClick={() => removeWatch(r.ticker)}
            >
              Remove
            </button>
          ) : onRemoveHold ? (
            <button
              type="button"
              className="wl-remove-chip"
              title={`Remove ${r.ticker} from this list`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemoveHold(r.ticker);
              }}
            >
              Remove
            </button>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr className="wl-expand-row">
          <td colSpan={showMomentumColumn ? 7 : 6}>
            <div className="wl-card">
              <WlKpis qtr={qtr} row={r} />
              <div className="wl-card-body">
                <section className="wl-story">
                  {brief.loading && !brief.brief ? (
                    <p className="wl-card-muted">
                      {brief.waitingForQuarters
                        ? "Reading quarters…"
                        : "Building brief…"}
                    </p>
                  ) : null}
                  {(() => {
                    const s = storyFromBrief(
                      brief.brief,
                      brief.context,
                      r.about ?? null,
                    );
                    return (
                      <>
                        {s.headline ? (
                          <h4 className="wl-story-title">{s.headline}</h4>
                        ) : null}
                        {s.meta.length ? (
                          <p className="wl-story-meta">{s.meta.join(" · ")}</p>
                        ) : r.sector || r.sub_sector ? (
                          <p className="wl-story-meta">
                            {[r.sector, r.sub_sector].filter(Boolean).join(" · ")}
                          </p>
                        ) : null}
                        {s.model ? (
                          <p className="wl-story-model">{s.model}</p>
                        ) : null}
                        {s.offerings.length ? (
                          <ul className="wl-sells">
                            {s.offerings.map((o) => (
                              <li key={o.name}>
                                <strong>{o.name}</strong>
                                {o.line ? <span>{o.line}</span> : null}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {s.triggers.length ? (
                          <div className="wl-triggers">
                            {s.triggers.map((t) => (
                              <span key={t}>{t}</span>
                            ))}
                          </div>
                        ) : null}
                        {s.fallback ? (
                          <p className="wl-card-fallback">{s.fallback}</p>
                        ) : null}
                      </>
                    );
                  })()}
                </section>
                <div className="wl-side-stack">
                  <section className="wl-card-qtr wl-card-price">
                    <h3>Price</h3>
                    <WlQuoteTape ticker={r.ticker} market={r.market} />
                  </section>
                  <section className="wl-card-qtr">
                    <h3>Quarters</h3>
                    {qtr.loading ? (
                      <p className="wl-card-muted">Loading…</p>
                    ) : qtr.error ? (
                      <p className="wl-card-muted">{qtr.error}</p>
                    ) : qtr.panel?.labels?.length ? (
                      <MiniQtr panel={qtr.panel} />
                    ) : (
                      <p className="wl-card-muted">No quarterly data.</p>
                    )}
                  </section>
                </div>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function WatchlistPanel() {
  const [list, setList] = useState<ChipList>("watch");
  const [namedKey, setNamedKey] = useState("alpha");
  const [tickers, setTickers] = useState<string[]>([]);
  const [holdTickers, setHoldTickers] = useState<string[]>([]);
  const [namedLists, setNamedLists] = useState<
    Array<{ key: string; label: string; tickers: string[]; count: number }>
  >([]);
  const [newListOpen, setNewListOpen] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [rows, setRows] = useState<WatchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [addQ, setAddQ] = useState("");
  const [listEpoch, setListEpoch] = useState(0);
  const loadSeqRef = useRef(0);

  const namedTickers =
    namedLists.find((l) => l.key === namedKey)?.tickers ?? [];
  const namedLabel =
    namedLists.find((l) => l.key === namedKey)?.label ?? "List";

  const refreshTickers = useCallback(() => {
    setTickers(listWatchedTickers());
  }, []);

  const applyHoldTickers = useCallback((next: string[]) => {
    setHoldTickers(
      next.map((t) => t.trim().toUpperCase()).filter(Boolean),
    );
  }, []);

  const refreshHoldings = useCallback(async () => {
    try {
      const res = await fetch("/api/holdings", {
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as { tickers?: string[] };
      applyHoldTickers(json.tickers ?? []);
    } catch {
      setHoldTickers([]);
    }
  }, [applyHoldTickers]);

  const applyNamedLists = useCallback(
    (
      lists: Array<{
        key: string;
        label: string;
        tickers: string[];
        count?: number;
      }>,
    ) => {
      setNamedLists(
        lists.map((l) => ({
          key: l.key,
          label: l.label,
          tickers: (l.tickers ?? []).map((t) => t.trim().toUpperCase()).filter(Boolean),
          count: l.count ?? (l.tickers ?? []).length,
        })),
      );
    },
    [],
  );

  const refreshNamed = useCallback(async () => {
    try {
      const res = await fetch("/api/named-watchlists", {
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as {
        lists?: Array<{
          key: string;
          label: string;
          tickers: string[];
          count: number;
        }>;
      };
      applyNamedLists(json.lists ?? []);
    } catch {
      setNamedLists([]);
    }
  }, [applyNamedLists]);

  const selectWatch = () => {
    loadSeqRef.current += 1;
    setRows([]);
    setBusy(false);
    setListEpoch((n) => n + 1);
    setRenameOpen(false);
    setList("watch");
  };

  const selectHoldings = () => {
    loadSeqRef.current += 1;
    if (list !== "holdings") {
      setRows([]);
      setBusy(false);
    }
    setListEpoch((n) => n + 1);
    setRenameOpen(false);
    setList("holdings");
  };

  const selectNamed = (key: string) => {
    loadSeqRef.current += 1;
    setRows([]);
    setBusy(false);
    setListEpoch((n) => n + 1);
    setNamedKey(key);
    setRenameOpen(false);
    setRenameName(
      namedLists.find((l) => l.key === key)?.label ?? "",
    );
    setList("named");
  };

  const selectCommon = () => {
    loadSeqRef.current += 1;
    setRows([]);
    setBusy(false);
    setListEpoch((n) => n + 1);
    setRenameOpen(false);
    setList("common");
  };

  const addNamedTicker = useCallback(
    async (hit: {
      ticker: string;
      name?: string | null;
      market?: string | null;
      sector?: string | null;
    }) => {
      const ticker = hit.ticker.trim().toUpperCase();
      if (!ticker || !namedKey) return;
      try {
        const res = await fetch("/api/named-watchlists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            list: namedKey,
            ticker,
            name: hit.name || null,
            market: hit.market || null,
            sector: hit.sector || null,
          }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          tickers?: string[];
          lists?: Array<{
            key: string;
            label: string;
            tickers: string[];
            count: number;
          }>;
          error?: string;
        };
        if (!res.ok || json.ok === false) {
          setError(json.error || "Could not add to list");
          return;
        }
        if (json.lists) applyNamedLists(json.lists);
        setAddQ("");
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not add to list");
      }
    },
    [namedKey, applyNamedLists],
  );

  const removeNamedTicker = useCallback(
    async (ticker: string) => {
      const t = ticker.trim().toUpperCase();
      if (!t || !namedKey) return;
      try {
        const res = await fetch(
          `/api/named-watchlists?list=${encodeURIComponent(namedKey)}&ticker=${encodeURIComponent(t)}`,
          { method: "DELETE" },
        );
        const json = (await res.json()) as {
          lists?: Array<{
            key: string;
            label: string;
            tickers: string[];
            count: number;
          }>;
        };
        if (json.lists) applyNamedLists(json.lists);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not remove from list");
      }
    },
    [namedKey, applyNamedLists],
  );

  const createList = useCallback(async () => {
    const label = newListName.trim();
    if (!label) return;
    try {
      const res = await fetch("/api/named-watchlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ create: true, label }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        list?: { key: string; label: string; tickers: string[] };
        lists?: Array<{
          key: string;
          label: string;
          tickers: string[];
          count: number;
        }>;
        error?: string;
      };
      if (!res.ok || json.ok === false || !json.list) {
        setError(json.error || "Could not create list");
        return;
      }
      if (json.lists) applyNamedLists(json.lists);
      setNewListName("");
      setNewListOpen(false);
      selectNamed(json.list.key);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create list");
    }
  }, [newListName, applyNamedLists]);

  const renameList = useCallback(async () => {
    const label = renameName.trim();
    if (!label || !namedKey) return;
    try {
      const res = await fetch("/api/named-watchlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rename: true, list: namedKey, label }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        list?: { key: string; label: string };
        lists?: Array<{
          key: string;
          label: string;
          tickers: string[];
          count: number;
        }>;
        error?: string;
      };
      if (!res.ok || json.ok === false) {
        setError(json.error || "Could not rename list");
        return;
      }
      if (json.lists) applyNamedLists(json.lists);
      setRenameOpen(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename list");
    }
  }, [renameName, namedKey, applyNamedLists]);

  const addHolding = useCallback(
    async (hit: {
      ticker: string;
      name?: string | null;
      market?: string | null;
      sector?: string | null;
    }) => {
      const ticker = hit.ticker.trim().toUpperCase();
      if (!ticker) return;
      try {
        const res = await fetch("/api/holdings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticker,
            name: hit.name || null,
            market: hit.market || null,
            sector: hit.sector || null,
          }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          tickers?: string[];
          error?: string;
        };
        if (!res.ok || json.ok === false) {
          setError(json.error || "Could not add holding");
          return;
        }
        applyHoldTickers(json.tickers ?? [ticker]);
        selectHoldings();
        setAddQ("");
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not add holding");
      }
    },
    [applyHoldTickers],
  );

  const removeHolding = useCallback(
    async (ticker: string) => {
      const t = ticker.trim().toUpperCase();
      if (!t) return;
      try {
        const res = await fetch(
          `/api/holdings?ticker=${encodeURIComponent(t)}`,
          { method: "DELETE" },
        );
        const json = (await res.json()) as { tickers?: string[] };
        applyHoldTickers(json.tickers ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not remove holding");
      }
    },
    [applyHoldTickers],
  );

  const loadRows = useCallback(async (syms: string[]) => {
    const loadSeq = ++loadSeqRef.current;
    if (!syms.length) {
      setRows([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const CHUNK = 40;
      const collected: WatchRow[] = [];
      for (let i = 0; i < syms.length; i += CHUNK) {
        if (loadSeq !== loadSeqRef.current) return;
        const chunk = syms.slice(i, i + CHUNK);
        const res = await fetch(
          `/api/iq-master?tickers=${encodeURIComponent(chunk.join(","))}`,
        );
        if (loadSeq !== loadSeqRef.current) return;
        const json = (await res.json()) as {
          ok?: boolean;
          rows?: WatchRow[];
          error?: string;
        };
        if (loadSeq !== loadSeqRef.current) return;
        if (!res.ok || json.ok === false) {
          setError(json.error || "Failed to load watchlist");
          setRows([]);
          return;
        }
        collected.push(...(json.rows ?? []));
      }
      if (loadSeq !== loadSeqRef.current) return;
      const byTicker = new Map(
        collected.map((r) => [r.ticker.toUpperCase(), r]),
      );
      const nextRows = syms.map((t) => {
        const hit = byTicker.get(t.toUpperCase());
        return (
          hit ?? {
            ticker: t,
            company: t,
            market: null,
            price: null,
            change_pct: null,
            board_score: null,
            market_cap_cr: null,
            sector: null,
            sub_sector: null,
            about: null,
            headquarters: null,
            momentum_pct: null,
            rsi_m: null,
            crossed_200dma_recently: false,
            has_bb_w: false,
            has_bb_m: false,
            has_tq: false,
            has_ema: false,
            has_ath: false,
            has_high52: false,
            has_mrsi: false,
            has_mrsi85: false,
            tq_score: null,
            has_concall: false,
          }
        );
      });
      if (loadSeq !== loadSeqRef.current) return;
      setRows(nextRows);
      void (async () => {
        const CHUNK = 8;
        const updates = new Map<string, boolean>();
        for (let i = 0; i < nextRows.length; i += CHUNK) {
          if (loadSeq !== loadSeqRef.current) return;
          const chunk = nextRows.slice(i, i + CHUNK);
          await Promise.all(
            chunk.map(async (row) => {
              try {
                const q = new URLSearchParams({ ticker: row.ticker });
                if (row.market) q.set("market", row.market);
                const res = await fetch(`/api/quote-tape?${q}`, {
                  signal: AbortSignal.timeout(30_000),
                });
                const json = (await res.json()) as {
                  ok?: boolean;
                  tape?: QuoteTape;
                };
                updates.set(row.ticker.toUpperCase(), crossedAbove200Dma(json.ok ? json.tape ?? null : null));
              } catch {
                updates.set(row.ticker.toUpperCase(), false);
              }
            }),
          );
        }
        if (loadSeq !== loadSeqRef.current) return;
        setRows((cur) =>
          cur.map((row) => {
            const crossed = updates.get(row.ticker.toUpperCase());
            return crossed == null
              ? row
              : { ...row, crossed_200dma_recently: crossed };
          }),
        );
      })();
    } catch (e) {
      if (loadSeq !== loadSeqRef.current) return;
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      if (loadSeq === loadSeqRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    refreshTickers();
    void refreshHoldings();
    void refreshNamed();
    return subscribeWatchlist(refreshTickers);
  }, [refreshTickers, refreshHoldings, refreshNamed]);

  const commonTickers = useMemo(
    () =>
      sharedAcrossLists([
        holdTickers,
        ...namedLists.map((l) => l.tickers),
      ]),
    [holdTickers, namedLists],
  );

  const activeTickers =
    list === "holdings"
      ? holdTickers
      : list === "named"
        ? namedTickers
        : list === "common"
          ? commonTickers
          : tickers;
  const activeTickerKey = `${listEpoch}:${list}:${namedKey}:${activeTickers.join(",")}`;

  const rankedList =
    list === "named" || list === "holdings" || list === "common";
  const momentumOn = rankedList;
  const showMomentumColumn = momentumOn;

  const momRankByTicker = useMemo(() => {
    const ranked = [...rows]
      .filter((r) => r.momentum_pct != null && Number.isFinite(r.momentum_pct))
      .sort((a, b) => {
        const d = (b.momentum_pct ?? 0) - (a.momentum_pct ?? 0);
        if (d !== 0) return d;
        return a.ticker.localeCompare(b.ticker);
      });
    return new Map(ranked.map((r, i) => [r.ticker.toUpperCase(), i + 1]));
  }, [rows]);

  const sortedRows = useMemo(() => {
    const base = [...rows];
    return base.sort((a, b) => {
      if (rankedList) {
        const ac = a.crossed_200dma_recently ? 1 : 0;
        const bc = b.crossed_200dma_recently ? 1 : 0;
        if (bc !== ac) return bc - ac;
        const am = a.momentum_pct ?? Number.NEGATIVE_INFINITY;
        const bm = b.momentum_pct ?? Number.NEGATIVE_INFINITY;
        if (bm !== am) return bm - am;
        return a.ticker.localeCompare(b.ticker);
      }
      const ac = a.crossed_200dma_recently ? 1 : 0;
      const bc = b.crossed_200dma_recently ? 1 : 0;
      if (bc !== ac) return bc - ac;
      return 0;
    });
  }, [rows, rankedList]);

  useEffect(() => {
    const parts = activeTickerKey.split(":");
    const joined = parts.slice(3).join(":");
    void loadRows(joined ? joined.split(",") : []);
  }, [activeTickerKey, loadRows]);

  const refreshPrices = useCallback(() => {
    if (!activeTickers.length) return;
    void loadRows(activeTickers);
  }, [activeTickers, loadRows]);

  const [fillQtrBusy, setFillQtrBusy] = useState(false);
  const [fillQtrLabel, setFillQtrLabel] = useState<string | null>(null);

  const fillMissingQuarters = useCallback(async () => {
    const tickers = activeTickers.map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (!tickers.length) return;
    setFillQtrBusy(true);
    setFillQtrLabel("Fill Quarters · missing-only…");
    let remaining = 1;
    let saved = 0;
    let failed = 0;
    const postBatch = async () => {
      const maxAttempts = 4;
      let lastErr: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const res = await fetch("/api/quarters-fill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              market: "All",
              tickers,
              limit: 8,
              concurrency: 2,
              missingOnly: true,
            }),
            cache: "no-store",
          });
          const json = (await res.json()) as {
            ok?: boolean;
            saved?: number;
            failed?: number;
            remaining?: number;
            error?: string;
            message?: string;
          };
          if (!res.ok || json.ok === false) {
            throw new Error(json.error || json.message || "Quarters fill failed");
          }
          return json;
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e));
          const msg = lastErr.message || "";
          const retryable =
            /failed to fetch|networkerror|load failed|aborted|timeout|timed out/i.test(
              msg,
            ) ||
            lastErr.name === "TimeoutError" ||
            lastErr.name === "AbortError";
          if (!retryable || attempt === maxAttempts) break;
          setFillQtrLabel(`Fill Quarters · reconnect ${attempt}/${maxAttempts - 1}…`);
          await new Promise((r) => setTimeout(r, 700 * attempt));
        }
      }
      throw lastErr ?? new Error("Quarters fill failed");
    };

    try {
      for (let round = 1; round <= 80; round += 1) {
        const json = await postBatch();
        saved += json.saved ?? 0;
        failed += json.failed ?? 0;
        remaining = json.remaining ?? 0;
        setFillQtrLabel(
          remaining <= 0
            ? `Quarters done · +${saved} cached`
            : `Fill Quarters · +${saved} · ${failed} miss · ${remaining} left`,
        );
        if (remaining <= 0) break;
      }
      setListEpoch((n) => n + 1);
    } catch (e) {
      setFillQtrLabel(e instanceof Error ? e.message : "Quarters fill failed");
    } finally {
      setFillQtrBusy(false);
    }
  }, [activeTickers]);

  const needle = q.trim().toLowerCase();
  const visible = !needle
    ? sortedRows
    : sortedRows.filter(
        (r) =>
          r.ticker.toLowerCase().includes(needle) ||
          r.company.toLowerCase().includes(needle) ||
          (r.sector || "").toLowerCase().includes(needle) ||
          (r.sub_sector || "").toLowerCase().includes(needle),
      );

  return (
    <section className="panel wl-panel wl-panel--simple">
      <header className="wl-simple-head">
        <div>
          <h1 className="wl-simple-title">Watchlist</h1>
          <p className="wl-simple-sub">
            Search a ticker to add it. Name opens TradingView. Expand (+) for
            price tape, about, and quarters.
          </p>
        </div>
        <span className="wl-simple-count" role="status">
          {error
            ? error
            : busy
              ? "Loading…"
              : activeTickers.length === 0
                ? "Empty"
                : `${visible.length} of ${activeTickers.length}`}
        </span>
      </header>

      <div className="wl-list-chips" role="tablist" aria-label="List">
        <button
          type="button"
          role="tab"
          aria-selected={list === "watch"}
          className={`chip tag-chip${list === "watch" ? " on" : ""}`}
          onClick={selectWatch}
        >
          Watchlist
          <span className="chip-count">{tickers.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={list === "holdings"}
          className={`chip tag-chip tag-hold${list === "holdings" ? " on" : ""}`}
          onClick={() => selectHoldings()}
        >
          Holdings
          <span className="chip-count">{holdTickers.length}</span>
        </button>
        {namedLists.map((nl, i) => (
          <button
            key={nl.key}
            type="button"
            role="tab"
            aria-selected={list === "named" && namedKey === nl.key}
            className={`chip tag-chip wl-named-chip${
              list === "named" && namedKey === nl.key ? " on" : ""
            }`}
            style={{
              ["--wl-named-h" as string]: String(namedListChipHue(i)),
            }}
            onClick={() => selectNamed(nl.key)}
          >
            {nl.label}
            <span className="chip-count">{nl.count}</span>
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={list === "common"}
          className={`chip tag-chip tag-common${list === "common" ? " on" : ""}`}
          title="Names on two or more of Holdings and named lists"
          onClick={selectCommon}
        >
          Common
          <span className="chip-count">{commonTickers.length}</span>
        </button>
        {list === "named" && renameOpen ? (
          <span className="wl-new-list">
            <input
              className="miq-search"
              type="text"
              placeholder="Rename list"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void renameList();
                if (e.key === "Escape") setRenameOpen(false);
              }}
              autoFocus
            />
            <button type="button" className="btn-ghost" onClick={() => void renameList()}>
              Save
            </button>
          </span>
        ) : list === "named" ? (
          <button
            type="button"
            className="chip tag-chip"
            onClick={() => {
              setNewListOpen(false);
              setRenameName(namedLabel);
              setRenameOpen(true);
            }}
            title={`Rename ${namedLabel}`}
          >
            Rename
          </button>
        ) : null}
        {newListOpen ? (
          <span className="wl-new-list">
            <input
              className="miq-search"
              type="text"
              placeholder="List name"
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createList();
                if (e.key === "Escape") {
                  setNewListOpen(false);
                  setNewListName("");
                }
              }}
              autoFocus
            />
            <button type="button" className="btn-ghost" onClick={() => void createList()}>
              Create
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="chip tag-chip"
            onClick={() => {
              setRenameOpen(false);
              setNewListOpen(true);
            }}
            title="Create a named list with momentum ranks and 200 DMA, like Alpha"
          >
            + List
          </button>
        )}
      </div>

      <div className="wl-simple-toolbar">
        <div className="theme-stock-search theme-stock-search--inline wl-add-search">
          <TickerSuggest
            value={addQ}
            onChange={setAddQ}
            placeholder={
              list === "common"
                ? "Common is read-only — names on two or more lists"
                : list === "holdings"
                ? "Search ticker or company to add to holdings…"
                : list === "named"
                  ? `Search ticker or company to add to ${namedLabel}…`
                  : "Search ticker or company to add…"
            }
            className="theme-stock-suggest-input"
            disabled={list === "common"}
            onSelect={(hit) => {
              if (list === "common") return;
              if (list === "holdings") {
                void addHolding(hit);
                return;
              }
              if (list === "named") {
                void addNamedTicker(hit);
                return;
              }
              addWatch(hit.ticker);
              setAddQ("");
            }}
            onSubmit={(t) => {
              if (list === "common") return;
              const sym = t.trim().toUpperCase();
              if (!sym) return;
              if (list === "holdings") {
                void addHolding({ ticker: sym });
                return;
              }
              if (list === "named") {
                void addNamedTicker({ ticker: sym });
                return;
              }
              addWatch(sym);
              setAddQ("");
            }}
          />
        </div>
        <input
          className="miq-search"
          type="search"
          placeholder="Filter this list…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={!activeTickers.length}
        />
        <button
          type="button"
          className="btn-ghost"
          disabled={busy || !activeTickers.length}
          onClick={refreshPrices}
          title="Refresh prices and tape for the visible list"
        >
          {busy ? "Refreshing…" : "Refresh prices"}
        </button>
        <button
          type="button"
          className={`chip chip-scan tag-chip${fillQtrBusy ? " busy on" : ""}`}
          disabled={fillQtrBusy || !activeTickers.length}
          onClick={() => void fillMissingQuarters()}
          title="Fill missing quarterly Sales/OP for this list"
        >
          {fillQtrBusy ? "…" : "Fill Quarters"}
        </button>
      </div>
      {fillQtrLabel ? (
        <p className="hint tight wl-qtr-fill-status" role="status">
          {fillQtrLabel}
        </p>
      ) : null}

      {activeTickers.length === 0 ? (
        <p className="miq-empty-hint">
          {list === "holdings"
            ? "No holdings on file — search a ticker to add one."
            : list === "named"
              ? `No names in ${namedLabel} yet — search a ticker to add one.`
              : list === "common"
                ? "No names sit on two or more of Holdings and named lists yet."
                : "Click + Watch next to any stock on Scan."}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data-table wl-simple-table">
            <colgroup>
              <col className="col-name" />
              <col className="col-sec" />
              <col className="col-mcap_cr" />
              <col className="col-price" />
              <col className="col-chg" />
              {showMomentumColumn ? <col className="col-mom" /> : null}
              <col className="col-remove" />
            </colgroup>
            <thead>
              <tr>
                <th className="col-name">Company</th>
                <th className="col-sec">Sec</th>
                <th className="num col-mcap_cr">MCap</th>
                <th className="num col-price">Price</th>
                <th className="num col-chg" title="Today vs previous close">
                  1D
                </th>
                {showMomentumColumn ? (
                  <th className="num col-mom" title="12-1 momentum">
                    Mom
                  </th>
                ) : null}
                <th className="col-remove" />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <WatchlistRow
                  key={r.ticker}
                  r={r}
                  canRemove={list === "watch"}
                  rank={
                    momentumOn
                      ? momRankByTicker.get(r.ticker.toUpperCase())
                      : undefined
                  }
                  showMomentumColumn={showMomentumColumn}
                  onRemoveHold={
                    list === "holdings"
                      ? removeHolding
                      : list === "named"
                        ? removeNamedTicker
                        : undefined
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
