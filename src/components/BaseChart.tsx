"use client";

import { useId } from "react";
import type { Ipo2Analysis, Ipo2Stage } from "@/lib/ipo2";

/** Stage chips / pills shared by the IPO2 screen and the Napkin bases card. */
export const BASE_STAGES: Array<{ id: Ipo2Stage; label: string; hint: string }> = [
  { id: "buy_zone", label: "Buy zone", hint: "An entry triggered in the last 10 trading days, price within 5% of it and above its stop" },
  { id: "near_pivot", label: "Near pivot", hint: "In a base, within 10% of the base high: watch for the breakout" },
  { id: "in_base", label: "In base", hint: "Resting below the high for 3+ weeks (IPO base) or 5+ weeks, after a 25%+ rise" },
  { id: "pullback", label: "Pullback", hint: "Off the high, too short to be a base yet" },
  { id: "running", label: "Running", hint: "At or near highs with no base yet" },
  { id: "extended", label: "Extended", hint: "Ran more than 5% past the last entry: don't chase" },
  { id: "late", label: "Late (E3)", hint: "Third leg after the breakout: sell into strength" },
  { id: "no_rise", label: "No prior rise", hint: "Resting, but without a 25% rise into it: not a setup" },
  { id: "broken", label: "Broken", hint: "The last base failed (deeper than 40% IPO base / 35%) and no 25% recovery yet" },
  { id: "new", label: "New", hint: "Under 15 trading days since listing" },
];
export const STAGE_LABEL = Object.fromEntries(BASE_STAGES.map((s) => [s.id, s.label])) as Record<Ipo2Stage, string>;

export function inr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
}

export function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });
}

const SHORT: Record<string, string> = { low_cheat: "Low cheat", cheat: "Cheat", pivot: "Pivot" };

/**
 * Price with bases shaded, numbered entries with their stops, and volume below
 * (same look as the IPO2 entry map). `fromIdx` crops the view (e.g. last 2 years);
 * the analysis still covers the whole series.
 */
