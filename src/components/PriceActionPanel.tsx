"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ReviewPlusButton } from "@/components/ReviewPlusButton";
import { napkinUrl, tradingviewUrl, websiteUrl } from "@/lib/links";

type Metrics = { day_pct: number | null; vol_x: number | null; ret_1m: number | null; ret_3m: number | null };

type Row = {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  industry: string | null;
  website: string | null;
  mcap_cr: number | null;
  cap_class: "Large" | "Mid" | "Small" | null;
  price: number | null;
  days: number[];
  trending: number;
  streak: number;
  last: Metrics;
  has_volume: boolean;
  rocket_price: boolean;
  rocket_rpi: boolean;
  wrpi: number | null;
};

type Rules = { s4DayPct: number; s3DayPct: number; s3VolX: number; s3Ret3mPct: number; s2Ret1mPct: number };

type Data = {
  rockets: { recentDays: number };
  dates: string[];
  rows: Row[];
  universe: number;
  no_volume: number;
  refreshing: number;
  rules: Rules;
};

type View = "latest" | "2wk" | "custom";
type SortKey = "trending" | "streak" | "day" | "mcap" | "name";

const PAGE = 200;

function screens(bits: number): string[] {
  const out: string[] = [];
  if (bits & 1) out.push("S1");
  if (bits & 2) out.push("S2");
  if (bits & 4) out.push("S3");
  if (bits & 8) out.push("S4");
  return out;
}

