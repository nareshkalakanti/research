"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tradingviewUrl } from "@/lib/links";

export type DashSourceEntry = {
  ticker: string;
  sources: string[];
};

type IqDashRow = {
  ticker: string;
  company: string;
  market: string | null;
  price: number | null;
  market_cap_cr: number | null;
  sector: string | null;
  has_bb_w?: boolean;
  has_tq?: boolean;
  tq_score?: number | null;
};

type SevenRuleDash = {
  score: number | null;
  passed: number | null;
  rating: string | null;
  rating_label: string | null;
  provisional: boolean | null;
  pass: boolean;
};

function sevenRuleRatingClass(rating: string | null | undefined): string {
  if (rating === "strong_buy" || rating === "buy") return "seven-rule-rating--buy";
  if (rating === "deep_dive") return "seven-rule-rating--hold";
  if (rating === "no") return "seven-rule-rating--sell";
  return "seven-rule-rating--hold";
}

type DashRow = IqDashRow & {
  sources: string[];
  crossed_200dma: boolean;
  seven_rule: SevenRuleDash | null;
};

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })} Cr`;
}

function sourceChipClass(label: string): string {
  const key = label.trim().toLowerCase();
  if (key === "holdings") return "tag-hold";
  if (key === "watchlist" || key === "watch") return "tag-watch";
  return "tag-named";
}

async function loadIqRows(syms: string[]): Promise<IqDashRow[]> {
  const CHUNK = 40;
  const collected: IqDashRow[] = [];
  for (let i = 0; i < syms.length; i += CHUNK) {
    const chunk = syms.slice(i, i + CHUNK);
    const res = await fetch(
      `/api/iq-master?tickers=${encodeURIComponent(chunk.join(","))}`,
    );
    const json = (await res.json()) as { ok?: boolean; rows?: IqDashRow[] };
    collected.push(...(json.rows ?? []));
  }
  const byTicker = new Map(collected.map((r) => [r.ticker.toUpperCase(), r]));
  return syms.map((t) => {
    const hit = byTicker.get(t.toUpperCase());
    return (
      hit ?? {
        ticker: t,
        company: t,
        market: null,
        price: null,
        market_cap_cr: null,
        sector: null,
        has_bb_w: false,
        has_tq: false,
        tq_score: null,
      }
    );
  });
}

async function loadCrossed200Dma(
  rows: IqDashRow[],
): Promise<Map<string, { crossed: boolean; price: number | null }>> {
  const hits = new Map<string, { crossed: boolean; price: number | null }>();
  const CHUNK = 8;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (row) => {
        const key = row.ticker.toUpperCase();
        try {
          const q = new URLSearchParams({ ticker: row.ticker });
          if (row.market) q.set("market", row.market);
          const res = await fetch(`/api/quote-tape?${q}`, {
            signal: AbortSignal.timeout(30_000),
          });
          const json = (await res.json()) as {
            ok?: boolean;
            tape?: {
              price: number | null;
              crossed_above_200dma?: boolean;
            };
          };
          if (!json.ok || !json.tape) {
            hits.set(key, { crossed: false, price: null });
            return;
          }
          hits.set(key, {
            crossed: !!json.tape.crossed_above_200dma,
            price: json.tape.price ?? null,
          });
        } catch {
          hits.set(key, { crossed: false, price: null });
        }
      }),
    );
  }
  return hits;
}

function hasAnySignal(r: DashRow): boolean {
  return (
    r.crossed_200dma ||
    !!r.has_bb_w ||
    !!r.has_tq ||
    !!r.seven_rule?.pass
  );
}

function bySignalThenMcap(a: DashRow, b: DashRow): number {
  const score = (r: DashRow) =>
    (r.crossed_200dma ? 8 : 0) +
    (r.has_bb_w ? 4 : 0) +
    (r.has_tq ? 2 : 0) +
    (r.seven_rule?.pass ? 1 : 0);
  const ds = score(b) - score(a);
  if (ds) return ds;
  const as = a.seven_rule?.score ?? -1;
  const bs = b.seven_rule?.score ?? -1;
  if (bs !== as) return bs - as;
  const am = a.market_cap_cr ?? -1;
  const bm = b.market_cap_cr ?? -1;
  if (bm !== am) return bm - am;
  return a.ticker.localeCompare(b.ticker);
}

async function loadSevenRuleScores(
  syms: string[],
): Promise<Map<string, SevenRuleDash>> {
  const out = new Map<string, SevenRuleDash>();
  if (!syms.length) return out;
  const CHUNK = 80;
  for (let i = 0; i < syms.length; i += CHUNK) {
    const chunk = syms.slice(i, i + CHUNK);
    const res = await fetch(
      `/api/seven-rule-fill?scores=1&tickers=${encodeURIComponent(chunk.join(","))}`,
      { cache: "no-store" },
    );
    const json = (await res.json()) as {
      ok?: boolean;
      rows?: Array<{
        ticker: string;
        score: number | null;
        passed: number | null;
        rating: string | null;
        rating_label: string | null;
        provisional: boolean | null;
        pass: boolean;
      }>;
    };
    for (const r of json.rows ?? []) {
      out.set(r.ticker.toUpperCase(), {
        score: r.score,
        passed: r.passed,
        rating: r.rating,
        rating_label: r.rating_label,
        provisional: r.provisional,
        pass: !!r.pass,
      });
    }
  }
  return out;
}

/**
 * Cap slow ROE/ROCE fill so Scan signals never hangs.
 * Full coverage stays on Scan → Fill 7-Rule.
 */
async function fillSevenRuleForTickers(
  syms: string[],
  onStatus: (line: string) => void,
  opts?: { maxRounds?: number; limit?: number; signal?: { cancelled: boolean } },
): Promise<{ saved: number; remaining: number }> {
  if (!syms.length) return { saved: 0, remaining: 0 };
  const maxRounds = Math.max(1, opts?.maxRounds ?? 4);
  const limit = Math.max(1, opts?.limit ?? 2);
  let remaining = 1;
  let saved = 0;
  let failed = 0;
  for (let round = 1; round <= maxRounds; round += 1) {
    if (opts?.signal?.cancelled) break;
    onStatus(
      `7-Rule background · +${saved} · ${remaining.toLocaleString()} left…`,
    );
    const res = await fetch("/api/seven-rule-fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        market: "All",
        tickers: syms,
        limit,
      }),
      cache: "no-store",
    });
    const json = (await res.json()) as {
      ok?: boolean;
      tried?: number;
      saved?: number;
      failed?: number;
      remaining?: number;
      paused?: boolean;
      paused_until?: string | null;
      error?: string;
      message?: string;
    };
    if (!res.ok || json.ok === false) {
      throw new Error(json.error || json.message || "7-Rule fill failed");
    }
    saved += json.saved ?? 0;
    failed += json.failed ?? 0;
    remaining = json.remaining ?? 0;
    if (json.paused) {
      onStatus(
        `7-Rule paused until ${json.paused_until || "?"} · +${saved}`,
      );
      break;
    }
    if ((json.tried ?? 0) === 0 || remaining <= 0) break;
    if ((json.saved ?? 0) === 0 && (json.failed ?? 0) > 0) break;
    if (round < maxRounds) {
      await new Promise((r) => setTimeout(r, 4_000 + Math.random() * 3_000));
    }
  }
  onStatus(
    remaining <= 0
      ? `7-Rule catch-up done · +${saved}`
      : `7-Rule catch-up +${saved} · ${remaining} left (use Scan → Fill 7-Rule for the rest)`,
  );
  return { saved, remaining };
}

export function WatchlistDashboard({
  entries,
}: {
  /** Holdings + named-list universe with source labels. */
  entries: DashSourceEntry[];
}) {
  const [rows, setRows] = useState<DashRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bgFill = useRef<{ cancelled: boolean } | null>(null);
  /** Full list after DMA (pre-filter) so late 7-Rule passes can appear. */
  const allDashRows = useRef<DashRow[]>([]);

  const tickers = useMemo(
    () => entries.map((e) => e.ticker.trim().toUpperCase()).filter(Boolean),
    [entries],
  );
  const sourcesByTicker = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of entries) {
      m.set(e.ticker.trim().toUpperCase(), e.sources);
    }
    return m;
  }, [entries]);

  const applySevenRuleScores = useCallback(async (syms: string[]) => {
    const rule7 = await loadSevenRuleScores(syms);
    const base = allDashRows.current;
    if (!base.length) return;
    const merged = base
      .map((r) => ({
        ...r,
        seven_rule: rule7.get(r.ticker.toUpperCase()) ?? r.seven_rule,
      }))
      .filter(hasAnySignal)
      .sort(bySignalThenMcap);
    setRows(merged);
  }, []);

  const loadAll = useCallback(async () => {
    const syms = tickers;
    setError(null);
    if (!syms.length) {
      setRows([]);
      return;
    }
    // Cancel any prior background 7-Rule catch-up.
    if (bgFill.current) bgFill.current.cancelled = true;
    const fillCtl = { cancelled: false };
    bgFill.current = fillCtl;

    setBusy(true);
    setStatus("Loading BB W / TQ W…");
    try {
      const loaded = await loadIqRows(syms);
      setStatus("Checking 200 DMA crosses…");
      const dmaHits = await loadCrossed200Dma(loaded);
      setStatus("Scoring 7-Rule (cache)…");
      const rule7 = await loadSevenRuleScores(syms);
      const built: DashRow[] = loaded.map((r) => {
        const t = r.ticker.toUpperCase();
        const dma = dmaHits.get(t);
        return {
          ...r,
          ticker: t,
          price: dma?.price ?? r.price,
          sources: sourcesByTicker.get(t) ?? [],
          crossed_200dma: !!dma?.crossed,
          seven_rule: rule7.get(t) ?? null,
        };
      });
      allDashRows.current = built;
      const next = built.filter(hasAnySignal).sort(bySignalThenMcap);
      setRows(next);
      setBusy(false);
      setStatus(null);

      // After TQ / MA / BB: short background catch-up only (does not block table).
      const hitSyms = next.map((r) => r.ticker);
      const fillPool = hitSyms.length ? hitSyms : syms.slice(0, 40);
      void (async () => {
        try {
          const result = await fillSevenRuleForTickers(fillPool, setStatus, {
            maxRounds: 4,
            limit: 2,
            signal: fillCtl,
          });
          if (fillCtl.cancelled) return;
          if (result.saved > 0) await applySevenRuleScores(syms);
          if (!fillCtl.cancelled && result.remaining <= 0) {
            setTimeout(() => setStatus(null), 2500);
          }
        } catch (e) {
          if (fillCtl.cancelled) return;
          setStatus(
            e instanceof Error
              ? `7-Rule: ${e.message}`
              : "7-Rule catch-up failed",
          );
        }
      })();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setBusy(false);
    }
  }, [tickers, sourcesByTicker, applySevenRuleScores]);

  const entriesKey = useMemo(
    () =>
      entries
        .map((e) => `${e.ticker}:${e.sources.join(",")}`)
        .join("|"),
    [entries],
  );

  useEffect(() => {
    if (bgFill.current) bgFill.current.cancelled = true;
    allDashRows.current = [];
    setRows([]);
    setStatus(null);
    setError(null);
  }, [entriesKey]);

  const counts = useMemo(() => {
    let dma = 0;
    let bbw = 0;
    let tq = 0;
    let rule7 = 0;
    for (const r of rows) {
      if (r.crossed_200dma) dma += 1;
      if (r.has_bb_w) bbw += 1;
      if (r.has_tq) tq += 1;
      if (r.seven_rule?.pass) rule7 += 1;
    }
    return { dma, bbw, tq, rule7 };
  }, [rows]);

  return (
    <div className="wl-dash">
      <div className="wl-simple-toolbar">
        <button
          type="button"
          className={`chip chip-scan tag-chip${busy ? " busy on" : ""}`}
          disabled={busy || !tickers.length}
          onClick={() => void loadAll()}
          title="Scan 200 DMA ↑, BB W, TQ W (fast), then a short background 7-Rule catch-up. Full ROE/ROCE fill: Scan → Fill 7-Rule."
        >
          {busy ? "Checking…" : "Scan signals"}
          <span className="chip-count">{rows.length}</span>
        </button>
      </div>
      {status ? (
        <p className="hint tight" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="hint tight" role="alert">
          {error}
        </p>
      ) : null}
      <p className="wl-dash-summary">
        {tickers.length} names · {counts.dma} × 200 DMA · {counts.bbw} × BB W ·{" "}
        {counts.tq} × TQ W · {counts.rule7} × 7-Rule
      </p>
      <section className="wl-dash-section">
        <header className="wl-dash-section-head">
          <h2>Signals</h2>
          <span>{rows.length}</span>
        </header>
        {rows.length === 0 ? (
          <p className="miq-empty-hint">
            No 200 DMA ↑, BB W, TQ W, or 7-Rule hits on these lists yet. Run
            Scan signals.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table wl-simple-table wl-dash-table">
              <thead>
                <tr>
                  <th className="col-name">Company</th>
                  <th className="col-sec">Sec</th>
                  <th className="num col-mcap_cr">MCap</th>
                  <th className="num col-price">Price</th>
                  <th className="col-signal">Signals</th>
                  <th
                    className="col-seven-rating"
                    title="7-Rule: Strong Buy (7/7), Buy (6), Deep Dive (5), No (&lt;5)"
                  >
                    7R
                  </th>
                  <th className="col-from">From</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const tv = tradingviewUrl(r.ticker, r.market);
                  const sr = r.seven_rule;
                  return (
                    <tr key={r.ticker}>
                      <td className="col-name">
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
                          </span>
                        </div>
                      </td>
                      <td className="col-sec">{r.sector || "—"}</td>
                      <td className="num col-mcap_cr">
                        {fmtCr(r.market_cap_cr)}
                      </td>
                      <td className="num col-price">{fmtPrice(r.price)}</td>
                      <td className="col-signal">
                        <span className="result-tags wl-dash-signal-tags">
                          {r.crossed_200dma ? (
                            <span
                              className="result-tag tag-dash-dma200"
                              title="Last close moved above 200 DMA (prior close was below)"
                            >
                              200 DMA ↑
                            </span>
                          ) : null}
                          {r.has_bb_w ? (
                            <span
                              className="result-tag tag-dash-bbw"
                              title="BB NEW weekly"
                            >
                              BB W
                            </span>
                          ) : null}
                          {r.has_tq ? (
                            <span
                              className="result-tag tag-dash-tq"
                              title="TQ weekly crossover"
                            >
                              {r.tq_score != null
                                ? `TQ W ${Math.round(r.tq_score)}`
                                : "TQ W"}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="col-seven-rating">
                        {sr?.rating_label ? (
                          <span
                            className={`seven-rule-rating ${sevenRuleRatingClass(sr.rating)}`}
                            title={
                              sr.provisional
                                ? `${sr.passed}/7 · score ${sr.score?.toFixed(2) ?? "—"} · incomplete inputs`
                                : `${sr.passed}/7 · score ${sr.score?.toFixed(2) ?? "—"}`
                            }
                          >
                            {sr.rating_label}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="col-from">
                        <span className="result-tags wl-dash-from-tags">
                          {r.sources.length ? (
                            r.sources.map((s) => (
                              <span
                                key={`${r.ticker}|${s}`}
                                className={`result-tag ${sourceChipClass(s)}`}
                              >
                                {s}
                              </span>
                            ))
                          ) : (
                            <span className="result-tag">—</span>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
