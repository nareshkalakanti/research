"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MmBase, MmChart as Chart } from "@/lib/momentum-money";

type Tab = "momentum" | "ipo2";
const SHORT: Record<string, string> = { ipo_range: "Range BO", pivot: "Pivot" };
const daysToWks = (d: number) => Math.max(1, Math.round(d / 5));

const day = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });
const inr = (v: number) => `₹${v.toLocaleString("en-IN", { maximumFractionDigits: v >= 100 ? 0 : 2 })}`;

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * Weekly chart of one stock, two tabs:
 *   Momentum notes  stage 4 decline, lockout rally, base 1 and base 2, the 20% weeks
 *   IPO2 entries    the old IPO2 entries that worked best (listing-range breakout, pivot breakout, E1B / E2B add)
 * With a year it's that year's winner study (Momentum & Money); without, the trailing year (Napkin).
 */
export function MmChart({
  ticker,
  year,
  market,
  mode = "both",
}: {
  ticker: string;
  year?: number;
  market?: string | null;
  /** ipo2: IPO2 marks and verdict only (Napkin, IPO2 screen rows) — no momentum notes. */
  mode?: "both" | "ipo2";
}) {
  const [data, setData] = useState<Chart | null>(null);
  const [tabSel, setTab] = useState<Tab>("momentum");
  /** Reasons under the verdict: hidden until asked for. */
  const [why, setWhy] = useState(false);
  const [showEntries, setShowEntries] = useState(false);
  /** IPO2 view range: 1Y daily candles, 3Y / All weekly. */
  const [range, setRange] = useState<"1Y" | "3Y" | "All">("3Y");
  const tab: Tab = mode === "ipo2" ? "ipo2" : tabSel;
  const [boxRef, boxW] = useWidth();

  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ ticker });
    if (year) qs.set("year", String(year));
    if (market) qs.set("market", market);
    void fetch(`/api/momentum-money?${qs}`)
      .then((r) => r.json())
      .then((j: Chart) => {
        if (live) setData(j);
      })
      .catch((e) => {
        if (live) setData({ ok: false, error: String(e) });
      });
    return () => {
      live = false;
    };
  }, [year, ticker, market]);

  if (!data) return <div ref={boxRef} className="mm-chart vx-empty">Loading {ticker} chart…</div>;
  if (!data.ok) return <div ref={boxRef} className="mm-chart vx-empty">{data.error}</div>;
  // The IPO2 tab hides the momentum marks; its 1Y range uses daily bars.
  const daily = tab === "ipo2" && range === "1Y";
  const all = daily ? data.days : data.weeks;
  const st = tab === "momentum" ? data.study : null;
  const ipo2 = tab === "ipo2" ? data.ipo2 : [];
  const ipo2Bases = tab === "ipo2" ? data.ipo2_bases : [];
  const idx = (iso: string | null | undefined) => {
    if (!iso || !all.length) return -1;
    if (iso < all[0]!.date && daily) return -1; // before the 1Y window
    let k = all.findIndex((w) => w.date >= iso);
    if (k < 0) k = all.length - 1;
    return k;
  };
  // Momentum: a little before the stage 4 high (or the rally) to a little after the last base.
  // IPO2: from a little before the first kept entry (at most 3 years back) to today.
  let first: number;
  let last: number;
  if (tab === "momentum" && st) {
    first = Math.max(0, idx(st.stage4_high_date ?? st.rally_from) - 6);
    const lastBase = st.base2 ?? st.base1 ?? null;
    last = lastBase?.end ? Math.min(all.length - 1, idx(lastBase.end) + 10) : all.length - 1;
  } else if (daily || range === "All") {
    first = 0;
    last = all.length - 1;
  } else {
    first = Math.max(0, all.length - 156);
    if (ipo2.length) first = Math.max(first, idx(ipo2[0]!.date) - 12);
    last = all.length - 1;
  }
  const weeks = all.slice(first, last + 1);
  const n = weeks.length;
  // Only entries in the visible window — number these 1…n (old BaseChart did the same).
  const visible = ipo2
    .map((e, i) => ({ e, i, k: idx(e.date) }))
    .filter(({ k }) => k >= first && k <= last);

  // Drawn inside a bordered frame (8px padding + 1px border each side).
  const W = Math.max(600, (boxW || 900) - 18);
  const H = 340;
  const L = 58;
  const R = 14;
  const T = 44;
  const B = 26;
  const lastPivot = [...ipo2Bases].reverse().find((b) => b.status !== "failed") ?? null;
  const lo =
    Math.min(
      ...weeks.map((w) => w.low),
      ...visible.map(({ e }) => e.stop),
      ...(lastPivot && idx(lastPivot.start) <= last ? [lastPivot.high] : []),
    ) * 0.94;
  const hi = Math.max(...weeks.map((w) => w.high), ...(lastPivot && idx(lastPivot.start) <= last ? [lastPivot.high] : [])) * 1.06;
  const ly = (v: number) => Math.log(v);
  const y = (v: number) => T + ((H - T - B) * (ly(hi) - ly(v))) / (ly(hi) - ly(lo));
  const x = (k: number) => L + ((W - L - R) * (k - first + 0.5)) / n;
  const bw = Math.max(1.5, ((W - L - R) / n) * 0.62);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.exp(ly(lo / 0.94) + (ly(hi / 1.06) - ly(lo / 0.94)) * f));
  const dateTicks = Array.from(new Set([0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1])).map((k) => k + first);

  const baseBox = (b: MmBase | null, name: string) => {
    if (!b) return null;
    const a = idx(b.start);
    const e = b.end ? idx(b.end) : all.length - 1;
    if (e < first || a > last) return null;
    const top = all[a]!.high;
    const bottom = top * (1 - b.depth_pct / 100);
    const x0 = x(Math.max(a, first)) - bw / 2;
    const x1 = x(Math.min(e, last)) + bw / 2;
    const label = `${name} · ${Math.round(b.depth_pct)}% · ${b.weeks}W${b.open ? " (open)" : ""}`;
    return (
      <g className="mmc-base">
        <rect x={x0} y={y(top)} width={Math.max(2, x1 - x0)} height={Math.max(2, y(bottom) - y(top))}>
          <title>{`${name}: ${b.depth_pct}% deep, ${b.weeks} weeks, ${day(b.start)} – ${b.end ? day(b.end) : "still open"}${
            b.nifty_pct != null ? `; Nifty pulled back ${b.nifty_pct}%` : ""
          }`}</title>
        </rect>
        <text x={x0 + 3} y={y(top) - 5}>
          {label}
        </text>
      </g>
    );
  };

  let rally: React.ReactNode = null;
  if (st) {
    const a = idx(st.rally_from);
    const e = idx(st.rally_to);
    const x0 = x(a) - bw / 2;
    const x1 = x(e) + bw / 2;
    rally = (
      <g className="mmc-rally">
        <rect x={x0} y={T - 8} width={Math.max(2, x1 - x0)} height={H - B - T + 8}>
          <title>{`Lockout rally ${day(st.rally_from)} – ${day(st.rally_to)}: +${st.rally_pct}% in ${st.rally_weeks} weeks, ${st.green8}/8 green weeks${
            st.green12 != null ? `, ${st.green12}/12` : ""
          }`}</title>
        </rect>
        <text x={x0 + 4} y={T - 14}>
          {`Lockout rally +${Math.round(st.rally_pct)}% · ${st.rally_weeks} wks · ${st.green8}/8 green`}
        </text>
      </g>
    );
  }

  let stage4: React.ReactNode = null;
  if (st?.stage4_high_date && st.stage4_low_date && st.stage4_pct) {
    const a = idx(st.stage4_high_date);
    const e = idx(st.stage4_low_date);
    if (a >= first) {
      const x0 = x(a);
      const y0 = y(all[a]!.high);
      const x1 = x(e);
      const y1 = y(all[e]!.low);
      stage4 = (
        <g className="mmc-stage4">
          <line x1={x0} y1={y0} x2={x1} y2={y1}>
            <title>{`Stage 4 decline ${day(st.stage4_high_date)} – ${day(st.stage4_low_date)}: −${st.stage4_pct}%${
              st.stage4_nifty_pct != null ? ` (Nifty −${st.stage4_nifty_pct}%${st.stage4_x != null ? `, ${st.stage4_x}x` : ""})` : ""
            }`}</title>
          </line>
          <text x={(x0 + x1) / 2 + 6} y={(y0 + y1) / 2}>
            {`Stage 4 −${Math.round(st.stage4_pct)}%${st.stage4_x != null ? ` (${st.stage4_x}x Nifty)` : ""}`}
          </text>
        </g>
      );
    }
  }

  const big = new Set(st?.big_week_dates ?? []);

  return (
    <div ref={boxRef} className="mm-chart">
      {data.listing_date ? (
        <p className="mmc-listing">
          Listed {day(data.listing_date)}
          {data.issue_price != null ? ` · issue ${inr(data.issue_price)}` : ""}
          {data.listing_gain_pct != null ? ` · day 1 ${data.listing_gain_pct > 0 ? "+" : ""}${data.listing_gain_pct}%` : ""} · IPO rules
        </p>
      ) : null}
      {data.verdict || (mode !== "ipo2" && data.momentum.length) ? (
        <div className={`mmc-verdict mmc-verdict--${data.verdict?.call ?? "wait"}`}>
          {data.verdict ? (
            <div className="mmc-verdict-head">
              <span className="mmc-call">{data.verdict.call.toUpperCase()}</span>
              <b>{data.verdict.action}</b>
            </div>
          ) : null}
          {data.stage_note ? <p className="mmc-stage">{data.stage_note}</p> : null}
          {(data.verdict?.reasons.length ?? 0) + (mode !== "ipo2" ? data.momentum.length : 0) ? (
            <button type="button" className="mmc-why" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
              {why ? "Hide reasons" : `Show reasons (${(data.verdict?.reasons.length ?? 0) + (mode !== "ipo2" ? data.momentum.length : 0)})`}
              <span aria-hidden>{why ? "▴" : "▾"}</span>
            </button>
          ) : null}
          {why ? (
          <div className="mmc-reasons">
            {data.verdict?.reasons.length ? (
              <div>
                <h4>IPO2 (today)</h4>
                <ul>
                  {data.verdict.reasons.map((r, i) => (
                    <li key={i} className={r.good ? "good" : "bad"}>
                      <i>{r.good ? "✓" : "✗"}</i> {r.text}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {mode !== "ipo2" && data.momentum.length ? (
              <div>
                <h4>Momentum notes ({year ? `${year} winner` : "last 12 months"})</h4>
                <ul>
                  {data.momentum.map((r, i) => (
                    <li key={i} className={r.good ? "good" : "bad"}>
                      <i>{r.good ? "✓" : "✗"}</i> {r.text}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          ) : null}
        </div>
      ) : null}
      {mode === "ipo2" ? null : (
      <div className="mmc-tabs" role="tablist" aria-label="Chart marks">
        {(
          [
            ["momentum", "Momentum notes"],
            ["ipo2", `IPO2 entries (${data.ipo2.length})`],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : undefined} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      )}
      {tab === "ipo2" ? (
        <div className="mmc-range" role="group" aria-label="Chart range">
          {(["1Y", "3Y", "All"] as const).map((r) => (
            <button key={r} type="button" className={range === r ? "on" : undefined} aria-pressed={range === r} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
          <span>{daily ? "daily candles" : "weekly candles"}</span>
        </div>
      ) : null}
      <div className="mmc-plot">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${data.ticker} weekly chart with stage 4, lockout rally and bases`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="mmc-grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text className="mmc-ax" x={L - 6} y={y(t) + 4} textAnchor="end">
              {inr(t)}
            </text>
          </g>
        ))}
        {rally}
        {baseBox(st?.base1 ?? null, "Base 1")}
        {baseBox(st?.base2 ?? null, "Base 2")}
        {ipo2Bases.map((b) => {
          const a = idx(b.start);
          const e = b.end ? idx(b.end) : all.length - 1;
          if (e < first || a > last) return null;
          const x0 = x(Math.max(a, first)) - bw / 2;
          const x1 = x(Math.min(e, last)) + bw / 2;
          const name = b.ipo_base ? "IPO base" : `Base ${b.n}`;
          return (
            <g key={`ib-${b.n}-${b.start}`} className={`mmc-zone mmc-zone--${b.status === "failed" ? "failed" : "base"}`}>
              <rect x={x0} y={T - 6} width={Math.max(2, x1 - x0)} height={H - T - B + 6}>
                <title>{`${name}: ${b.depth_pct}% deep, ${daysToWks(b.days)} weeks${b.status === "failed" ? ", failed" : b.status === "open" ? ", still open" : ""}`}</title>
              </rect>
            </g>
          );
        })}
        {lastPivot ? (() => {
          const a = idx(lastPivot.start);
          const e = lastPivot.end ? idx(lastPivot.end) : all.length - 1;
          if (e < first || a > last) return null;
          const x0 = x(Math.max(a, first));
          const x1 = x(Math.min(e, last));
          return (
            <g className="mmc-bh">
              <line x1={x0} x2={x1} y1={y(lastPivot.high)} y2={y(lastPivot.high)}>
                <title>{`Pivot ${inr(lastPivot.high)} · ${lastPivot.ipo_base ? "IPO base" : `Base ${lastPivot.n}`}`}</title>
              </line>
              <text className="mmc-bh-lab" x={Math.max(x0 + 4, x1 - 4)} y={y(lastPivot.high) - 5} textAnchor="end">
                {inr(lastPivot.high)}
              </text>
            </g>
          );
        })() : null}
        {!data.candles ? (
          <path className="mmc-line" d={weeks.map((w, i) => `${i ? "L" : "M"}${x(i + first).toFixed(1)},${y(w.close).toFixed(1)}`).join("")} />
        ) : null}
        {weeks.map((w, i) => {
          const k = i + first;
          const up = data.candles ? w.close >= w.open : i === 0 || w.close >= weeks[i - 1]!.close;
          return (
            <g key={w.date} className={up ? "mmc-up" : "mmc-dn"}>
              <line x1={x(k)} x2={x(k)} y1={y(w.high)} y2={y(w.low)} />
              {data.candles ? (
                <rect x={x(k) - bw / 2} y={y(Math.max(w.open, w.close))} width={bw} height={Math.max(1, Math.abs(y(w.open) - y(w.close)))} />
              ) : null}
              {big.has(w.date) ? (
                <text className="mmc-big" x={x(k)} y={y(w.high) - 6} textAnchor="middle">
                  20%
                </text>
              ) : null}
            </g>
          );
        })}
        {stage4}
        {visible.map(({ e, k }, vi) => {
          // Sit on the signal bar's high (weekly/daily candle top) — buy level stays in the tooltip.
          const bar = all[k]!;
          const mark = y(bar.high);
          const prev = visible[vi - 1];
          const next = visible[vi + 1];
          const near = (p: (typeof visible)[number] | undefined, dx: number) =>
            !!p && Math.abs(x(k) - x(p.k)) <= dx && Math.abs(mark - y(all[p.k]!.high)) <= 26;
          const showLab = !near(prev, 44) && !near(next, 30);
          return (
            <g key={`${e.date}-${e.kind}`} className={`mmc-entry mmc-entry--${e.kind}`}>
              <line className="mmc-stop" x1={x(k) - 14} x2={x(k) + 14} y1={y(e.stop)} y2={y(e.stop)} />
              <circle cx={x(k)} cy={mark} r={8}>
                <title>{`${e.label} ${day(e.date)}: buy above ${inr(e.level)}, stop ${inr(e.stop)} (${e.risk_pct}%)`}</title>
              </circle>
              <text className="mmc-entry-n" x={x(k)} y={mark + 3.5} textAnchor="middle">
                {vi + 1}
              </text>
              {showLab ? (
                <text className="mmc-entry-lab" x={x(k)} y={mark - 13} textAnchor="middle">
                  {e.kind === "add" ? e.label.replace(" add", "") : SHORT[e.kind]}
                </text>
              ) : null}
            </g>
          );
        })}
        {dateTicks.map((k) => (
          <text key={k} className="mmc-ax" x={x(k)} y={H - 8} textAnchor={k === first ? "start" : k === last ? "end" : "middle"}>
            {day(all[k]!.date)}
          </text>
        ))}
      </svg>
      </div>
      {tab === "ipo2" ? (
        data.ipo2.length ? (
          <>
          <button type="button" className="mmc-why" aria-expanded={showEntries} onClick={() => setShowEntries((v) => !v)}>
            {showEntries ? "Hide Entries" : `Show Entries (${visible.length})`}
            <span aria-hidden>{showEntries ? "▴" : "▾"}</span>
          </button>
          {showEntries ? (
          <table className="vx-table mm-table mmc-entries">
            <thead>
              <tr>
                <th />
                <th>Entry</th>
                <th>Date</th>
                <th className="num">Buy above</th>
                <th className="num">Stop</th>
                <th className="num">Risk</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ e }, vi) => (
                <tr key={`${e.date}-${e.kind}`}>
                  <td>{vi + 1}</td>
                  <td>{e.label}</td>
                  <td>{day(e.date)}</td>
                  <td className="num">{inr(e.level)}</td>
                  <td className="num">{inr(e.stop)}</td>
                  <td className="num">{e.risk_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          ) : null}
          </>
        ) : (
          <p className="vx-hint mmc-foot">No IPO2 entries for this stock.</p>
        )
      ) : !data.study ? (
        <p className="vx-hint mmc-foot">No lockout rally (6/8 green weeks with a 50%+ move) after the 52-week low.</p>
      ) : null}
      <p className="vx-hint mmc-foot">
        {daily ? "Daily" : "Weekly"} {data.candles ? "candles" : "closes"}, log scale. Hover a zone or dot for its numbers.
        {tab === "ipo2"
          ? ` IPO2 entries from daily closes${data.ipo2_listed ? " (IPO rules: listed in the last 4 years)" : ""}: the three that worked best across all stocks in 2023–25 — listing-range breakout, pivot breakout, E1B / E2B add. Dashed accent line is the current base pivot. No sell marks.`
          : ""}
      </p>
    </div>
  );
}