function pct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function cr(n: number | null): string {
  return n == null ? "—" : `₹${Math.round(n).toLocaleString("en-IN")} Cr`;
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Quick ranges for Custom dates, in calendar days back from today. */
const PRESETS = [
  { id: "1W", days: 7 },
  { id: "2W", days: 14 },
  { id: "1M", days: 30 },
  { id: "2M", days: 61 },
  { id: "3M", days: 91 },
] as const;

/** Trending-days thresholds that fit the window: 3/5/7/9/11 for 2WK, quarters of the range otherwise. */
function trendingSteps(n: number): number[] {
  if (n <= 0) return [];
  if (n === 11) return [3, 5, 7, 9, 11];
  return [...new Set([0.25, 0.5, 0.75, 1].map((f) => Math.max(1, Math.round(n * f))))];
}

function Dots({ days, dates }: { days: number[]; dates: string[] }) {
  return (
    <span className={days.length > 22 ? "pa-dots pa-dots--dense" : "pa-dots"}>
      {days.map((b, i) => {
        const d = dates[i] ?? "";
        const title =
          b < 0 ? `${shortDate(d)}: no trade` : b === 0 ? `${shortDate(d)}: no screen passed` : `${shortDate(d)}: ${screens(b).join(", ")}`;
        return <span key={d || i} className={b > 0 ? "pa-dot on" : b < 0 ? "pa-dot none" : "pa-dot"} title={title} />;
      })}
    </span>
  );
}

function Company({ r }: { r: Row }) {
  const web = websiteUrl(r.website);
  return (
    <td>
      <a className="vx-co" href={tradingviewUrl(r.ticker, r.market)} target="_blank" rel="noopener noreferrer">
        {r.name}
      </a>
      <span className="vx-sub">
        {r.ticker}
        <em>{r.market || "NSE"}</em>
        <ReviewPlusButton ticker={r.ticker} />
        <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
          NP
        </a>
        {web ? (
          <a className="np-chip" href={web} target="_blank" rel="noopener noreferrer" title={r.website ?? ""}>
            Web
          </a>
        ) : null}
      </span>
    </td>
  );
}

function Rockets({ r }: { r: Row }) {
  return (
    <td className="pa-rockets">
      {r.rocket_price ? (
        <span className="pa-rocket" title="Closed at a 52-week high in the last 10 trading days">
          🚀 52wk High
        </span>
      ) : null}
      {r.rocket_rpi ? (
        <span
          className="pa-rocket pa-rocket--rpi"
          title={`Weighted RPI at a 52-week high in the last 10 trading days${r.wrpi != null ? ` (now ${r.wrpi.toFixed(1)})` : ""}. Estimate: equal weights.`}
        >
          🚀 W.RPI
        </span>
      ) : null}
    </td>
  );
}

/** Industry (StockScans) with its broad sector under it. */
function Sector({ r }: { r: Row }) {
  const label = r.industry || r.sector;
  const title = [r.sector, r.industry].filter(Boolean).join(" › ") || undefined;
  return (
    <td className="pa-sector" title={title}>
      {label ?? "—"}
      {r.industry && r.sector && r.sector !== r.industry ? <small className="ind-sector">{r.sector}</small> : null}
    </td>
  );
}

function Cap({ r }: { r: Row }) {
  return (
    <td className="num">
      {r.cap_class ? <span className="pa-cap">{r.cap_class} Cap</span> : null}
      <span className="pa-cap-cr">{cr(r.mcap_cr)}</span>
    </td>
  );
}

export function PriceActionPanel() {
  const [view, setView] = useState<View>("2wk");
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));
  /** Quick range in use; null once the dates are edited by hand. */
  const [preset, setPreset] = useState<string | null>("1M");
  const pickPreset = (id: string, days: number) => {
    setPreset(id);
    setFrom(isoDaysAgo(days));
    setTo(isoDaysAgo(0));
    setMinDays(0);
  };
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [minCap, setMinCap] = useState("");
  const [maxCap, setMaxCap] = useState("");
  const [exch, setExch] = useState("all");
  const [minDays, setMinDays] = useState(0);
  const [rocket, setRocket] = useState("all");
  const [sort, setSort] = useState<SortKey>("trending");
  const [shown, setShown] = useState(PAGE);

  const url = useMemo(() => {
    if (view === "latest") return "/api/price-action?days=1";
    if (view === "custom") return `/api/price-action?from=${from}&to=${to}`;
    return "/api/price-action";
  }, [view, from, to]);

  // No AbortController on cleanup: Next's dev overlay reports the abort as a
  // runtime error ("signal is aborted without reason"). A stale response is
  // dropped via `isLive` instead (same pattern as NapkinQualityFlags).
  const load = useCallback(
    async (isLive: () => boolean = () => true) => {
      setLoading(true);
      try {
        const res = await fetch(url, { cache: "no-store" });
        const j = (await res.json()) as Data & { ok?: boolean; error?: string };
        if (!isLive()) return;
        if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
        setErr(null);
        setData(j);
      } catch (e) {
        if (isLive()) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (isLive()) setLoading(false);
      }
    },
    [url],
  );

  useEffect(() => {
    let live = true;
    setData(null);
    setShown(PAGE);
    void load(() => live);
    return () => {
      live = false;
    };
  }, [load]);

  // While older prices are refetched for volume, reload every minute.
  useEffect(() => {
    if (!data || (!data.no_volume && !data.refreshing)) return;
    let live = true;
    const id = window.setInterval(() => void load(() => live), 60_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [data, load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const out = data.rows.filter((r) => {
      if (needle && !`${r.name} ${r.ticker} ${r.sector ?? ""} ${r.industry ?? ""}`.toLowerCase().includes(needle)) return false;
      // Same rule as Value / Trend: blank = no bound, missing market cap counts as 0.
      const mc = r.mcap_cr ?? 0;
      if (Number(minCap) && mc < Number(minCap)) return false;
      if (Number(maxCap) && mc > Number(maxCap)) return false;
      if (exch !== "all" && (r.market || "NSE") !== exch) return false;
      if (view !== "latest" && minDays && r.trending < minDays) return false;
      if (rocket === "any" && !r.rocket_price && !r.rocket_rpi) return false;
      if (rocket === "price" && !r.rocket_price) return false;
      if (rocket === "rpi" && !r.rocket_rpi) return false;
      return true;
    });
    const by: Record<SortKey, (a: Row, b: Row) => number> = {
      trending: (a, b) => b.trending - a.trending || b.streak - a.streak,
      streak: (a, b) => b.streak - a.streak || b.trending - a.trending,
      day: (a, b) => (b.last.day_pct ?? -Infinity) - (a.last.day_pct ?? -Infinity),
      mcap: (a, b) => (b.mcap_cr ?? -1) - (a.mcap_cr ?? -1),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return out.sort((a, b) => by[sort](a, b) || a.name.localeCompare(b.name));
  }, [data, q, minCap, maxCap, exch, minDays, rocket, sort, view]);

  const counts = useMemo(() => {
    const c = { s1: 0, s2: 0, s3: 0, s4: 0 };
    if (view !== "latest") return c;
    for (const r of rows) {
      const b = r.days[r.days.length - 1] ?? 0;
      if (b & 1) c.s1++;
      if (b & 2) c.s2++;
      if (b & 4) c.s3++;
      if (b & 8) c.s4++;
    }
    return c;
  }, [rows, view]);

  const dates = data?.dates ?? [];
  const range = dates.length ? (dates.length === 1 ? shortDate(dates[0]!) : `${shortDate(dates[0]!)} – ${shortDate(dates[dates.length - 1]!)}`) : "";
  const th = (key: SortKey, label: string, cls = "") => (
    <th className={`${cls} pa-sort${sort === key ? " on" : ""}`} onClick={() => setSort(key)} title="Sort">
      {label}
      {sort === key ? " ↓" : ""}
    </th>
  );
  const r = data?.rules;

  return (
    <section className="vx pa">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">Price-volume spurts across stocks and sectors</span>
          <h2 className="vx-title">
            Price Action <span>Screen</span>
          </h2>
        </div>
        <div className="vx-tabs" role="tablist" aria-label="Price action views">
          {(
            [
              ["latest", "Latest"],
              ["2wk", "2WK"],
              ["custom", "Custom dates"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? "on" : ""} onClick={() => {
                setView(id);
                setMinDays(0);
              }}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="vx-card vx-filters">
        <div className="pa-grid">
          <label className="vx-field">
            <span className="vx-label">Search</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Company, symbol or sector" />
          </label>
          <label className="vx-field">
            <span className="vx-label">Min market cap</span>
            <input inputMode="numeric" value={minCap} onChange={(e) => setMinCap(e.target.value.replace(/[^\d.]/g, ""))} placeholder="₹ Cr" />
          </label>
          <label className="vx-field">
            <span className="vx-label">Max market cap</span>
            <input inputMode="numeric" value={maxCap} onChange={(e) => setMaxCap(e.target.value.replace(/[^\d.]/g, ""))} placeholder="₹ Cr" />
          </label>
          <label className="vx-field">
            <span className="vx-label">Exchange</span>
            <select value={exch} onChange={(e) => setExch(e.target.value)}>
              <option value="all">All</option>
              <option value="NSE">NSE</option>
              <option value="NSE SME">NSE SME</option>
              <option value="BSE">BSE</option>
              <option value="BSE SME">BSE SME</option>
            </select>
          </label>
          <label className="vx-field">
            <span className="vx-label">Rockets</span>
            <select value={rocket} onChange={(e) => setRocket(e.target.value)}>
              <option value="all">All stocks</option>
              <option value="any">Any rocket</option>
              <option value="price">🚀 52wk High</option>
              <option value="rpi">🚀 W.RPI</option>
            </select>
          </label>
          {view !== "latest" ? (
            <label className="vx-field">
              <span className="vx-label">Trending days</span>
              <select value={minDays} onChange={(e) => setMinDays(Number(e.target.value))}>
                <option value={0}>Any</option>
                {trendingSteps(data?.dates.length ?? 11).map((n) => (
                  <option key={n} value={n}>
                    {n}+ days
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {view === "custom" ? (
          <div className="pa-range">
              <div className="vx-field">
                <span className="vx-label">Quick range</span>
                <div className="pa-presets" role="group" aria-label="Quick range">
                  {PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={preset === p.id ? "on" : ""}
                      aria-pressed={preset === p.id}
                      onClick={() => pickPreset(p.id, p.days)}
                    >
                      {p.id}
                    </button>
                  ))}
                </div>
              </div>
              <label className="vx-field">
                <span className="vx-label">From</span>
                <input
                  type="date"
                  value={from}
                  max={to}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    setFrom(e.target.value);
                    setPreset(null);
                  }}
                />
              </label>
              <label className="vx-field">
                <span className="vx-label">To</span>
                <input
                  type="date"
                  value={to}
                  min={from}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    setTo(e.target.value);
                    setPreset(null);
                  }}
                />
              </label>
            </div>
        ) : null}
        {r ? (
          <p className="vx-hint pa-rules">
            Green day = any screen passes. <b>S4</b> day up ≥ {r.s4DayPct}% · <b>S3</b> day up ≥ {r.s3DayPct}%, volume ≥ {r.s3VolX}× the
            previous 5-day average and 3M return ≥ {r.s3Ret3mPct}% · <b>S1</b> both S3 and S4 · <b>S2</b> 1M return ≥ {r.s2Ret1mPct}%.
            Thresholds are inferred from the original screen; its S2 has one more condition we can&apos;t see, so S2 here passes more stocks.
            <br />
            🚀 <b>52wk High</b>: closed at a 52-week high in the last {data?.rockets.recentDays ?? 10} trading days. 🚀 <b>W.RPI</b>: relative
            strength vs Nifty 50 (2W, 3M, 6M, 1Y RPI, equal weights) at a 52-week high in the same window. Their W.RPI weights aren&apos;t
            public, so this rocket is an estimate.
          </p>
        ) : null}
      </div>

      {err ? <p className="vx-msg vx-msg--err">Could not load: {err}</p> : null}
      {data && data.no_volume ? (
        <p className="vx-msg">
          Loading daily volume for {data.no_volume.toLocaleString("en-IN")} of {data.universe.toLocaleString("en-IN")} stocks in the
          background. Until it arrives they can&apos;t pass S3. This page reloads every minute.
        </p>
      ) : null}

      <div className="vx-card vx-table-card">
        <div className="vx-table-head">
          <span className="vx-label vx-label--title">
            {data ? `${rows.length.toLocaleString("en-IN")} stocks` : "Stocks"}
            {view === "latest" && data ? ` · S1 ${counts.s1} · S2 ${counts.s2} · S3 ${counts.s3} · S4 ${counts.s4}` : ""}
          </span>
          <span className="vx-hint">
            {loading ? "Loading… " : ""}
            {range ? `${range} · ${dates.length} trading day${dates.length === 1 ? "" : "s"}` : ""}
            {data ? ` · ${data.universe.toLocaleString("en-IN")} stocks scanned` : ""}
          </span>
        </div>
        <div className="vx-scroll">
          <table className="vx-table pa-table">
            <thead>
              {view === "latest" ? (
                <tr>
                  {th("name", "Company")}
                  <th>Rockets</th>
                  <th>Screens</th>
                  <th className="num" title="Estimate: equal weights of 2W, 3M, 6M, 1Y RPI vs Nifty 50">W.RPI</th>
                  {th("day", "Today", "num")}
                  <th className="num">Volume × 5D</th>
                  <th className="num">1M</th>
                  <th className="num">3M</th>
                  <th>Industry</th>
                  {th("mcap", "Market cap", "num")}
                </tr>
              ) : (
                <tr>
                  {th("name", "Company")}
                  <th>Rockets</th>
                  <th>{range}</th>
                  {th("trending", "Trending days", "num")}
                  {th("streak", "Streak", "num")}
                  <th>Industry</th>
                  {th("mcap", "Market cap", "num")}
                  {th("day", "Last day", "num")}
                </tr>
              )}
            </thead>
            <tbody>
              {!data ? (
                <tr>
                  <td colSpan={10} className="vx-empty">
                    {err ? "—" : "Scanning every stock…"}
                  </td>
                </tr>
              ) : !rows.length ? (
                <tr>
                  <td colSpan={10} className="vx-empty">
                    No stocks match.
                  </td>
                </tr>
              ) : (
                rows.slice(0, shown).map((row) =>
                  view === "latest" ? (
                    <tr key={row.ticker}>
                      <Company r={row} />
                      <Rockets r={row} />
                      <td>
                        {screens(row.days[row.days.length - 1] ?? 0).map((s) => (
                          <span key={s} className="pa-tag">
                            {s}
                          </span>
                        ))}
                      </td>
                      <td className="num">{row.wrpi == null ? "—" : row.wrpi.toFixed(1)}</td>
                      <td className={`num ${(row.last.day_pct ?? 0) >= 0 ? "pos" : "neg"}`}>{pct(row.last.day_pct)}</td>
                      <td className="num">
                        {row.last.vol_x == null ? (row.has_volume ? "—" : <span title="Volume still loading">…</span>) : `${row.last.vol_x.toFixed(2)}×`}
                      </td>
                      <td className="num">{pct(row.last.ret_1m, 1)}</td>
                      <td className="num">{pct(row.last.ret_3m, 1)}</td>
                      <Sector r={row} />
                      <Cap r={row} />
                    </tr>
                  ) : (
                    <tr key={row.ticker}>
                      <Company r={row} />
                      <Rockets r={row} />
                      <td>
                        <Dots days={row.days} dates={dates} />
                      </td>
                      <td className="num pa-big">{row.trending}</td>
                      <td className={row.streak ? "num pa-big" : "num pa-zero"}>{row.streak}</td>
                      <Sector r={row} />
                      <Cap r={row} />
                      <td className={`num ${(row.last.day_pct ?? 0) >= 0 ? "pos" : "neg"}`}>{pct(row.last.day_pct)}</td>
                    </tr>
                  ),
                )
              )}
            </tbody>
          </table>
        </div>
        {rows.length > shown ? (
          <div className="vx-actions">
            <button type="button" className="vx-btn" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, rows.length - shown)} more
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
