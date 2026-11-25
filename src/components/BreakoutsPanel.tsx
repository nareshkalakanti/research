"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { napkinUrl, tradingviewSymbol, tradingviewUrl, websiteUrl } from "@/lib/links";

type Screen = "multi" | "vcp" | "blue" | "none";

type Row = {
  ticker: string;
  name: string;
  market: string;
  industry: string | null;
  website: string | null;
  mcap_cr: number | null;
  price: number;
  day_pct: number | null;
  rel_vol: number | null;
  pivot: number;
  above_pct: number;
  base_weeks: number;
  rs: number | null;
  screen: Screen;
  also: Screen[];
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

const SCREENS: { id: Screen; label: string; hint: string }[] = [
  { id: "multi", label: "Multi-year breakout", hint: "Base of 52 weeks or more" },
  { id: "vcp", label: "VCP", hint: "Three pullbacks, each shallower than the last (last ≤ 10%), volume drying up" },
  { id: "blue", label: "Blue sky", hint: "No higher close in the whole history (2+ years)" },
  { id: "none", label: "No named screen", hint: "Breakout from a base of 2+ weeks" },
];
const LABEL: Record<Screen, string> = { multi: "Multi-year", vcp: "VCP", blue: "Blue sky", none: "Other" };

const CAPS = [
  { id: 0, label: "All" },
  { id: 500, label: "₹500 Cr+" },
  { id: 1000, label: "₹1,000 Cr+" },
  { id: 5000, label: "₹5,000 Cr+" },
] as const;

type Exch = "all" | "nse" | "bse" | "bsesme";
const EXCH: { id: Exch; label: string }[] = [
  { id: "all", label: "All" },
  { id: "nse", label: "NSE + NSE SME" },
  { id: "bse", label: "BSE" },
  { id: "bsesme", label: "BSE SME" },
];
function exchOf(market: string): Exch {
  const m = market.toUpperCase();
  if (m.startsWith("BSE")) return m.includes("SME") ? "bsesme" : "bse";
  return "nse";
}

const num = (v: number) => v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pivotFmt = (v: number) => Math.round(v).toLocaleString("en-IN");

function Spark({ r }: { r: Row }) {
  const gid = `bo-g-${useId().replace(/:/g, "")}`;
  const W = 300;
  const H = 110;
  const pts = r.chart;
  if (pts.length < 2) return <div className="bo-spark" />;
  const lo = Math.min(...pts, r.pivot);
  const hi = Math.max(...pts, r.pivot);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => 6 + (1 - (v - lo) / span) * (H - 12);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const up = pts[pts.length - 1]! >= pts[0]!;
  const py = y(r.pivot);
  const bx = x(r.base_from);
  return (
    <svg className={`bo-spark ${up ? "up" : "down"}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect className="bo-base" x={bx} y={0} width={W - bx} height={H} />
      <path d={`${d}L${W},${H}L0,${H}Z`} fill={`url(#${gid})`} />
      <line className="bo-pivot" x1={0} x2={W} y1={py} y2={py} vectorEffect="non-scaling-stroke" />
      <path className="bo-line" d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Card({ r }: { r: Row }) {
  const web = websiteUrl(r.website);
  const tv = tradingviewUrl(r.ticker, r.market);
  const up = (r.day_pct ?? 0) >= 0;
  const vsPivot = Math.abs(r.above_pct) < 1 ? "At pivot" : `+${Math.round(r.above_pct)}%`;
  return (
    <article className="bo-card">
      <header className="bo-top">
        <div className="bo-id">
          <a className="bo-tk" href={tv} target="_blank" rel="noopener noreferrer">
            {r.ticker}
          </a>
          {r.market !== "NSE" ? <span className="bo-ex">{r.market}</span> : null}
          {r.also.map((a) => (
            <span key={a} className={`bo-tag bo-tag--${a}`}>
              {LABEL[a]}
            </span>
          ))}
        </div>
        <span className={`bo-chg ${up ? "pos" : "neg"}`}>
          {r.day_pct == null ? "—" : `${up ? "+" : ""}${r.day_pct.toFixed(2)}%`}
        </span>
      </header>
      <div className="bo-row2">
        <span className="bo-name" title={`${r.name}${r.industry ? ` · ${r.industry}` : ""}`}>
          {r.name}
          {r.industry ? <span className="bo-ind"> · {r.industry}</span> : null}
        </span>
        <span className="bo-px">₹{num(r.price)}</span>
      </div>
      <a className="bo-chart" href={tv} target="_blank" rel="noopener noreferrer" title="Open chart in TradingView">
        <Spark r={r} />
        <span className="bo-pivot-lbl">pivot {pivotFmt(r.pivot)}</span>
        <span className="bo-open">Open chart ↗</span>
      </a>
      <dl className="bo-stats">
        <div>
          <dt>Base</dt>
          <dd>{r.base_weeks}w</dd>
        </div>
        <div>
          <dt>vs pivot</dt>
          <dd>{vsPivot}</dd>
        </div>
        <div>
          <dt>RS</dt>
          <dd>
            {r.rs ?? "—"}
            {r.rs != null ? (
              <i className="bo-rs" style={{ ["--rs" as string]: `${r.rs}%` }} data-hi={r.rs >= 80 ? "" : undefined} />
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Rel vol</dt>
          <dd className={r.rel_vol != null && r.rel_vol >= 1.5 ? "hot" : undefined}>
            {r.rel_vol == null ? "—" : `${r.rel_vol >= 10 ? Math.round(r.rel_vol) : r.rel_vol.toFixed(1)}×`}
          </dd>
        </div>
      </dl>
      <footer className="bo-links">
        <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
          NP
        </a>
        {web ? (
          <a className="np-chip" href={web} target="_blank" rel="noopener noreferrer" title={r.website ?? ""}>
            Web
          </a>
        ) : null}
        {r.mcap_cr != null ? <span className="bo-mcap">₹{Math.round(r.mcap_cr).toLocaleString("en-IN")} Cr</span> : null}
      </footer>
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
  const [exch, setExch] = useState<Exch>("all");
  const [only, setOnly] = useState<Screen | "all">("all");

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
        (r) => (minCap === 0 || (r.mcap_cr ?? 0) >= minCap) && (exch === "all" || exchOf(r.market) === exch),
      ),
    [data, minCap, exch],
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
            {date} · closing at or just above the top of a base · <b>{rows.length}</b> of {data.rows.length} breakouts from{" "}
            {data.universe.toLocaleString("en-IN")} stocks
            {data.refreshing ? ` · ${data.refreshing} price series updating` : ""}
          </p>
        </div>
        <div className="bo-filters">
          <div className="bo-seg" role="group" aria-label="Market cap">
            {CAPS.map((c) => (
              <button key={c.id} type="button" className={minCap === c.id ? "on" : undefined} onClick={() => setMinCap(c.id)}>
                {c.label}
              </button>
            ))}
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
          All <span>{rows.length}</span>
        </button>
        {SCREENS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`bo-tab--${s.id}${only === s.id ? " on" : ""}`}
            title={s.hint}
            onClick={() => setOnly(s.id)}
          >
            <i /> {s.label} <span>{rows.filter((r) => r.screen === s.id).length}</span>
          </button>
        ))}
      </nav>

      {SCREENS.filter((s) => only === "all" || only === s.id).map((s) => {
        const list = rows.filter((r) => r.screen === s.id);
        if (!list.length) return null;
        return (
          <section key={s.id} className={`bo-group bo-group--${s.id}`}>
            <div className="bo-group-head">
              <i className="bo-dot" />
              <span className="bo-group-title">{s.label}</span>
              <span className="bo-group-hint">{s.hint}</span>
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
                {list.length}
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
      {!rows.length ? <div className="vx-card vx-empty">No breakouts today with these filters.</div> : null}
    </div>
  );
}
