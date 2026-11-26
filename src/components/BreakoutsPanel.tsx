"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { napkinUrl, tradingviewSymbol, tradingviewUrl, websiteUrl } from "@/lib/links";

type Screen = "multi" | "vcp" | "blue" | "none";

type Row = {
  ticker: string;
  name: string;
  market: string;
  industry: string | null;
  sector: string | null;
  website: string | null;
  mcap_cr: number | null;
  price: number;
  day_pct: number | null;
  rel_vol: number | null;
  pivot: number | null;
  above_pct: number | null;
  base_weeks: number | null;
  rs: number | null;
  /** null: not breaking out today, listed for its lockout rally. */
  screen: Screen | null;
  also: Screen[];
  lockout: { green: number; gain_pct: number; start: string; from_price: number; weeks: number; base_weeks: number } | null;
  chart: number[];
  base_from: number;
};

type Data = {
  ok: boolean;
  error?: string;
  date: string | null;
  rows: Row[];
  universe: number;
  refreshing: number;
};

type Group = Screen | "lockout";
const SCREENS: { id: Group; label: string; hint: string }[] = [
  { id: "multi", label: "Multi-year breakout", hint: "Base of 52 weeks or more" },
  { id: "vcp", label: "VCP", hint: "Three pullbacks, each shallower than the last (last ≤ 10%), volume drying up" },
  { id: "blue", label: "Blue sky", hint: "No higher close in the whole history (2+ years)" },
  { id: "none", label: "No named screen", hint: "Breakout from a base of 2+ weeks" },
  {
    id: "lockout",
    label: "Lockout rallies",
    hint: "Concentrated green bars with range expansion: 6 of the last 8 weekly bars green, each green week 1.5× the base's usual weekly move, out of a 7+ week base, starting near the 30-week average: end of stage 1 / start of stage 2 (Davinder Khurana's Lockout Rallies). Breaking out today or not.",
  },
];
const inGroup = (r: Row, g: Group) => (g === "lockout" ? r.lockout != null : r.screen === g);
const LABEL: Record<Screen, string> = { multi: "Multi-year", vcp: "VCP", blue: "Blue sky", none: "Other" };

/** Market cap range in ₹ Cr; 0 = no limit. */
const CAP_STEPS = [0, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000] as const;
const capLabel = (v: number) => (v === 0 ? "Any" : v >= 100000 ? `₹${v / 100000}L Cr` : `₹${v.toLocaleString("en-IN")} Cr`);

type Exch = "all" | "nse" | "nsesme" | "bse" | "bsesme";
const EXCH: { id: Exch; label: string }[] = [
  { id: "all", label: "All" },
  { id: "nse", label: "NSE" },
  { id: "nsesme", label: "NSE SME" },
  { id: "bse", label: "BSE" },
  { id: "bsesme", label: "BSE SME" },
];
function exchOf(market: string): Exch {
  const m = market.toUpperCase();
  const sme = m.includes("SME") || m.includes("EMERGE");
  if (m.startsWith("BSE")) return sme ? "bsesme" : "bse";
  return sme ? "nsesme" : "nse";
}

const num = (v: number) => v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pivotFmt = (v: number) => Math.round(v).toLocaleString("en-IN");
const shortDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