export function BaseChart({
  series,
  analysis: a,
  ticker,
  fromIdx = 0,
  height = 320,
}: {
  series: Array<{ date: string; close: number; volume?: number }>;
  analysis: Ipo2Analysis;
  ticker: string;
  fromIdx?: number;
  height?: number;
}) {
  const gid = `bc-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const start = Math.max(0, Math.min(fromIdx, series.length - 2));
  const view = series.slice(start);
  const n = view.length;
  const W = 1000;
  const PH = height;
  const VH = Math.round(height * 0.26);
  const L = 62;
  const R = 70;
  const T = 34;
  const closes = view.map((b) => b.close);
  const vols = view.map((b) => b.volume ?? 0);
  const entries = a.entries.filter((e) => e.idx >= start);
  const bases = a.bases.filter((b) => (b.end_idx ?? series.length - 1) >= start);
  const lo = Math.min(...closes, ...entries.map((e) => e.stop)) * 0.96;
  const hi = Math.max(...closes, ...entries.map((e) => e.level)) * 1.04;
  const x = (i: number) => L + ((W - L - R) * (i - start + 0.5)) / n;
  const y = (p: number) => T + ((PH - T - 12) * (hi - p)) / (hi - lo);
  // Scale volume to a high-but-typical day so one spike doesn't flatten the rest (spikes are clipped).
  const sortedV = vols.filter((v) => v > 0).sort((p, q) => p - q);
  const vMax = Math.max(1, (sortedV[Math.floor(sortedV.length * 0.97)] ?? 1) * 1.2);
  const VT = PH + 14;
  const vy = (v: number) => VT + VH - ((VH - 4) * Math.min(v, vMax)) / vMax;
  const bw = Math.max(1, ((W - L - R) / n) * 0.7);
  const tickVals = [0, 0.25, 0.5, 0.75, 1].map((f) => lo / 0.96 + (hi / 1.04 - lo / 0.96) * f);
  const pts = closes.map((c, i) => `${x(i + start).toFixed(1)},${y(c).toFixed(1)}`);
  const line = `M${pts.join("L")}`;
  const area = `${line}L${x(start + n - 1).toFixed(1)},${(PH - 12).toFixed(1)}L${x(start).toFixed(1)},${(PH - 12).toFixed(1)}Z`;
  const dateTicks = Array.from(new Set([0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1]));
  const entryNo = new Map(entries.map((e, k) => [e, k + 1]));
  // Labels: pivots / adds above the dot, cheats below; flip when the previous label is close.
  const labels: boolean[] = [];
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k]!;
    let above = e.kind === "pivot" || e.kind === "add";
    const prev = k > 0 ? entries[k - 1]! : null;
    if (prev && x(e.idx) - x(prev.idx) < 80 && above === labels[k - 1]) above = !above;
    labels.push(above);
  }
  const lastValid = [...bases].reverse().find((b) => b.valid && b.status !== "failed") ?? null;
  const firstRun = a.listed && start === 0 && a.run_pct != null ? Math.min(n - 1, 40) : null;
  const daysToWks = (d: number) => Math.max(1, Math.round(d / 5));

  return (
    <div className="ipo2-chart">
      <svg viewBox={`0 0 ${W} ${VT + VH + 24}`} role="img" aria-label={`${ticker} price with bases and entries`}>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" className="bc-area-top" />
            <stop offset="100%" className="bc-area-bot" />
          </linearGradient>
        </defs>
        {firstRun != null ? (
          <g>
            <rect className="bc-zone bc-zone--run" x={x(0) - bw} y={T - 22} width={x(firstRun) - x(0) + bw} height={PH - T + 10} />
            <text className="bc-zlab" x={x(0) - bw + 6} y={T - 8}>
              First 8 wks · {a.run_pct! > 0 ? "+" : ""}
              {a.run_pct}%
            </text>
          </g>
        ) : null}
        {bases.map((b, k) => {
          const x0 = x(Math.max(start, b.start_idx));
          const x1 = x(b.end_idx ?? series.length - 1);
          const name = !b.valid ? "No prior rise" : b.ipo_base ? "IPO base" : `Base ${b.n}`;
          const wide = x1 - x0 > 120;
          return (
            <g key={`${b.start_idx}-${b.n}`}>
              <rect
                className={`bc-zone ${b.valid ? (b.status === "failed" ? "bc-zone--failed" : "bc-zone--base") : "bc-zone--weak"}`}
                x={x0}
                y={T - 22}
                width={Math.max(2, x1 - x0)}
                height={PH - T + 10}
              />
              <text
                className="bc-zlab"
                x={x0 + 6}
                y={T - 8 + (firstRun != null && b.start_idx <= firstRun ? 14 : wide ? 0 : (k % 2) * 13)}
              >
                {name} · {b.depth_pct}%{wide ? ` · ${daysToWks(b.days)} wks` : ""}
                {b.status === "failed" ? " · failed" : ""}
              </text>
            </g>
          );
        })}
        {tickVals.map((t) => (
          <g key={t}>
            <line className="ipo2-grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text className="ipo2-ax" x={L - 8} y={y(t) + 4} textAnchor="end">
              {inr(t)}
            </text>
          </g>
        ))}
        {lastValid ? (
          <g>
            <line
              className="bc-bh"
              x1={x(Math.max(start, lastValid.start_idx))}
              x2={x(lastValid.end_idx ?? series.length - 1)}
              y1={y(lastValid.high)}
              y2={y(lastValid.high)}
            />
            <text className="bc-note" x={x(lastValid.end_idx ?? series.length - 1) + 4} y={y(lastValid.high) + 4}>
              {inr(lastValid.high)}
            </text>
          </g>
        ) : null}
        <path d={area} fill={`url(#${gid})`} />
        <path className="bc-price" d={line} />
        {entries.map((e, k) => {
          const ex = x(e.idx);
          const ey = y(e.level);
          const above = labels[k];
          return (
            <g key={`${e.idx}-${e.kind}`}>
              <line className="ipo2-stopline" x1={ex - 16} x2={ex + 16} y1={y(e.stop)} y2={y(e.stop)} />
              <circle className={`bc-dot ipo2-dot--${e.kind}`} cx={ex} cy={ey} r={10}>
                <title>{`${e.label} ${shortDate(e.date)}: above ${inr(e.level)}, stop ${inr(e.stop)} (${e.risk_pct}%)`}</title>
              </circle>
              <text className="bc-dotn" x={ex} y={ey + 4} textAnchor="middle">
                {entryNo.get(e)}
              </text>
              <text className="bc-elab" x={ex} y={above ? ey - 16 : ey + 25} textAnchor="middle">
                {e.kind === "add" ? e.label.replace(" add", "") : SHORT[e.kind]}
              </text>
            </g>
          );
        })}
        <text className="ipo2-ax" x={L - 8} y={VT + 12} textAnchor="end">
          Vol
        </text>
        <line className="ipo2-grid" x1={L} x2={W - R} y1={VT + VH} y2={VT + VH} />
        {vols.map((v, i) =>
          v > 0 ? (
            <rect
              key={i}
              className={i === 0 || closes[i]! >= closes[i - 1]! ? "ipo2-vup" : "ipo2-vdn"}
              x={x(i + start) - bw / 2}
              y={vy(v)}
              width={bw}
              height={VT + VH - vy(v)}
            />
          ) : null,
        )}
        {dateTicks.map((i) => (
          <text key={i} className="ipo2-ax" x={x(i + start)} y={VT + VH + 17} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
            {shortDate(view[i]!.date)}
          </text>
        ))}
      </svg>
      {entries.length ? (
        <div className="bc-table-wrap">
          <table className="bc-table">
            <thead>
              <tr>
                <th />
                <th>Entry</th>
                <th>Date</th>
                <th className="num">Buy above</th>
                <th className="num">Stop</th>
                <th className="num">Risk</th>
                <th className="num">Volume</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={`${e.idx}-${e.kind}`} className={a.live_entry === e || (a.live_entry && a.live_entry.idx === e.idx) ? "bc-live" : undefined}>
                  <td>
                    <span className={`ipo2-num ipo2-dot--${e.kind}`}>{entryNo.get(e)}</span>
                  </td>
                  <td>{e.label}</td>
                  <td>{shortDate(e.date)}</td>
                  <td className="num">{inr(e.level)}</td>
                  <td className="num bc-stop">{inr(e.stop)}</td>
                  <td className="num">{e.risk_pct}%</td>
                  <td className="num">{e.vol_x != null && (e.kind === "pivot" || e.kind === "add") ? `${e.vol_x}×` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="vx-hint">No entries in this period: no base after a 25% rise has triggered.</p>
      )}
    </div>
  );
}
