"use client";

import { Loading } from "@/components/Loading";
import { useEffect, useState } from "react";
import type { QuoteTape } from "@/lib/quote-tape";

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

type MaPeriod = 20 | 50 | 100 | 200;

/**
 * Napkin Snapshot fundamentals (decimal ratios, e.g. 0.147 = 14.7%).
 * Prefer over Yahoo price CAGR when set.
 */
export type QuoteTapeFundamentals = {
  revenue_cagr_5y?: number | null;
  eps_cagr_5y?: number | null;
  revenue_cagr_3y?: number | null;
  eps_cagr_3y?: number | null;
  revenue_cagr_2y?: number | null;
  eps_cagr_2y?: number | null;
};

type CagrYears = 5 | 3 | 2;
const CAGR_YEARS: CagrYears[] = [5, 3, 2];

function fundAt(f: QuoteTapeFundamentals | null, y: CagrYears) {
  if (!f) return { rev: null, eps: null };
  const rev =
    y === 5 ? f.revenue_cagr_5y : y === 3 ? f.revenue_cagr_3y : f.revenue_cagr_2y;
  const eps = y === 5 ? f.eps_cagr_5y : y === 3 ? f.eps_cagr_3y : f.eps_cagr_2y;
  return { rev: rev ?? null, eps: eps ?? null };
}

type Props = {
  ticker: string;
  market?: string | null;
  /** When false, skip network (e.g. collapsed row). Default true. */
  active?: boolean;
  title?: string;
  className?: string;
  /** SMA periods to show (default 20/50/100/200). */
  periods?: MaPeriod[];
  /** full = Tech & Val; range = 52-week + DMAs only (detail side card). */
  variant?: "full" | "range";
  /** When present, show Revenue/EPS 5Y CAGR (Snapshot) instead of price CAGR. */
  fundamentals?: QuoteTapeFundamentals | null;
  /** Parent renders its own section heading (e.g. Napkin). */
  hideTitle?: boolean;
  /** Drop the Val row (Price · PE · Rev/EPS CAGR) — technicals only. */
  hideVal?: boolean;
};