function Spark({ r }: { r: Row }) {
  const W = 300;
  const H = 90;
  const pts = r.chart;
  if (pts.length < 2) return <div className="bo-spark" />;
  const lo = Math.min(...pts, r.pivot ?? Infinity);
  const hi = Math.max(...pts, r.pivot ?? -Infinity);
  const span = hi - lo || 1;
  const x = (i: number) => 3 + (i / (pts.length - 1)) * (W - 6);
  const y = (v: number) => 5 + (1 - (v - lo) / span) * (H - 10);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const up = pts[pts.length - 1]! >= pts[0]!;
  const bx = x(r.base_from);
  // Base box: from the pivot down to the lowest close inside the base (lockout: the run's range).
  const baseLow = Math.min(...pts.slice(r.base_from));
  const py = y(r.pivot ?? Math.max(...pts.slice(r.base_from)));
  const by = y(baseLow);
  const ex = x(pts.length - 1);
  const ey = y(pts[pts.length - 1]!);
  return (
    <svg className={`bo-spark ${up ? "up" : "down"}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <rect className="bo-base" x={bx} y={py} width={W - 3 - bx} height={Math.max(2, by - py)} />
      {r.pivot != null ? <line className="bo-pivot" x1={0} x2={W} y1={py} y2={py} vectorEffect="non-scaling-stroke" /> : null}
      <path className="bo-line" d={d} vectorEffect="non-scaling-stroke" />
      <circle className="bo-end" cx={ex} cy={ey} r={3.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Card({ r }: { r: Row }) {
  const web = websiteUrl(r.website);
  const tv = tradingviewUrl(r.ticker, r.market);
  const up = (r.day_pct ?? 0) >= 0;
  const where = r.above_pct == null ? null : Math.abs(r.above_pct) < 1 ? "at its pivot" : `${Math.round(r.above_pct)}% above it`;
  const lockout = r.lockout ? `${r.lockout.green}/8 green weeks · +${Math.round(r.lockout.gain_pct)}% since ${shortDay(r.lockout.start)} · out of a ${r.lockout.base_weeks}-week base` : null;
  return (
    <article className="bo-card">
      <div className="bo-l1">
        <a className="bo-tk" href={tv} target="_blank" rel="noopener noreferrer">
          {r.ticker}
        </a>
        <span className="bo-px">
          {num(r.price)}{" "}
          <span className={up ? "pos" : "neg"}>{r.day_pct == null ? "" : `${up ? "+" : ""}${r.day_pct.toFixed(2)}%`}</span>
        </span>
      </div>
      <div className="bo-l2">
        <span className="bo-name" title={r.name}>
          {r.name}
        </span>
        {r.rel_vol != null ? (
          <span className="bo-rv">Rel vol {r.rel_vol >= 10 ? Math.round(r.rel_vol) : r.rel_vol.toFixed(1)}× so far</span>
        ) : null}
      </div>
      <a className="bo-chart" href={tv} target="_blank" rel="noopener noreferrer" title="Open chart in TradingView">
        <Spark r={r} />
      </a>
      <div className="bo-facts">
        {r.pivot != null ? (
          <>
            <span>pivot {pivotFmt(r.pivot)}</span>
            <span>{r.base_weeks}-week base</span>
            <span>{where}</span>
          </>
        ) : (
          <span>Lockout rally: {lockout}</span>
        )}
        {r.rs != null ? <span>RS {r.rs}</span> : null}
        {r.also.map((a) => (
          <b key={a}>also {LABEL[a]}</b>
        ))}
        {r.pivot != null && r.lockout ? <b title={lockout ?? ""}>also Lockout {r.lockout.green}/8</b> : null}
      </div>
      <div className="bo-l4">
        <span className="bo-ind" title={[r.industry, r.sector].filter(Boolean).join(" · ")}>
          {r.industry ?? "—"}
          {r.sector && r.sector !== r.industry ? <small className="ind-sector">{r.sector}</small> : null}
          {r.market !== "NSE" ? ` · ${r.market}` : ""}
        </span>
        <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
          NP
        </a>
        {web ? (
          <a className="np-chip" href={web} target="_blank" rel="noopener noreferrer" title={r.website ?? ""}>
            Web
          </a>
        ) : null}
      </div>
    </article>
  );
}

/** TradingView watchlist import: one EXCHANGE:SYMBOL per line. */
function download(label: string, rows: Row[], date: string | null) {
  const lines = rows.map((r) => tradingviewSymbol(r.ticker, r.market)).filter(Boolean);
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${date ?? "today"}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Breakouts page: stocks closing today at or just above the top of a base,
 * grouped by screen (Multi-year breakout, VCP, Blue sky, No named screen).
 */
export function BreakoutsPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [minCap, setMinCap] = useState<number>(500);
  const [maxCap, setMaxCap] = useState<number>(0);
  const [exch, setExch] = useState<Exch>("all");
  const [only, setOnly] = useState<Group | "all">("all");

  useEffect(() => {
    let live = true;
    void fetch("/api/breakouts", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Data) => {
        if (live) setData(j);
      })
      .catch((e) => {
        if (live) setData({ ok: false, error: String(e), date: null, rows: [], universe: 0, refreshing: 0 });
      });
    return () => {
      live = false;
    };
  }, []);

  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (r) =>
          (minCap === 0 || (r.mcap_cr ?? 0) >= minCap) &&
          (maxCap === 0 || (r.mcap_cr != null && r.mcap_cr <= maxCap)) &&
          (exch === "all" || exchOf(r.market) === exch),
      ),
    [data, minCap, maxCap, exch],
  );

  if (!data) return <div className="vx-card vx-empty">Scanning for breakouts…</div>;
  if (!data.ok) return <div className="vx-card vx-empty vx-msg--err">Could not load: {data.error}</div>;

  const date = data.date
    ? new Date(`${data.date}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    : "—";

  return (
    <div className="bo-page">
      <div className="bo-hero">
        <div>
          <h2 className="bo-title">Breakouts</h2>
          <p className="bo-lede">
            {date} · closing at or just above the top of a base · <b>{rows.filter((r) => r.screen != null).length}</b> of{" "}
            {data.rows.filter((r) => r.screen != null).length} breakouts and <b>{rows.filter((r) => r.lockout).length}</b> lockout rallies from{" "}
            {data.universe.toLocaleString("en-IN")} stocks
            {data.refreshing ? ` · ${data.refreshing} price series updating` : ""}
          </p>
        </div>
        <div className="bo-filters">
          <div className="bo-range" role="group" aria-label="Market cap">
            <span>Market cap</span>
            <select value={minCap} onChange={(e) => setMinCap(Number(e.target.value))} aria-label="Minimum market cap">
              {CAP_STEPS.filter((v) => maxCap === 0 || v < maxCap).map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? "Min: Any" : `Min ${capLabel(v)}`}
                </option>
              ))}
            </select>
            <span className="bo-range-dash">–</span>
            <select value={maxCap} onChange={(e) => setMaxCap(Number(e.target.value))} aria-label="Maximum market cap">
              {CAP_STEPS.filter((v) => v === 0 || v > minCap).map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? "Max: Any" : `Max ${capLabel(v)}`}
                </option>
              ))}
            </select>
          </div>
          <div className="bo-seg" role="group" aria-label="Exchange">
            {EXCH.map((c) => (
              <button key={c.id} type="button" className={exch === c.id ? "on" : undefined} onClick={() => setExch(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <nav className="bo-tabs" aria-label="Screens">
        <button type="button" className={only === "all" ? "on" : undefined} onClick={() => setOnly("all")}>
          All <span>{rows.filter((r) => r.screen != null).length}</span>
        </button>
        {SCREENS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`bo-tab--${s.id}${only === s.id ? " on" : ""}`}
            title={s.hint}
            onClick={() => setOnly(s.id)}
          >
            {s.label} <span>{rows.filter((r) => inGroup(r, s.id)).length}</span>
          </button>
        ))}
      </nav>

      <div className="bo-groups">
      {SCREENS.filter((s) => only === "all" || only === s.id).map((s) => {
        const list = rows.filter((r) => inGroup(r, s.id));
        if (!list.length) return null;
        return (
          <section key={s.id} className="bo-group" style={{ "--n": Math.min(list.length, 6) } as CSSProperties}>
            <div className="bo-group-head">
              <span className="bo-group-title" title={s.hint}>
                {s.label}
              </span>
              <span className="bo-count">{list.length}</span>
              <button
                type="button"
                className="bo-dl"
                title="Download as a TradingView watchlist"
                aria-label={`Download ${s.label}`}
                onClick={() => download(s.label, list, data.date)}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                  <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <div className="bo-grid">
              {list.map((r) => (
                <Card key={r.ticker} r={r} />
              ))}
            </div>
          </section>
        );
      })}
      </div>
      {!rows.length ? <div className="vx-card vx-empty">No breakouts today with these filters.</div> : null}
    </div>
  );
}
