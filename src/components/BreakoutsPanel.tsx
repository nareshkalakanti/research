"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { PageScanButton } from "@/components/PageScanButton";
import { napkinUrl, tradingviewSymbol, tradingviewUrl, websiteUrl } from "@/lib/links";

type Screen = "multi" | "ipo" | "vcp" | "blue" | "none";

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
  /** null: not breaking out, listed for its lockout rally. */
  screen: Screen | null;
  also: Screen[];
  /** Session the breakout printed (may be within the last 3 days). */
  breakout_date: string | null;
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
  {
    id: "multi",
    label: "Multi-year breakout",
    hint: "52+ week base, above the 200-day, RS 60+, within 20% of the pivot — a year-plus coil releasing",
  },
  {
    id: "ipo",
    label: "IPO base",
    hint: "Listed under 50 weeks: any qualifying 3+ week base (≤35% deep). Holds the 50-day once it exists; RS / 200-day waived. Fresh = last 3 sessions",
  },
  {
    id: "vcp",
    label: "VCP",
    hint: "RS 70+, 3+ week base ≤35% deep, 2+ shallower pullbacks (last ≤10%), ATR% and volume ≤0.9× the first half",
  },
  {
    id: "blue",
    label: "Blue sky",
    hint: "All-time high pivot with 2+ years of history, RS 70+, basing within 20% of the high — open sky above",
  },
  {
    id: "none",
    label: "No named screen",
    hint: "Qualifying breakout (3+ week base ≤35%, coiling, liquidity / RS / MAs) that isn’t Multi-year, IPO, VCP, or Blue sky",
  },
  {
    id: "lockout",
    label: "Lockout rallies",
    hint: "Concentrated green bars with range expansion: 6 of the last 8 weekly bars green, each green week 1.5× the base's usual weekly move, out of a 7+ week base, starting near the 30-week average: end of stage 1 / start of stage 2 (Davinder Khurana's Lockout Rallies). Liquidity floor only.",
  },
];
const inGroup = (r: Row, g: Group) =>
  g === "lockout" ? r.lockout != null : r.screen === g || (g !== "none" && r.also.includes(g));
const LABEL: Record<Screen, string> = { multi: "Multi-year", ipo: "IPO base", vcp: "VCP", blue: "Blue sky", none: "Other" };

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

function Card({ r, asOf }: { r: Row; asOf: string | null }) {
  const web = websiteUrl(r.website);
  const tv = tradingviewUrl(r.ticker, r.market);
  const up = (r.day_pct ?? 0) >= 0;
  const where = r.above_pct == null ? null : Math.abs(r.above_pct) < 1 ? "at its pivot" : `${Math.round(r.above_pct)}% above it`;
  const lockout = r.lockout ? `${r.lockout.green}/8 green weeks · +${Math.round(r.lockout.gain_pct)}% since ${shortDay(r.lockout.start)} · out of a ${r.lockout.base_weeks}-week base` : null;
  const brokeEarlier = r.breakout_date && asOf && r.breakout_date !== asOf;
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
            {brokeEarlier ? <span>broke {shortDay(r.breakout_date!)}</span> : null}
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
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  /** Free-text ₹ Cr bounds, same as Value ("" = no limit). No hard mcap floor in the scan. */
  const [minCap, setMinCap] = useState("");
  const [maxCap, setMaxCap] = useState("");
  const [exch, setExch] = useState<Exch>("all");
  const [only, setOnly] = useState<Group | "all">("all");

  const rescan = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void fetch("/api/breakouts", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Data) => {
        if (live) setData(j);
      })
      .catch((e) => {
        if (live) setData({ ok: false, error: String(e), date: null, rows: [], universe: 0, refreshing: 0 });
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [reloadKey]);

  const rows = useMemo(() => {
    const min = Number(minCap) || 0;
    const max = Number(maxCap) || 0;
    return (data?.rows ?? []).filter((r) => {
      if (min && (r.mcap_cr ?? 0) < min) return false;
      if (max && (r.mcap_cr ?? Infinity) > max) return false;
      if (exch !== "all" && exchOf(r.market) !== exch) return false;
      return true;
    });
  }, [data, minCap, maxCap, exch]);

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
          <PageScanButton
            busy={loading}
            onScanned={rescan}
            title="Rebuild breakouts from saved daily bars (stale Yahoo series refresh in the background)"
          />
          <label className="vx-field">
            <span className="vx-label">Min market cap</span>
            <input
              inputMode="numeric"
              value={minCap}
              onChange={(e) => setMinCap(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="₹ Cr"
              aria-label="Minimum market cap"
            />
          </label>
          <label className="vx-field">
            <span className="vx-label">Max market cap</span>
            <input
              inputMode="numeric"
              value={maxCap}
              onChange={(e) => setMaxCap(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="₹ Cr"
              aria-label="Maximum market cap"
            />
          </label>
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
                <Card key={r.ticker} r={r} asOf={data.date} />
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
