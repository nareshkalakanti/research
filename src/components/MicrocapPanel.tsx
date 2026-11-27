"use client";

import { useEffect, useMemo, useState } from "react";
import type { MicrocapDistribution, MicrocapPoint, MicrocapSeries } from "@/lib/microcap-distribution";

type DistData = (MicrocapDistribution & { ok: true }) | { ok: false; error: string };

function fmtAsOf(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

type LineSpec = { key: string; label: string; points: MicrocapPoint[]; cls: string };

/** Cumulative distribution: Main board vs SME. */
function DistChart({ lines }: { lines: LineSpec[] }) {
  const base = lines[0]?.points ?? [];
  const chart = useMemo(() => {
    if (base.length < 2) return null;
    const W = 960;
    const H = 440;
    const padL = 64;
    const padR = 28;
    const padT = 36;
    const padB = 56;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const xOf = (i: number) => padL + (i / (base.length - 1)) * plotW;
    const yMax = Math.max(500, ...lines.flatMap((l) => l.points.map((p) => p.companies)));
    const yTop = Math.ceil(yMax / 500) * 500 || 500;
    const yOf = (n: number) => padT + plotH * (1 - n / yTop);

    const paths = lines.map((l) => ({
      ...l,
      d: l.points.map((p, i) => `${i ? "L" : "M"}${xOf(i).toFixed(1)},${yOf(p.companies).toFixed(1)}`).join(" "),
    }));

    const yTicks: number[] = [];
    for (let v = 0; v <= yTop; v += 500) yTicks.push(v);

    return { W, H, padL, padR, padT, padB, plotW, plotH, xOf, yOf, yTop, yTicks, paths };
  }, [base, lines]);

  if (!chart) return <p className="vx-hint">Not enough market-cap points to draw the curve.</p>;

  return (
    <svg
      className="mc-chart"
      viewBox={`0 0 ${chart.W} ${chart.H}`}
      role="img"
      aria-label="Distribution of microcap stocks: Main board vs SME"
    >
      <text x={chart.W / 2} y={18} textAnchor="middle" className="mc-title">
        Distribution of Micro cap Stocks
      </text>

      {chart.yTicks.map((v) => {
        const y = chart.yOf(v);
        return (
          <g key={v}>
            <line x1={chart.padL} y1={y} x2={chart.W - chart.padR} y2={y} className="mc-grid" />
            <text x={chart.padL - 10} y={y + 4} textAnchor="end" className="mc-tick">
              {v.toLocaleString("en-IN")}
            </text>
          </g>
        );
      })}
      {base.map((p, i) => {
        const x = chart.xOf(i);
        return (
          <g key={p.mcap_cr}>
            <line x1={x} y1={chart.padT} x2={x} y2={chart.padT + chart.plotH} className="mc-grid" />
            <text x={x} y={chart.padT + chart.plotH + 18} textAnchor="middle" className="mc-tick">
              {p.mcap_cr}
            </text>
          </g>
        );
      })}

      <line
        x1={chart.padL}
        y1={chart.padT + chart.plotH}
        x2={chart.W - chart.padR}
        y2={chart.padT + chart.plotH}
        className="mc-axis"
      />
      <line x1={chart.padL} y1={chart.padT} x2={chart.padL} y2={chart.padT + chart.plotH} className="mc-axis" />

      {chart.paths.map((l) => (
        <g key={l.key}>
          <path d={l.d} className={`mc-line mc-line--${l.cls}`} fill="none" />
          {l.points.map((p, i) => (
            <circle key={p.mcap_cr} cx={chart.xOf(i)} cy={chart.yOf(p.companies)} r={3.2} className={`mc-dot mc-dot--${l.cls}`}>
              <title>{`${l.label} · ₹${p.mcap_cr.toLocaleString("en-IN")} Cr · ${p.companies.toLocaleString("en-IN")}`}</title>
            </circle>
          ))}
        </g>
      ))}

      <g className="mc-legend" transform={`translate(${chart.padL + 8}, ${chart.padT + 8})`}>
        {chart.paths.map((l, i) => (
          <g key={l.key} transform={`translate(0, ${i * 18})`}>
            <line x1={0} y1={0} x2={22} y2={0} className={`mc-line mc-line--${l.cls}`} />
            <circle cx={11} cy={0} r={3} className={`mc-dot mc-dot--${l.cls}`} />
            <text x={28} y={4} className="mc-legend-label">
              {l.label}
            </text>
          </g>
        ))}
      </g>

      <text x={chart.W / 2} y={chart.H - 8} textAnchor="middle" className="mc-axis-label">
        Market Cap in Rs (Crores)
      </text>
      <text
        x={16}
        y={chart.padT + chart.plotH / 2}
        textAnchor="middle"
        className="mc-axis-label"
        transform={`rotate(-90 16 ${chart.padT + chart.plotH / 2})`}
      >
        Total Number of Companies
      </text>
    </svg>
  );
}

function SeriesNote({ s }: { s: MicrocapSeries }) {
  return (
    <span>
      <b>{s.label}</b>: {s.at_or_below_max.toLocaleString("en-IN")} of {s.universe.toLocaleString("en-IN")} ≤ ₹1,000 Cr
    </span>
  );
}

/** Microcap distribution page (Main vs SME cumulative mcap curve). */
export function MicrocapPanel() {
  const [data, setData] = useState<DistData | null>(null);

  useEffect(() => {
    let live = true;
    void fetch("/api/microcap", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: DistData) => {
        if (live) setData(j);
      })
      .catch((e) => {
        if (live) setData({ ok: false, error: String(e) });
      });
    return () => {
      live = false;
    };
  }, []);

  const lines: LineSpec[] = useMemo(() => {
    if (!data || !data.ok) return [];
    return [
      { key: "main", label: "Main board (NSE / BSE)", points: data.main.points, cls: "main" },
      { key: "sme", label: "SME (NSE SME / BSE SME)", points: data.sme.points, cls: "sme" },
    ];
  }, [data]);

  return (
    <section className="vx mc">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">Main board vs SME · companies under each market-cap ceiling</span>
          <h2 className="vx-title">
            Microcap <span>Distribution</span>
          </h2>
        </div>
      </header>

      {!data ? (
        <div className="vx-card vx-empty">Building distribution…</div>
      ) : !data.ok ? (
        <div className="vx-card vx-empty vx-msg--err">Could not load: {data.error}</div>
      ) : (
        <>
          <div className="vx-card mc-card">
            <DistChart lines={lines} />
            <p className="vx-hint mc-foot">
              Cumulative counts from saved market caps · <SeriesNote s={data.main} /> · <SeriesNote s={data.sme} /> · as of{" "}
              {fmtAsOf(data.as_of)}
            </p>
          </div>

          <div className="vx-card mc-table-card">
            <div className="vx-table-head">
              <span className="vx-label vx-label--title">Thresholds</span>
            </div>
            <div className="vx-scroll">
              <table className="vx-table mc-table">
                <thead>
                  <tr>
                    <th>Market cap ≤</th>
                    <th className="num">Main board</th>
                    <th className="num">SME</th>
                    <th className="num">All</th>
                  </tr>
                </thead>
                <tbody>
                  {data.main.points.map((p, i) => (
                    <tr key={p.mcap_cr}>
                      <td>₹{p.mcap_cr.toLocaleString("en-IN")} Cr</td>
                      <td className="num">{p.companies.toLocaleString("en-IN")}</td>
                      <td className="num">{(data.sme.points[i]?.companies ?? 0).toLocaleString("en-IN")}</td>
                      <td className="num">{(data.all.points[i]?.companies ?? 0).toLocaleString("en-IN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
