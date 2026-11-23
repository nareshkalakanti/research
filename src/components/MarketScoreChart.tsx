"use client";

import { useEffect, useId, useMemo, useState } from "react";

type MarketScoreSignal = "UPCYCLE" | "DOWNCYCLE" | "REVERSAL" | "NEUTRAL";
type MarketScorePoint = { date: string; score: number; above: number; below: number; n: number };
type Series = {
  industry: string;
  is_market?: boolean;
  as_of: string | null;
  current: number;
  signal: MarketScoreSignal;
  points: MarketScorePoint[];
};

function fmtScore(n: number): string {
  const s = n.toFixed(4);
  return n >= 0 ? `+${s}` : s;
}

function fmtAxisDate(iso: string, isLast: boolean): string {
  if (isLast) return "Current";
  const d = new Date(`${iso}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return iso;
  const mon = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${day}-${mon}-${yy}`;
}

function signalLabel(s: MarketScoreSignal): string {
  if (s === "UPCYCLE") return "UPCYCLE";
  if (s === "DOWNCYCLE") return "DOWNCYCLE";
  if (s === "REVERSAL") return "REVERSAL";
  return "NEUTRAL";
}

/**
 * Full Market Market Score history — compact SCORE / SIGNAL + breadth timeline
 * (Neutral at 1.0). Theme colors via CSS; expands under the Full Market row.
 */
export function MarketScoreChart({ industry }: { industry: string }) {
  const gid = useId().replace(/:/g, "");
  const [data, setData] = useState<Series | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setErr(null);
    setHover(null);
    void (async () => {
      try {
        const q = new URLSearchParams({ kind: "market-score", industry });
        const res = await fetch(`/api/value-tools?${q}`, { cache: "no-store" });
        const j = (await res.json()) as Series & { ok?: boolean; error?: string };
        if (!live) return;
        if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
        setData(j);
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [industry]);

  const chart = useMemo(() => {
    const pts = data?.points ?? [];
    if (pts.length < 2) return null;
    const w = 960;
    const h = 220;
    const padL = 44;
    const padR = 16;
    const padT = 14;
    const padB = 28;
    const scores = pts.map((p) => p.score);
    const rawLo = Math.min(...scores, 1);
    const rawHi = Math.max(...scores, 1);
    const pad = Math.max((rawHi - rawLo) * 0.12, 0.08);
    const lo = rawLo - pad;
    const hi = rawHi + pad;
    const span = hi - lo || 1;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const xAt = (i: number) => padL + (i / (pts.length - 1)) * innerW;
    const yAt = (v: number) => padT + innerH - ((v - lo) / span) * innerH;
    let line = "";
    for (let i = 0; i < pts.length; i += 1) {
      const x = xAt(i);
      const y = yAt(pts[i]!.score);
      line += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    const yTicks = [lo, 1, hi]
      .map((t) => Math.round(t * 100) / 100)
      .filter((t, i, a) => a.indexOf(t) === i);
    // Ensure 1.0 is labeled even if outside raw range padding edge cases.
    if (!yTicks.includes(1)) yTicks.splice(1, 0, 1);
    const xLabelIdx: number[] = [];
    const want = Math.min(6, pts.length);
    for (let i = 0; i < want; i += 1) {
      xLabelIdx.push(Math.round((i / Math.max(want - 1, 1)) * (pts.length - 1)));
    }
    const last = pts.length - 1;
    return {
      w,
      h,
      padL,
      padR,
      padT,
      padB,
      xAt,
      yAt,
      line,
      yTicks,
      xLabelIdx,
      pts,
      last,
      end: { x: xAt(last), y: yAt(pts[last]!.score) },
      area: `${line} L${xAt(last).toFixed(1)} ${(h - padB).toFixed(1)} L${xAt(0).toFixed(1)} ${(h - padB).toFixed(1)} Z`,
      hiLabel: hi.toFixed(2),
      loLabel: lo.toFixed(2),
    };
  }, [data]);

  const tone =
    data?.signal === "UPCYCLE" ? "up" : data?.signal === "DOWNCYCLE" ? "down" : data?.signal === "REVERSAL" ? "rev" : "neu";
  const score = data?.current ?? null;
  // Meter: 0 → left (0.5), 1 → mid, 1.5 → right.
  const meterPct = score == null ? 50 : Math.min(100, Math.max(0, ((score - 0.5) / 1.0) * 100));

  return (
    <div className={`vx-mscore vx-mscore--${tone}`}>
      <div className="vx-mscore-head">
        <div className="vx-mscore-col">
          <span className="vx-mscore-k">SCORE</span>
          <span className="vx-mscore-score">
            <span className="vx-mscore-meter" aria-hidden>
              <span className="vx-mscore-meter-mid" />
              <span className="vx-mscore-meter-fill" style={{ width: `${meterPct}%` }} />
            </span>
            {score != null ? fmtScore(score) : "—"}
          </span>
        </div>
        <div className="vx-mscore-col vx-mscore-col--sig">
          <span className="vx-mscore-k">SIGNAL</span>
          {data ? (
            <span className="vx-mscore-sig">
              {data.signal === "UPCYCLE" ? "▲ " : data.signal === "DOWNCYCLE" ? "▼ " : "• "}
              {signalLabel(data.signal)}
            </span>
          ) : (
            <span className="vx-mscore-sig">…</span>
          )}
        </div>
      </div>

      {err ? (
        <p className="vx-msg vx-msg--err">Could not load Market Score: {err}</p>
      ) : !data || !chart ? (
        <p className="vx-empty">Building Market Score history…</p>
      ) : (
        <>
          <div className="vx-mscore-chart-wrap">
            <svg
              className="vx-mscore-svg"
              viewBox={`0 0 ${chart.w} ${chart.h}`}
              width="100%"
              role="img"
              aria-label={`Market Score history for ${data.industry}`}
              onMouseLeave={() => setHover(null)}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * chart.w;
                let best = 0;
                let bestD = 1e9;
                for (let i = 0; i < chart.pts.length; i += 1) {
                  const dx = Math.abs(chart.xAt(i) - x);
                  if (dx < bestD) {
                    bestD = dx;
                    best = i;
                  }
                }
                setHover(best);
              }}
            >
              <defs>
                <linearGradient id={`ms-fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
                  <stop offset="55%" stopColor="currentColor" stopOpacity="0.06" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
              <text className="vx-mscore-axis" x={chart.padL - 6} y={chart.padT + 4} textAnchor="end">
                {chart.hiLabel}
              </text>
              <text className="vx-mscore-axis" x={chart.padL - 6} y={chart.h - chart.padB + 2} textAnchor="end">
                {chart.loLabel}
              </text>
              <line
                className="vx-mscore-guide"
                x1={chart.padL}
                x2={chart.w - chart.padR}
                y1={chart.yAt(1)}
                y2={chart.yAt(1)}
              />
              <text
                className="vx-mscore-neutral-label"
                x={chart.w - chart.padR}
                y={chart.yAt(1) - 5}
                textAnchor="end"
              >
                Neutral 1.0
              </text>
              <path d={chart.area} fill={`url(#ms-fill-${gid})`} className="vx-mscore-area" />
              <path d={chart.line} fill="none" className="vx-mscore-line" />
              <circle
                className="vx-mscore-end"
                cx={chart.end.x}
                cy={chart.end.y}
                r="4.5"
              />
              {hover != null && chart.pts[hover] ? (
                <g className="vx-mscore-hover">
                  <line
                    x1={chart.xAt(hover)}
                    x2={chart.xAt(hover)}
                    y1={chart.padT}
                    y2={chart.h - chart.padB}
                  />
                  <circle cx={chart.xAt(hover)} cy={chart.yAt(chart.pts[hover]!.score)} r="4" />
                  <g
                    transform={`translate(${Math.min(chart.xAt(hover) + 8, chart.w - chart.padR - 108)}, ${Math.max(chart.padT, chart.yAt(chart.pts[hover]!.score) - 30)})`}
                  >
                    <rect width="100" height="22" rx="5" />
                    <text x="50" y="15" textAnchor="middle">
                      {fmtScore(chart.pts[hover]!.score)}
                    </text>
                  </g>
                </g>
              ) : null}
              {chart.xLabelIdx.map((i) => (
                <text
                  key={`x-${i}`}
                  className="vx-mscore-axis"
                  x={chart.xAt(i)}
                  y={chart.h - 6}
                  textAnchor="middle"
                >
                  {fmtAxisDate(chart.pts[i]!.date, i === chart.last)}
                </text>
              ))}
            </svg>
          </div>
          <div className="vx-mscore-legend" aria-hidden>
            <span>
              <i className="vx-mscore-swatch vx-mscore-swatch--line" /> Score
            </span>
            <span>
              <i className="vx-mscore-swatch vx-mscore-swatch--now" /> Current
            </span>
            <span>
              <i className="vx-mscore-swatch vx-mscore-swatch--neu" /> Neutral
            </span>
          </div>
        </>
      )}
    </div>
  );
}
