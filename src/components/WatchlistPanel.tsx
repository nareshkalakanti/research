"use client";

import { useCallback, useEffect, useState } from "react";
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
  has_bb_w?: boolean;
  has_bb_m?: boolean;
  has_tq?: boolean;
  has_ema?: boolean;
  has_ath?: boolean;
  has_high52?: boolean;
  has_mrsi?: boolean;
  has_mrsi85?: boolean;
  tq_score?: number | null;
};

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })} Cr`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
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

function SignalChips({
  row,
  hideEmpty,
}: {
  row: WatchRow;
  hideEmpty?: boolean;
}) {
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
  if (!chips.length) {
    return hideEmpty ? null : <span className="mom-tag mom-tag--empty">—</span>;
  }
  return (
    <div className="wl-signal-chips">
      {chips.map((c) => (
        <span
          key={c.key}
          className={`result-tag ${c.className}`}
          title={c.title}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

function MiniQtr({ panel }: { panel: QuarterPanel }) {
  const labels = panel.labels.slice(-4);
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

function WatchlistRow({ r }: { r: WatchRow }) {
  const [open, setOpen] = useState(false);
  const qtr = useExpandQuarters(r.ticker, r.market, r.price, open);
  const brief = useExpandBrief(r.ticker, r.market, r.price, qtr, open);
  const tv = tradingviewUrl(r.ticker, r.market || "NSE");

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
        <td className="col-remove">
          <button
            type="button"
            className="wl-remove-chip"
            title={`Remove ${r.ticker}`}
            onClick={() => removeWatch(r.ticker)}
          >
            Remove
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="wl-expand-row">
          <td colSpan={6}>
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
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function WatchlistPanel() {
  const [tickers, setTickers] = useState<string[]>([]);
  const [rows, setRows] = useState<WatchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [addQ, setAddQ] = useState("");

  const refreshTickers = useCallback(() => {
    setTickers(listWatchedTickers());
  }, []);

  const loadRows = useCallback(async (list: string[]) => {
    if (!list.length) {
      setRows([]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const CHUNK = 40;
      const collected: WatchRow[] = [];
      for (let i = 0; i < list.length; i += CHUNK) {
        const chunk = list.slice(i, i + CHUNK);
        const res = await fetch(
          `/api/iq-master?tickers=${encodeURIComponent(chunk.join(","))}`,
        );
        const json = (await res.json()) as {
          ok?: boolean;
          rows?: WatchRow[];
          error?: string;
        };
        if (!res.ok || json.ok === false) {
          setError(json.error || "Failed to load watchlist");
          setRows([]);
          return;
        }
        collected.push(...(json.rows ?? []));
      }
      const byTicker = new Map(
        collected.map((r) => [r.ticker.toUpperCase(), r]),
      );
      setRows(
        list.map((t) => {
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
              has_bb_w: false,
              has_bb_m: false,
              has_tq: false,
              has_ema: false,
              has_ath: false,
              has_high52: false,
              has_mrsi: false,
              has_mrsi85: false,
              tq_score: null,
            }
          );
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refreshTickers();
    return subscribeWatchlist(refreshTickers);
  }, [refreshTickers]);

  useEffect(() => {
    void loadRows(tickers);
  }, [tickers, loadRows]);

  const needle = q.trim().toLowerCase();
  const visible = !needle
    ? rows
    : rows.filter(
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
            About + quarters. Unwatch with Remove.
          </p>
        </div>
        <span className="wl-simple-count" role="status">
          {error
            ? error
            : busy
              ? "Loading…"
              : tickers.length === 0
                ? "Empty"
                : `${visible.length} of ${tickers.length}`}
        </span>
      </header>

      <div className="wl-simple-toolbar">
        <div className="theme-stock-search theme-stock-search--inline wl-add-search">
          <TickerSuggest
            value={addQ}
            onChange={setAddQ}
            placeholder="Search ticker or company to add…"
            className="theme-stock-suggest-input"
            onSelect={(hit) => {
              addWatch(hit.ticker);
              setAddQ("");
            }}
            onSubmit={(t) => {
              const sym = t.trim().toUpperCase();
              if (!sym) return;
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
          disabled={!tickers.length}
        />
      </div>

      {tickers.length === 0 ? (
        <p className="miq-empty-hint">
          Click <strong>+ Watch</strong> next to any stock on Scan.
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
                <th className="col-remove" />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <WatchlistRow key={r.ticker} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