/** Format napkin ratio (0.147 → +14.7%). */
function fmtFundCagr(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const pct = v * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/**
 * Tech & Val card: price / PE / CAGR, SMA 20/50/100/200, 52-week range.
 */
export function QuoteTapeCard({
  ticker,
  market = null,
  active = true,
  title = "Tech & Val",
  className,
  periods,
  variant = "full",
  fundamentals = null,
  hideTitle = false,
  hideVal = false,
}: Props) {
  const [tape, setTape] = useState<QuoteTape | null>(null);
  const [loading, setLoading] = useState(false);
  /** Chosen CAGR window; null = longest one with data (5Y → 3Y → 2Y). */
  const [cagrPick, setCagrPick] = useState<CagrYears | null>(null);

  useEffect(() => {
    if (!active || !ticker.trim()) {
      setTape(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const q = new URLSearchParams({ ticker: ticker.trim().toUpperCase() });
    if (market) q.set("market", market);
    void fetch(`/api/quote-tape?${q}`, { signal: AbortSignal.timeout(60_000) })
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
  }, [ticker, market, active]);

  const rootClass = ["wl-card-qtr", "wl-card-price", "quote-tape-card", className]
    .filter(Boolean)
    .join(" ");

  if (!active) return null;
  if (loading && !tape) {
    return (
      <section className={rootClass}>
        {hideTitle ? null : <h3>{title}</h3>}
        <Loading variant="inline" />
      </section>
    );
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
  const cagrAvail = CAGR_YEARS.filter((y) => {
    const f = fundAt(fundamentals, y);
    return f.rev != null || f.eps != null;
  });
  // Default: longest window with EPS (the headline number), e.g. ALICON has
  // Rev 5Y but no EPS 5Y → open on 3Y. Fall back to any window with data.
  const cagrAuto =
    cagrAvail.find((y) => fundAt(fundamentals, y).eps != null) ??
    cagrAvail[0] ??
    null;
  const cagrYears: CagrYears | null =
    cagrPick != null && cagrAvail.includes(cagrPick) ? cagrPick : cagrAuto;
  const useFundCagr = cagrYears != null;
  const { rev: rev5, eps: eps5 } = cagrYears
    ? fundAt(fundamentals, cagrYears)
    : { rev: null, eps: null };
  const priceCagrCls =
    tape.cagr_pct == null
      ? undefined
      : tape.cagr_pct >= 0
        ? "q-up"
        : "q-down";
  const revCls =
    rev5 == null ? undefined : rev5 >= 0 ? "q-up" : "q-down";
  const epsCls =
    eps5 == null ? undefined : eps5 >= 0 ? "q-up" : "q-down";
  const dma200Label =
    tape.dma200_alert === "below_200_breakout"
      ? "Below 200 DMA · Fresh breakout"
      : null;
  const want = periods?.length ? new Set(periods) : null;
  const mas = want
    ? tape.mas.filter((m) => want.has(m.period as MaPeriod))
    : tape.mas;

  const rangeOnly = variant === "range";
  const heading = rangeOnly ? "52-week range" : title;

  return (
    <section className={rootClass}>
      {hideTitle ? null : <h3>{heading}</h3>}
      <div className="wl-tape">
        {!rangeOnly && !hideVal ? (
          <div className="wl-tape-stats">
            <span className="wl-tape-stat">
              <span className="wl-tape-stat-label">Price</span>{" "}
              <strong>{fmtPrice(tape.price)}</strong>
            </span>
            <span className="wl-tape-stat">
              <span className="wl-tape-stat-label">PE</span>{" "}
              <strong>{tape.pe != null ? tape.pe.toFixed(2) : "—"}</strong>
            </span>
            {useFundCagr ? (
              <>
                <span
                  className="wl-tape-stat"
                  title={`Revenue CAGR over ${cagrYears} years (annual P&L)`}
                >
                  <span className="wl-tape-stat-label">Rev {cagrYears}Y</span>{" "}
                  <strong className={revCls}>{fmtFundCagr(rev5)}</strong>
                </span>
                <span
                  className="wl-tape-stat"
                  title={`EPS CAGR over ${cagrYears} years (annual P&L)`}
                >
                  <span className="wl-tape-stat-label">EPS {cagrYears}Y</span>{" "}
                  <strong className={epsCls}>{fmtFundCagr(eps5)}</strong>
                </span>
                {cagrAvail.length > 1 ? (
                  <span className="tape-cagr-pick" role="group" aria-label="CAGR period">
                    {CAGR_YEARS.map((y) => (
                      <button
                        key={y}
                        type="button"
                        className={y === cagrYears ? "on" : undefined}
                        disabled={!cagrAvail.includes(y)}
                        title={
                          cagrAvail.includes(y)
                            ? `Show ${y}-year CAGR`
                            : `No ${y}-year history`
                        }
                        onClick={() => setCagrPick(y)}
                      >
                        {y}Y
                      </button>
                    ))}
                  </span>
                ) : null}
              </>
            ) : (
              <span
                className="wl-tape-stat"
                title="Stock price CAGR from Yahoo history — not revenue/EPS CAGR"
              >
                <span className="wl-tape-stat-label">
                  {tape.cagr_years
                    ? `${tape.cagr_years}Y price CAGR`
                    : "Price CAGR"}
                </span>{" "}
                <strong className={priceCagrCls}>
                  {tape.cagr_pct == null
                    ? "—"
                    : `${tape.cagr_pct >= 0 ? "+" : ""}${tape.cagr_pct.toFixed(1)}%`}
                </strong>
              </span>
            )}
          </div>
        ) : null}
        {low != null && high != null ? (
          <div className="wl-tape-range">
            {!rangeOnly ? (
              <span className="wl-tape-label">52-week range</span>
            ) : null}
            <div className="wl-range-track">
              <span className="wl-range-lo">{fmtPrice(low)}</span>
              <span className="wl-range-bar">
                {pct != null ? (
                  <i className="wl-range-dot" style={{ left: `${pct}%` }} />
                ) : null}
              </span>
              <span className="wl-range-hi">{fmtPrice(high)}</span>
            </div>
            {rangeOnly && px != null ? (
              <p className="wl-range-px">
                <strong>{fmtPrice(px)}</strong>
                {pct != null ? (
                  <span className="muted"> · {pct.toFixed(0)}% of range</span>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="wl-tape-mas">
          {!rangeOnly ? (
            <span className="wl-tape-label">Moving averages</span>
          ) : null}
          <div className="wl-ma-row">
            {mas.map((m) => {
              const tone =
                m.above === true
                  ? "above"
                  : m.above === false
                    ? "below"
                    : "flat";
              const mark =
                m.above === true ? "✓" : m.above === false ? "✗" : "·";
              return (
                <span
                  key={m.period}
                  className={`wl-ma-item wl-ma-item--${tone}`}
                  title={
                    m.above === true
                      ? "Price above SMA"
                      : m.above === false
                        ? "Price below SMA"
                        : undefined
                  }
                >
                  <span className="wl-ma-mark" aria-hidden>
                    {mark}
                  </span>
                  <span className="wl-ma-period">
                    {rangeOnly ? `${m.period} DMA` : m.period}
                  </span>
                  {!rangeOnly ? (
                    <span className="wl-ma-val">
                      {m.value != null
                        ? m.value.toLocaleString("en-IN", {
                            maximumFractionDigits: 2,
                          })
                        : "—"}
                    </span>
                  ) : null}
                </span>
              );
            })}
          </div>
        </div>
        {!rangeOnly && dma200Label ? (
          <div className="wl-dma-alert" role="status" aria-live="polite">
            <span className="wl-dma-alert-pill">{dma200Label}</span>
            {tape.dma200 != null && tape.price != null ? (
              <span className="wl-dma-alert-text">
                200 DMA{" "}
                {tape.dma200.toLocaleString("en-IN", {
                  maximumFractionDigits: 2,
                })}{" "}
                · Breakout{" "}
                {tape.breakout20 != null
                  ? tape.breakout20.toLocaleString("en-IN", {
                      maximumFractionDigits: 2,
                    })
                  : "—"}{" "}
                · Price{" "}
                {tape.price.toLocaleString("en-IN", {
                  maximumFractionDigits: 2,
                })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
