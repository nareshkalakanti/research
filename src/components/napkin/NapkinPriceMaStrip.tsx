"use client";

import { useEffect, useId, useMemo, useState } from "react";

type Tape = {
  price: number | null;
  mas: Array<{ period: number; value: number | null; above: boolean | null }>;
  chart?: {
    close: number[];
    ma50: Array<number | null>;
    ma200: Array<number | null>;
  };
};

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", {
    maximumFractionDigits: n >= 100 ? 0 : 2,
  });
}

function maOf(tape: Tape | null, period: 50 | 200) {
  const m = tape?.mas.find((x) => x.period === period);
  return m ?? { period, value: null, above: null as boolean | null };
}

function downsample<T>(arr: T[], maxPts: number): T[] {
  if (arr.length <= maxPts) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i += 1) {
    out.push(arr[Math.round(i * step)]!);
  }
  return out;
}

function pathFrom(
  values: Array<number | null>,
  lo: number,
  span: number,
  w: number,
  h: number,
  padL: number,
  padR: number,
  padT: number,
  padB: number,
): string {
  const n = values.length;
  if (n < 2) return "";
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  let d = "";
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    const x = padL + (i / (n - 1)) * innerW;
    const y = padT + innerH - ((v - lo) / span) * innerH;
    d += `${d ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

function areaFrom(
  values: number[],
  lo: number,
  span: number,
  w: number,
  h: number,
  padL: number,
  padR: number,
  padT: number,
  padB: number,
): string {
  const line = pathFrom(values, lo, span, w, h, padL, padR, padT, padB);
  if (!line || values.length < 2) return "";
  const innerW = w - padL - padR;
  const base = h - padB;
  return `${line} L${(padL + innerW).toFixed(1)} ${base} L${padL} ${base} Z`;
}

function lastPoint(
  values: Array<number | null>,
  lo: number,
  span: number,
  w: number,
  h: number,
  padL: number,
  padR: number,
  padT: number,
  padB: number,
): { x: number; y: number } | null {
  const n = values.length;
  if (n < 1) return null;
  let i = n - 1;
  while (i >= 0 && (values[i] == null || !Number.isFinite(values[i]!))) i -= 1;
  if (i < 0) return null;
  const v = values[i]!;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  return {
    x: padL + (i / Math.max(n - 1, 1)) * innerW,
    y: padT + innerH - ((v - lo) / span) * innerH,
  };
}

/**
 * Modern Price · SMA 50 · SMA 200 card beside About on Napkin.
 */
export function NapkinPriceMaStrip({
  ticker,
  market,
  priceFallback = null,
}: {
  ticker: string;
  market?: string | null;
  priceFallback?: number | null;
}) {
  const gid = useId().replace(/:/g, "");
  const [tape, setTape] = useState<Tape | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    const t = ticker.trim().toUpperCase();
    if (!t) {
      setTape(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const q = new URLSearchParams({ ticker: t, chart: "1" });
    if (market?.trim()) q.set("market", market.trim());
    void fetch(`/api/quote-tape?${q}`, { signal: AbortSignal.timeout(60_000) })
      .then((r) => r.json())
      .then((j: { ok?: boolean; tape?: Tape }) => {
        if (live) setTape(j.ok && j.tape ? j.tape : null);
      })
      .catch(() => {
        if (live) setTape(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [ticker, market]);

  const price = tape?.price ?? priceFallback;
  const ma50 = maOf(tape, 50);
  const ma200 = maOf(tape, 200);
  const chart = tape?.chart;
  const up =
    chart && chart.close.length >= 2
      ? chart.close[chart.close.length - 1]! >= chart.close[0]!
      : null;

  const svg = useMemo(() => {
    if (!chart || chart.close.length < 2) return null;
    const close = downsample(chart.close, 64);
    const ma50s = downsample(chart.ma50, 64);
    const ma200s = downsample(chart.ma200, 64);

    const w = 460;
    const h = 188;
    const padL = 34;
    const padR = 14;
    const padT = 12;
    const padB = 12;
    const vals = [
      ...close,
      ...ma50s.filter((v): v is number => v != null),
      ...ma200s.filter((v): v is number => v != null),
    ];
    if (!vals.length) return null;
    const rawLo = Math.min(...vals);
    const rawHi = Math.max(...vals);
    const pad = (rawHi - rawLo) * 0.06 || 1;
    const lo = rawLo - pad;
    const hi = rawHi + pad;
    const span = hi - lo || 1;
    const yAt = (v: number) =>
      padT + (h - padT - padB) - ((v - lo) / span) * (h - padT - padB);

    return {
      w,
      h,
      padL,
      padR,
      padT,
      padB,
      area: areaFrom(close, lo, span, w, h, padL, padR, padT, padB),
      close: pathFrom(close, lo, span, w, h, padL, padR, padT, padB),
      ma50: pathFrom(ma50s, lo, span, w, h, padL, padR, padT, padB),
      ma200: pathFrom(ma200s, lo, span, w, h, padL, padR, padT, padB),
      end: lastPoint(close, lo, span, w, h, padL, padR, padT, padB),
      hiLabel: fmt(rawHi),
      loLabel: fmt(rawLo),
      midLabel: fmt((rawHi + rawLo) / 2),
      midY: yAt((rawHi + rawLo) / 2),
      guides: [0.25, 0.5, 0.75].map((p) => padT + (h - padT - padB) * p),
    };
  }, [chart]);

  const tone = (above: boolean | null) =>
    above === true ? "above" : above === false ? "below" : "flat";

  return (
    <aside
      className={`napkin-price-ma${up === true ? " napkin-price-ma--up" : up === false ? " napkin-price-ma--down" : ""}`}
      aria-busy={loading}
      aria-label="Price chart with SMA 50 and SMA 200"
    >
      <header className="napkin-price-ma-head">
        <span className="napkin-price-ma-title">Price · 1Y</span>
        <span className="napkin-price-ma-legend" aria-hidden>
          <span>
            <i className="napkin-price-ma-swatch napkin-price-ma-swatch--px" />
            Price
          </span>
          <span>
            <i className="napkin-price-ma-swatch napkin-price-ma-swatch--ma50" />
            SMA 50
          </span>
          <span>
            <i className="napkin-price-ma-swatch napkin-price-ma-swatch--ma200" />
            SMA 200
          </span>
        </span>
      </header>

      <div className="napkin-price-ma-stats">
        <div className="napkin-price-ma-stat">
          <span className="napkin-price-ma-label">Price</span>
          <span className="napkin-price-ma-num">
            {loading && price == null ? "…" : fmt(price)}
          </span>
        </div>
        <div
          className={`napkin-price-ma-stat napkin-price-ma-stat--${tone(ma50.above)}`}
          title={
            ma50.above == null
              ? "50-day simple moving average"
              : ma50.above
                ? "Above 50 SMA"
                : "Below 50 SMA"
          }
        >
          <span className="napkin-price-ma-label">SMA 50</span>
          <span className="napkin-price-ma-num">
            {loading && ma50.value == null ? "…" : fmt(ma50.value)}
          </span>
          <span className="napkin-price-ma-sub">
            {ma50.above == null ? "" : ma50.above ? "above" : "below"}
          </span>
        </div>
        <div
          className={`napkin-price-ma-stat napkin-price-ma-stat--${tone(ma200.above)}`}
          title={
            ma200.above == null
              ? "200-day simple moving average"
              : ma200.above
                ? "Above 200 SMA"
                : "Below 200 SMA"
          }
        >
          <span className="napkin-price-ma-label">SMA 200</span>
          <span className="napkin-price-ma-num">
            {loading && ma200.value == null ? "…" : fmt(ma200.value)}
          </span>
          <span className="napkin-price-ma-sub">
            {ma200.above == null ? "" : ma200.above ? "above" : "below"}
          </span>
        </div>
      </div>

      <div className="napkin-price-ma-chart">
        {svg ? (
          <svg
            viewBox={`0 0 ${svg.w} ${svg.h}`}
            width="100%"
            height={svg.h}
            role="img"
            aria-label="1-year price with SMA 50 and SMA 200"
          >
            <defs>
              <linearGradient id={`pxFill-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
                <stop offset="55%" stopColor="currentColor" stopOpacity="0.05" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            {svg.guides.map((y) => (
              <line
                key={y}
                x1={svg.padL}
                x2={svg.w - svg.padR}
                y1={y}
                y2={y}
                className="napkin-price-ma-guide"
              />
            ))}
            <g className="napkin-price-ma-axes" aria-hidden>
              <text x={svg.padL - 6} y={svg.padT + 3} textAnchor="end">
                {svg.hiLabel}
              </text>
              <text x={svg.padL - 6} y={svg.midY + 3} textAnchor="end">
                {svg.midLabel}
              </text>
              <text x={svg.padL - 6} y={svg.h - svg.padB + 2} textAnchor="end">
                {svg.loLabel}
              </text>
            </g>
            {svg.area ? (
              <path
                d={svg.area}
                fill={`url(#pxFill-${gid})`}
                stroke="none"
                className="napkin-price-ma-area"
              />
            ) : null}
            {svg.ma200 ? (
              <path
                d={svg.ma200}
                fill="none"
                className="napkin-price-ma-line napkin-price-ma-line--ma200"
              />
            ) : null}
            {svg.ma50 ? (
              <path
                d={svg.ma50}
                fill="none"
                className="napkin-price-ma-line napkin-price-ma-line--ma50"
              />
            ) : null}
            {svg.close ? (
              <path
                d={svg.close}
                fill="none"
                className="napkin-price-ma-line napkin-price-ma-line--px"
              />
            ) : null}
            {svg.end ? (
              <circle
                cx={svg.end.x}
                cy={svg.end.y}
                r="3.5"
                className="napkin-price-ma-end"
              />
            ) : null}
          </svg>
        ) : (
          <p className="napkin-price-ma-empty">
            {loading ? "Loading chart…" : "No chart data"}
          </p>
        )}
      </div>
    </aside>
  );
}
