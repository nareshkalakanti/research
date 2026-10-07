"use client";

import { useEffect, useState } from "react";
import type { QuoteTape } from "@/lib/quote-tape";

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

type Props = {
  ticker: string;
  market?: string | null;
  /** When false, skip network (e.g. collapsed row). Default true. */
  active?: boolean;
  title?: string;
};

/**
 * Tech & Val card: price / PE / CAGR, SMA 20/50/100/200, 52-week range.
 */
export function QuoteTapeCard({
  ticker,
  market = null,
  active = true,
  title = "Tech & Val",
}: Props) {
  const [tape, setTape] = useState<QuoteTape | null>(null);
  const [loading, setLoading] = useState(false);

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
  }, [ticker, market, active]);

  if (!active) return null;
  if (loading && !tape) {
    return (
      <section className="wl-card-qtr wl-card-price quote-tape-card">
        <h3>{title}</h3>
        <p className="wl-card-muted">Loading…</p>
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
    <section className="wl-card-qtr wl-card-price quote-tape-card">
      <h3>{title}</h3>
      <div className="wl-tape">
        <div className="wl-tape-stats">
          <span className="wl-tape-stat">
            <span className="wl-tape-stat-label">Price</span>{" "}
            <strong>{fmtPrice(tape.price)}</strong>
          </span>
          <span className="wl-tape-stat">
            <span className="wl-tape-stat-label">PE</span>{" "}
            <strong>{tape.pe != null ? tape.pe.toFixed(2) : "—"}</strong>
          </span>
          <span className="wl-tape-stat">
            <span className="wl-tape-stat-label">
              {tape.cagr_years ? `${tape.cagr_years}Y CAGR` : "CAGR"}
            </span>{" "}
            <strong className={cagrCls}>
              {tape.cagr_pct == null
                ? "—"
                : `${tape.cagr_pct >= 0 ? "+" : ""}${tape.cagr_pct.toFixed(1)}%`}
            </strong>
          </span>
        </div>
        <div className="wl-tape-mas">
          <span className="wl-tape-label">Moving averages</span>
          <div className="wl-ma-row">
            {tape.mas.map((m) => {
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
                  <span className="wl-ma-period">{m.period}</span>
                  <span className="wl-ma-val">
                    {m.value != null
                      ? m.value.toLocaleString("en-IN", {
                          maximumFractionDigits: 2,
                        })
                      : "—"}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
        {dma200Label ? (
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
        {low != null && high != null ? (
          <div className="wl-tape-range">
            <span className="wl-tape-label">52-week range</span>
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
    </section>
  );
}
