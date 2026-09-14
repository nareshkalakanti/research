"use client";

import { useCallback, useEffect, useState, Fragment } from "react";
import {
  listWatchedTickers,
  removeWatch,
  subscribeWatchlist,
} from "@/lib/user-watchlist";
import {
  enqueueWatchlistAnalyze,
  enqueueWatchlistAnalyzeForce,
  getWatchAnalyzeStatus,
  subscribeWatchAnalyze,
  type WatchAnalyzeStatus,
} from "@/lib/watchlist-auto-analyze";
import { ExpandBusiness } from "@/components/ExpandBusiness";
import { ExpandExtraMetrics } from "@/components/ExpandExtraMetrics";
import { ExpandMetricsStrip } from "@/components/ExpandMetricsStrip";
import { ExpandQuarters } from "@/components/ExpandQuarters";
import {
  HighlightsBulletList,
  MetricSelectorBox,
} from "@/components/EarningsHighlightsCard";
import { tradingviewUrl } from "@/lib/links";
import { useExpandBrief } from "@/lib/use-expand-brief";
import { useExpandQuarters } from "@/lib/use-expand-quarters";
import type { IqMasterRow } from "@/lib/iq-master";

type ExpandPanel = "about" | "qtr" | "analyze";

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })} Cr`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtCallDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.slice(0, 10) + "T12:00:00");
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtDrift(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function govClass(signal: string | null | undefined): string {
  const s = (signal || "none").toLowerCase().replace(/\s+/g, "-");
  return `wl-gov wl-gov-${s}`;
}

function miqSentimentClass(sentiment: string): string {
  const s = sentiment.toLowerCase();
  if (s === "bullish") return "wl-miq-sent wl-miq-sent--pos";
  if (s === "bearish") return "wl-miq-sent wl-miq-sent--neg";
  return "wl-miq-sent wl-miq-sent--flat";
}

function DriftChip({ pct }: { pct: number | null | undefined }) {
  if (pct == null || !Number.isFinite(pct)) return null;
  return (
    <span
      className={`mom-tag ${
        pct > 0 ? "mom-tag--pos" : pct < 0 ? "mom-tag--neg" : "mom-tag--flat"
      }`}
    >
      {fmtDrift(pct)}
    </span>
  );
}

function WatchAnalyzeBadge({ ticker }: { ticker: string }) {
  const [st, setSt] = useState<WatchAnalyzeStatus | null>(() =>
    getWatchAnalyzeStatus(ticker),
  );
  useEffect(() => {
    setSt(getWatchAnalyzeStatus(ticker));
    return subscribeWatchAnalyze(() => setSt(getWatchAnalyzeStatus(ticker)));
  }, [ticker]);
  if (!st) return null;
  if (st.phase === "queued" || st.phase === "running") {
    return (
      <span className="wl-analyze-badge is-run" title={st.detail || st.label}>
        {st.phase === "queued" ? "Queued" : `Analyzing ${st.pct}%`}
      </span>
    );
  }
  if (st.phase === "error") {
    return (
      <span className="wl-analyze-badge is-err" title={st.error || st.detail || ""}>
        Analyze failed
      </span>
    );
  }
  return null;
}

function WatchlistExpand({
  row,
  panel,
  showMore,
  onPanel,
  onToggleMore,
}: {
  row: IqMasterRow;
  panel: ExpandPanel;
  showMore: boolean;
  onPanel: (p: ExpandPanel) => void;
  onToggleMore: () => void;
}) {
  const about = row.about?.trim() || "";
  const short = about.length > 320 && !showMore;
  const text = short ? `${about.slice(0, 320).trim()}…` : about;

  const [miqSummaryOpen, setMiqSummaryOpen] = useState(false);
  const [analyzeStatus, setAnalyzeStatus] = useState<WatchAnalyzeStatus | null>(
    () => getWatchAnalyzeStatus(row.ticker),
  );

  useEffect(() => {
    setAnalyzeStatus(getWatchAnalyzeStatus(row.ticker));
    return subscribeWatchAnalyze(() => {
      setAnalyzeStatus(getWatchAnalyzeStatus(row.ticker));
    });
  }, [row.ticker]);

  const quarterData = useExpandQuarters(
    row.ticker,
    row.market,
    row.price,
    true,
  );
  const briefData = useExpandBrief(
    row.ticker,
    row.market,
    row.price,
    quarterData,
    panel === "about",
  );

  const ceo = row.ceo?.trim() || "";
  const md = row.managing_director?.trim() || "";
  const leaderName = ceo || md;
  const leaderLabel = ceo ? "CEO" : "MD";

  const scanBusy =
    analyzeStatus?.phase === "queued" || analyzeStatus?.phase === "running";
  const scanDone = analyzeStatus?.phase === "done";
  const scanErr = analyzeStatus?.phase === "error" ? analyzeStatus.error : null;
  const scanPct = analyzeStatus?.pct ?? 0;
  const scanStatus = analyzeStatus?.label ?? null;
  const scanDetail = analyzeStatus?.detail ?? null;

  const miqSummary = row.marketiq?.summary?.trim() || "";
  const miqSummaryLong = miqSummary.length > 160;
  const miqSummaryBody =
    miqSummaryOpen || !miqSummaryLong
      ? miqSummary
      : `${miqSummary.slice(0, 160).trim()}…`;

  return (
    <div className="about-box">
      <ExpandMetricsStrip
        forwardPe={quarterData.forward_pe}
        epsYoY={quarterData.yoy?.eps_yoy}
        loading={quarterData.loading}
        empty={
          !quarterData.loading &&
          !quarterData.error &&
          !quarterData.panel &&
          quarterData.forward_pe == null &&
          quarterData.yoy?.eps_yoy == null
        }
      />
      <ExpandExtraMetrics extras={quarterData.extras} />
      <div className="about-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={panel === "about"}
          className={`about-tab ${panel === "about" ? "on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onPanel("about");
          }}
        >
          About
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={panel === "qtr"}
          className={`about-tab ${panel === "qtr" ? "on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onPanel("qtr");
          }}
        >
          Qtr
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={panel === "analyze"}
          className={`about-tab ${panel === "analyze" ? "on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onPanel("analyze");
          }}
        >
          Analyze
        </button>
      </div>

      {panel === "qtr" ? (
        <ExpandQuarters data={quarterData} price={row.price} />
      ) : panel === "analyze" ? (
        <div className="wl-analyze">
          <div className="wl-analyze-actions">
            <button
              type="button"
              className="token-studio-apply"
              disabled={scanBusy}
              onClick={(e) => {
                e.stopPropagation();
                enqueueWatchlistAnalyzeForce(row.ticker, {
                  hasMarketIq: Boolean(row.marketiq),
                  market: row.market,
                  price: row.price,
                });
              }}
            >
              {scanBusy ? "Running…" : "Get data"}
            </button>
            <span className="hint tight">
              Auto-runs when added to watchlist. Get data re-runs MarketIQ +
              Concall.
            </span>
          </div>

          {scanBusy || scanStatus || scanErr ? (
            <div
              className={`fill-progress wl-analyze-progress ${
                scanErr ? "is-error" : ""
              } ${scanDone && !scanErr ? "is-done" : ""}`}
              role="status"
              aria-live="polite"
            >
              <div className="fill-progress-meta">
                <span className="fill-progress-label">
                  {scanErr ? "Failed" : scanStatus || "Working…"}
                </span>
                <span className="fill-progress-pct">{scanPct}%</span>
              </div>
              <div className="fill-progress-track">
                <div
                  className={`fill-progress-bar${scanBusy && !scanDone ? " wl-analyze-bar-pulse" : ""}`}
                  style={{ width: `${scanPct}%` }}
                />
              </div>
              <p className="fill-progress-detail">
                {scanErr || scanDetail || "…"}
              </p>
            </div>
          ) : null}

          <div className="wl-analyze-snapshot">
            <div className="about-label">MarketIQ</div>
            {row.marketiq ? (
              <>
                <div className="miq-headline">{row.marketiq.headline}</div>
                <div className="wl-miq-meta">
                  <span className={miqSentimentClass(row.marketiq.sentiment)}>
                    {row.marketiq.sentiment}
                  </span>
                  {row.marketiq.impact != null ? (
                    <span className="wl-miq-impact">
                      impact {row.marketiq.impact}
                    </span>
                  ) : null}
                  {row.marketiq.category ? (
                    <span className="wl-miq-cat">{row.marketiq.category}</span>
                  ) : null}
                </div>
                {miqSummary ? (
                  <>
                    <p className="wl-analyze-summary">{miqSummaryBody}</p>
                    {miqSummaryLong ? (
                      <button
                        type="button"
                        className="miq-readmore"
                        onClick={() => setMiqSummaryOpen((v) => !v)}
                      >
                        {miqSummaryOpen ? "Read less" : "Read more"}
                      </button>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : (
              <p className="wl-empty-hint">
                No analysed filing yet — auto-analyze runs in the background.
              </p>
            )}
          </div>

          <div className="wl-analyze-snapshot">
            <div className="about-label">Concall</div>
            {row.concall ? (
              <div className="wl-concall wl-concall--pass">
                <div className="wl-concall-meta">
                  {row.concall.period || "—"}
                  {row.concall.call_date
                    ? ` · ${fmtCallDate(row.concall.call_date)}`
                    : ""}
                </div>
                <div className="wl-concall-pass-row">
                  <div className="wl-concall-hl">
                    <HighlightsBulletList
                      items={row.concall.highlights}
                      max={3}
                    />
                  </div>
                  <div className="wl-concall-metrics">
                    <MetricSelectorBox
                      label="Result quality"
                      value={row.concall.result_quality}
                      kind="quality"
                      showLabel={false}
                    />
                    <div className="wl-concall-tone">
                      <MetricSelectorBox
                        label="Tone"
                        value={row.concall.mgmt_sentiment}
                        kind="sentiment"
                        showLabel={false}
                      />
                      {row.concall.revenue_cr != null ? (
                        <span className="wl-concall-rev">
                          {fmtCr(row.concall.revenue_cr)}
                        </span>
                      ) : null}
                    </div>
                    <span className="wl-concall-ltp">
                      {fmtPrice(row.concall.ltp)}
                    </span>
                    <DriftChip pct={row.concall.drift_pct} />
                  </div>
                </div>
              </div>
            ) : (
              <p className="wl-empty-hint">
                No PASS yet — background analyze discovers transcript/PPT.
              </p>
            )}
          </div>
        </div>
      ) : (
        <>
          {row.headquarters ? (
            <div className="about-meta">
              <span className="about-meta-label">Location</span>
              <span>{row.headquarters}</span>
            </div>
          ) : null}
          {leaderName || row.founded_year ? (
            <div className="about-meta">
              {leaderName ? (
                <>
                  <span className="about-meta-label">{leaderLabel}</span>
                  <span>{leaderName}</span>
                </>
              ) : null}
              {row.founded_year ? (
                <>
                  <span className="about-meta-label">Founded</span>
                  <span>{row.founded_year}</span>
                </>
              ) : null}
            </div>
          ) : null}
          {text ? (
            <>
              <div className="about-label">About</div>
              <p>{text}</p>
            </>
          ) : !briefData.brief && !briefData.loading ? (
            <p>No about text available.</p>
          ) : null}
          {about.length > 320 ? (
            <button
              type="button"
              className="show-more"
              onClick={(e) => {
                e.stopPropagation();
                onToggleMore();
              }}
            >
              {showMore ? "Show less" : "Show more"}
            </button>
          ) : null}
          <ExpandBusiness data={briefData} />
        </>
      )}
    </div>
  );
}

export function WatchlistPanel() {
  const [tickers, setTickers] = useState<string[]>([]);
  const [rows, setRows] = useState<IqMasterRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [panel, setPanel] = useState<ExpandPanel>("about");
  const [showMore, setShowMore] = useState(false);
  const backfillTried = useState(() => new Set<string>())[0];
  const analyzePhases = useState(() => new Map<string, string>())[0];

  const refreshTickers = useCallback(() => {
    setTickers(listWatchedTickers());
  }, []);

  const loadRows = useCallback(async (list: string[]) => {
    if (!list.length) {
      setRows([]);
      setExpanded(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/iq-master?tickers=${encodeURIComponent(list.join(","))}`,
      );
      const json = (await res.json()) as {
        ok?: boolean;
        rows?: IqMasterRow[];
        error?: string;
      };
      if (!res.ok || json.ok === false) {
        setError(json.error || "Failed to load watchlist");
        setRows([]);
        return;
      }
      setRows(json.rows ?? []);
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

  // Refresh rows only when a background analyze finishes (not every progress tick)
  useEffect(() => {
    return subscribeWatchAnalyze(() => {
      for (const t of listWatchedTickers()) {
        const s = getWatchAnalyzeStatus(t);
        if (!s) continue;
        const prev = analyzePhases.get(t);
        if (
          (s.phase === "done" || s.phase === "error") &&
          prev !== s.phase
        ) {
          analyzePhases.set(t, s.phase);
          void loadRows(listWatchedTickers());
          return;
        }
        analyzePhases.set(t, s.phase);
      }
    });
  }, [loadRows, analyzePhases]);

  // Backfill: enqueue missing MarketIQ/Concall once per ticker per session
  useEffect(() => {
    if (!rows.length) return;
    for (const r of rows) {
      if (backfillTried.has(r.ticker)) continue;
      const st = getWatchAnalyzeStatus(r.ticker);
      if (st?.phase === "queued" || st?.phase === "running") {
        backfillTried.add(r.ticker);
        continue;
      }
      if (r.marketiq && r.concall) {
        backfillTried.add(r.ticker);
        continue;
      }
      backfillTried.add(r.ticker);
      enqueueWatchlistAnalyze(r.ticker, {
        hasMarketIq: Boolean(r.marketiq),
        market: r.market,
        price: r.price,
      });
    }
  }, [rows, backfillTried]);

  useEffect(() => {
    setPanel("about");
    setShowMore(false);
  }, [expanded]);

  const needle = q.trim().toLowerCase();
  const visible = !needle
    ? rows
    : rows.filter(
        (r) =>
          r.ticker.toLowerCase().includes(needle) ||
          r.company.toLowerCase().includes(needle) ||
          (r.sector || "").toLowerCase().includes(needle),
      );

  function toggleOpen(ticker: string) {
    setExpanded((prev) => (prev === ticker ? null : ticker));
  }

  return (
    <section className="miq panel wl-panel">
      <header className="miq-head">
        <div>
          <h1 className="miq-title">Watchlist</h1>
          <p className="miq-sub">
            Add a stock anywhere → background MarketIQ + Concall analyze. Expand
            a row for About / Qtr / Analyze progress.
          </p>
        </div>
      </header>

      <div className="miq-toolbar">
        <input
          className="miq-search"
          type="search"
          placeholder="Filter ticker or company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={!tickers.length}
        />
        <span className="miq-live" role="status">
          {error
            ? error
            : busy
              ? "Loading…"
              : tickers.length === 0
                ? "Empty"
                : `${visible.length} of ${tickers.length}`}
        </span>
      </div>

      {tickers.length === 0 ? (
        <p className="miq-empty-hint">
          Click <strong>+ Watch</strong> next to any stock — MarketIQ and
          Concall analyze start in the background.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="miq-table wl-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Price</th>
                <th>MCap</th>
                <th>MarketIQ</th>
                <th>Gov</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const open = expanded === r.ticker;
                const tv = tradingviewUrl(r.ticker, r.market || "NSE");
                return (
                  <Fragment key={r.ticker}>
                    <tr
                      className={`wl-row${open ? " row-open" : ""}`}
                      aria-expanded={open}
                      onClick={() => toggleOpen(r.ticker)}
                    >
                      <td className="miq-td-co">
                        <div className="company-watch-cell">
                          <span className="watch-btn is-on" aria-hidden>
                            <span className="watch-btn-mark">★</span>
                            Saved
                          </span>
                          <span className="miq-co-name wl-open-btn">
                            {r.company}
                            <span className="wl-open-caret" aria-hidden>
                              {open ? "▾" : "▸"}
                            </span>
                          </span>
                          <WatchAnalyzeBadge ticker={r.ticker} />
                        </div>
                        <div className="miq-co-meta">
                          <span>{r.ticker}</span>
                          {r.sector ? (
                            <>
                              <span className="miq-dot">·</span>
                              <span>{r.sector}</span>
                            </>
                          ) : null}
                          <span className="miq-dot">·</span>
                          <a
                            className="wl-tv-link"
                            href={tv}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            TV
                          </a>
                        </div>
                      </td>
                      <td className="wl-num">{fmtPrice(r.price)}</td>
                      <td className="wl-num">{fmtCr(r.market_cap_cr)}</td>
                      <td className="miq-td-details wl-miq-cell">
                        {r.marketiq ? (
                          <>
                            <div className="miq-headline">
                              {r.marketiq.headline}
                            </div>
                            <div className="wl-miq-meta">
                              <span
                                className={miqSentimentClass(
                                  r.marketiq.sentiment,
                                )}
                              >
                                {r.marketiq.sentiment}
                              </span>
                              {r.marketiq.impact != null ? (
                                <span className="wl-miq-impact">
                                  impact {r.marketiq.impact}
                                </span>
                              ) : null}
                              {r.marketiq.category ? (
                                <span className="wl-miq-cat">
                                  {r.marketiq.category}
                                </span>
                              ) : null}
                            </div>
                          </>
                        ) : (
                          <span className="wl-empty-hint">
                            Background analyze…
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={govClass(r.governance.signal)}>
                          {r.governance.signal || "—"}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="clear-filter"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (expanded === r.ticker) setExpanded(null);
                            removeWatch(r.ticker);
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                    {open ? (
                      <tr
                        className="about-row"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <td colSpan={6}>
                          <WatchlistExpand
                            row={r}
                            panel={panel}
                            showMore={showMore}
                            onPanel={setPanel}
                            onToggleMore={() => setShowMore((v) => !v)}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
