"use client";

import { Loading } from "@/components/Loading";
import { MultiPick } from "@/components/FilterBar";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TickerSuggest, type TickerSuggestHit } from "@/components/TickerSuggest";
import { isRightsOrPartlyPaid } from "@/lib/listing-name-match";
import { napkinUrl, tradingviewUrl, websiteUrl } from "@/lib/links";
import { ReviewPlusButton } from "@/components/ReviewPlusButton";
import { StockLinks } from "@/components/StockLinks";
import {
  ROTATION_MA_PERIODS,
  ROTATION_RANGES,
  rotationWindowStart,
  windowRebaseSeries,
  windowReturnPct,
} from "@/lib/sector-rotation-series";
import { useUrlEnumParam } from "@/lib/url-enum-param";

const ROTATION_VIEWS = ["grid", "table"] as const;

type Point = { date: string; value: number };

type Card = {
  id: string;
  label: string;
  n: number;
  up?: number;
  down?: number;
  starred?: boolean;
  sector_pct: number | null;
  bench_pct: number | null;
  today_pct?: number | null;
  search?: string;
  /** Member market caps (₹ Cr) for min/max filter. */
  mcaps?: Array<number | null>;
  /** Member tickers (upper) — parallel to mcaps; Nifty 500 filter. */
  tickers?: string[];
  sector: Point[];
  bench: Point[];
  sector_full?: Point[];
  bench_full?: Point[];
  /** Period this sector line was built for; its stock set differs by period. */
  window_range?: string;
  /** StockScans large sector parent. */
  ss_sector?: string | null;
  /** Real basket id to hydrate sparks (rollup cards use largest child). */
  hydrateId?: string;
  /** Industry basket ids under a sector rollup (for watchlist star). */
  childIds?: string[];
};

/** Same rule as Value ranking: blank min/max = no bound; missing mcap counts as 0. */
function mcapInBand(mcap: number | null | undefined, min: number, max: number): boolean {
  const v = mcap ?? 0;
  if (min && v < min) return false;
  if (max && v > max) return false;
  return true;
}

type Member = {
  ticker: string;
  name: string;
  market: string;
  mcap_cr: number | null;
  price: number | null;
  change_pct: number | null;
  window_pct: number | null;
  spark: Point[];
  spark_full?: Point[];
  tv_url: string;
  sales_growth_3y?: number | null;
  roce_3y?: number | null;
  pb?: number | null;
  growth_rank?: number | null;
  roce_rank?: number | null;
  pb_rank?: number | null;
  total_score?: number | null;
  rank?: number | null;
};

type Hit = { ticker: string; name: string; market?: string; source?: string };

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

type ListRow = {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  industry: string | null;
  website: string | null;
  mcap_cr: number | null;
  price: number | null;
  change_pct: number | null;
  window_pct: number | null;
};

/** Table view: a sector's stocks shown inline under its row. */
function SectorStocksRow({
  id,
  range,
  colSpan,
  onOpen,
  minCap,
  maxCap,
  n500Only,
  n500Set,
  vsNifty,
  benchPct,
}: {
  id: string;
  range: string;
  colSpan: number;
  onOpen: () => void;
  minCap: number;
  maxCap: number;
  n500Only: boolean;
  n500Set: Set<string> | null;
  vsNifty: "all" | "out" | "under";
  benchPct: number | null;
}) {
  const [rows, setRows] = useState<ListRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/sector-rotation?id=${encodeURIComponent(id)}&list=1&range=${encodeURIComponent(range)}`,
          { cache: "no-store", signal: ctl.signal },
        );
        const json = (await res.json()) as { ok?: boolean; error?: string; rows?: ListRow[] };
        if (!live) return;
        if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
        setErr(null);
        setRows(json.rows ?? []);
      } catch (e) {
        if (live && !(e instanceof DOMException && e.name === "AbortError"))
          setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
      ctl.abort();
    };
  }, [id, range]);

  const shown = useMemo(() => {
    if (!rows) return null;
    return rows.filter((r) => {
      if (minCap || maxCap) {
        if (!mcapInBand(r.mcap_cr, minCap, maxCap)) return false;
      }
      if (n500Only && n500Set && !n500Set.has(r.ticker.toUpperCase())) return false;
      if (vsNifty !== "all" && benchPct != null) {
        if (r.window_pct == null) return false;
        if (vsNifty === "out" && !(r.window_pct >= benchPct)) return false;
        if (vsNifty === "under" && !(r.window_pct < benchPct)) return false;
      }
      return true;
    });
  }, [rows, minCap, maxCap, n500Only, n500Set, vsNifty, benchPct]);

  return (
    <tr className="rot-xrow">
      <td colSpan={colSpan}>
        {err ? (
          <p className="rot-sub-msg">Could not load stocks: {err}</p>
        ) : !shown ? (
          <Loading label="Loading stocks" />
        ) : !shown.length ? (
          <p className="rot-sub-msg">
            No stocks in this sector
            {minCap || maxCap || n500Only || vsNifty !== "all"
              ? " for this filter"
              : ""}
            .
          </p>
        ) : (
          <div className="rot-sub-wrap">
            <div className="rot-sub-head">
              <span>
                {shown.length} stock{shown.length === 1 ? "" : "s"} · best {range} first
              </span>
              <button type="button" className="rot-sub-open" onClick={onOpen}>
                Open chart &amp; ranking →
              </button>
            </div>
            <table className="rot-sub-table">
              <thead>
                <tr>
                  <th className="rot-sub-rank">#</th>
                  <th>Stock</th>
                  <th className="num">Market cap</th>
                  <th className="num">Price</th>
                  <th className="num">Today</th>
                  <th className="num">{range}</th>
                  <th>Vs Nifty</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const web = websiteUrl(r.website);
                  return (
                    <tr key={r.ticker}>
                      <td className="rot-sub-rank">{i + 1}</td>
                      <td>
                        <div className="rot-sub-line">
                          <a className="rot-sub-name" href={tradingviewUrl(r.ticker, r.market)} target="_blank" rel="noopener noreferrer">
                            {r.name}
                          </a>
                          <span className="rot-sub-tk">{r.ticker}</span>
                          {r.market && r.market !== "NSE" ? <span className="rot-sub-ex">{r.market}</span> : null}
                          <ReviewPlusButton ticker={r.ticker} />
                          <a className="np-chip" href={napkinUrl(r.ticker)} target="_blank" rel="noopener noreferrer" title="Open in Napkin">
                            NP
                          </a>
                          {web ? (
                            <a className="np-chip" href={web} target="_blank" rel="noopener noreferrer" title={r.website ?? ""}>
                              Web
                            </a>
                          ) : null}
                        </div>
                        {r.sector || r.industry ? (
                          <span className="rot-sub-sector">
                            {r.industry ?? r.sector}
                          </span>
                        ) : null}
                      </td>
                      <td className="num">{r.mcap_cr == null ? "—" : `₹${Math.round(r.mcap_cr).toLocaleString("en-IN")} Cr`}</td>
                      <td className="num">{r.price == null ? "—" : `₹${r.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`}</td>
                      <td className={`num ${(r.change_pct ?? 0) >= 0 ? "pos" : "neg"}`}>{fmtPct(r.change_pct)}</td>
                      <td className="num">
                        <span className={r.window_pct == null ? "rot-pill" : r.window_pct >= 0 ? "rot-pill pos" : "rot-pill neg"}>
                          {fmtPct(r.window_pct)}
                        </span>
                      </td>
                      <td>
                        {r.window_pct == null || benchPct == null ? (
                          "—"
                        ) : (
                          <span
                            className={
                              r.window_pct >= benchPct
                                ? "rot-pill pos"
                                : "rot-pill neg"
                            }
                          >
                            {r.window_pct >= benchPct
                              ? "Outperform"
                              : "Underperform"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </td>
    </tr>
  );
}


function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
}



/** Metric with intra-sector rank in parentheses, e.g. 4.18% (9). */

function sma(pts: Point[], n: number): Point[] {
  if (n < 2 || pts.length < n) return [];
  const out: Point[] = [];
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    sum += pts[i]!.value;
    if (i >= n) sum -= pts[i - n]!.value;
    if (i >= n - 1) {
      out.push({ date: pts[i]!.date, value: sum / n });
    }
  }
  return out;
}

/** Extra batches when revealing more (hydrate still chunks at HYDRATE_CHUNK). */
const PAGE_SIZE = 24;
/** Server hydrate cap per request (route slices ids to 24). */
const HYDRATE_CHUNK = 24;

function DualSpark({
  a,
  b,
  width: widthProp,
  height = 120,
  showEnd = true,
  aLabel = "Sector",
  bLabel = "Nifty",
  logScale = false,
  ma = [],
  aAbove = true,
  fill = false,
}: {
  a: Point[];
  b: Point[];
  width?: number;
  height?: number;
  showEnd?: boolean;
  aLabel?: string;
  bLabel?: string;
  logScale?: boolean;
  ma?: number[];
  /** Green when sector ≥ bench, red when below. */
  aAbove?: boolean;
  /** Stretch to parent width (detail chart). */
  fill?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [autoW, setAutoW] = useState(widthProp ?? 320);
  useEffect(() => {
    if (!fill) {
      if (widthProp != null) setAutoW(widthProp);
      return;
    }
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w >= 160) setAutoW(w);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill, widthProp]);
  const width = fill ? autoW : (widthProp ?? 320);
  const aStroke = aAbove ? "#22c55e" : "#ef4444";
  const aFill = aAbove ? "#22c55e" : "#ef4444";
  const aText = aAbove ? "#052e16" : "#450a0a";
  const [hover, setHover] = useState<number | null>(null);
  const plotFrom = b[0]?.date ?? a[0]?.date ?? "";
  const firstVis = a.find((p) => !plotFrom || p.date >= plotFrom);
  const k = firstVis && firstVis.value > 0 ? 100 / firstVis.value : 1;
  const scaledA = a.map((p) => ({ date: p.date, value: p.value * k }));
  const visA = scaledA.filter((p) => !plotFrom || p.date >= plotFrom);
  const visB = b;
  const dates = [...new Set([...visA, ...visB].map((p) => p.date))].sort();
  const mapA = new Map(visA.map((p) => [p.date, p.value]));
  const mapB = new Map(visB.map((p) => [p.date, p.value]));
  const maLines = ma.map((n) => ({
    n,
    pts: sma(scaledA, n).filter((p) => !plotFrom || p.date >= plotFrom),
  }));
  const ys = [
    ...visA,
    ...visB,
    ...maLines.flatMap((m) => m.pts),
  ].map((p) => p.value);
  const rawLo = Math.min(...ys, 80);
  const rawHi = Math.max(...ys, 120);
  const yMap = (v: number) => {
    if (!logScale) return v;
    return Math.log(Math.max(v, 1e-6));
  };
  const lo = yMap(rawLo);
  const hi = yMap(rawHi);
  const pad = (hi - lo) * 0.1 || 2;
  const y0 = lo - pad;
  const y1 = hi + pad;
  const t0 = dates.length
    ? new Date(`${dates[0]}T00:00:00Z`).getTime()
    : 0;
  const t1 = dates.length
    ? new Date(`${dates[dates.length - 1]}T00:00:00Z`).getTime()
    : 1;
  const span = Math.max(1, t1 - t0);
  const left = 8;
  const right = showEnd ? 44 : 8;
  const xAt = (d: string) =>
    left + ((new Date(`${d}T00:00:00Z`).getTime() - t0) / span) * (width - left - right);
  const yAt = (v: number) =>
    height - 14 - ((yMap(v) - y0) / (y1 - y0)) * (height - 22);
  const line = (pts: Point[]) =>
    pts.length < 2
      ? ""
      : pts
          .map(
            (p, i) =>
              `${i === 0 ? "M" : "L"}${xAt(p.date).toFixed(1)} ${yAt(p.value).toFixed(1)}`,
          )
          .join(" ");
  const lastA = visA[visA.length - 1];
  const lastB = visB[visB.length - 1];
  const hoverDate = hover != null ? dates[hover] : null;
  const ha = hoverDate ? mapA.get(hoverDate) : null;
  const hb = hoverDate ? mapB.get(hoverDate) : null;
  return (
    <div
      ref={wrapRef}
      className={fill ? "rot-spark-wrap rot-spark-wrap--fill" : "rot-spark-wrap"}
    >
      <svg
        className="rot-spark"
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * width;
          let best = 0;
          let bestD = 1e9;
          dates.forEach((d, i) => {
            const dx = Math.abs(xAt(d) - x);
            if (dx < bestD) {
              bestD = dx;
              best = i;
            }
          });
          setHover(best);
        }}
      >
        {line(visB) ? (
          <path
            d={line(visB)}
            fill="none"
            stroke="#94a3b8"
            strokeDasharray="3 3"
            strokeWidth="1.5"
          />
        ) : null}
        {maLines.map((m) =>
          line(m.pts) ? (
            <path
              key={m.n}
              d={line(m.pts)}
              fill="none"
              stroke={m.n === 20 ? "#38bdf8" : m.n === 50 ? "#a78bfa" : "#f59e0b"}
              strokeWidth="1.2"
              opacity="0.85"
            />
          ) : null,
        )}
        {line(visA) ? (
          <path d={line(visA)} fill="none" stroke={aStroke} strokeWidth="2" />
        ) : null}
        {lastA && showEnd ? (
          <g>
            <rect
              x={width - 42}
              y={yAt(lastA.value) - 9}
              width="40"
              height="16"
              rx="3"
              fill={aFill}
            />
            <text
              x={width - 22}
              y={yAt(lastA.value) + 3}
              textAnchor="middle"
              fontSize="10"
              fill={aText}
            >
              {lastA.value.toFixed(1)}
            </text>
          </g>
        ) : null}
        {lastB && showEnd ? (
          <g>
            <rect
              x={width - 42}
              y={yAt(lastB.value) - 9}
              width="40"
              height="16"
              rx="3"
              fill="#64748b"
            />
            <text
              x={width - 22}
              y={yAt(lastB.value) + 3}
              textAnchor="middle"
              fontSize="10"
              fill="#fff"
            >
              {lastB.value.toFixed(1)}
            </text>
          </g>
        ) : null}
        {hoverDate ? (
          <line
            x1={xAt(hoverDate)}
            x2={xAt(hoverDate)}
            y1={8}
            y2={height - 12}
            stroke="#64748b"
            strokeDasharray="2 2"
          />
        ) : null}
      </svg>
      <div className="rot-legend">
        <span className="rot-leg-a">{aLabel}</span>
        <span className="rot-leg-b">{bLabel}</span>
        {hoverDate ? (
          <span className="rot-hover">
            {hoverDate}
            {ha != null ? ` · ${ha.toFixed(1)}` : ""}
            {hb != null ? ` / ${hb.toFixed(1)}` : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function MiniSpark({ pts }: { pts: Point[] }) {
  if (pts.length < 2) return null;
  const up = (pts[pts.length - 1]?.value ?? 0) >= (pts[0]?.value ?? 0);
  const w = 72;
  const h = 22;
  const ys = pts.map((p) => p.value);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const d = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - ((p.value - lo) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="rot-mini" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path d={d} fill="none" stroke={up ? "#22c55e" : "#ef4444"} strokeWidth="1.6" />
    </svg>
  );
}

/** Roll industry baskets up to StockScans sector cards for the Sectors filter. */
function rollupSectorCards(industries: Card[]): Card[] {
  const by = new Map<string, Card[]>();
  for (const c of industries) {
    const key = (c.ss_sector || "").trim() || c.label;
    const list = by.get(key) ?? [];
    list.push(c);
    by.set(key, list);
  }
  const out: Card[] = [];
  for (const [label, list] of by) {
    if (list.length === 1 && (list[0].ss_sector || "").trim() === "") {
      out.push(list[0]);
      continue;
    }
    const n = list.reduce((s, c) => s + (c.n || 0), 0);
    const up = list.reduce((s, c) => s + (c.up || 0), 0);
    const down = list.reduce((s, c) => s + (c.down || 0), 0);
    const withPct = list.filter((c) => c.sector_pct != null);
    const sector_pct =
      withPct.length === 0
        ? null
        : withPct.reduce((s, c) => s + (c.sector_pct as number) * (c.n || 1), 0) /
          Math.max(
            1,
            withPct.reduce((s, c) => s + (c.n || 1), 0),
          );
    const bench_pct = list.find((c) => c.bench_pct != null)?.bench_pct ?? null;
    const todayRows = list.filter((c) => c.today_pct != null);
    const today_pct =
      todayRows.length === 0
        ? null
        : todayRows.reduce((s, c) => s + (c.today_pct as number), 0) /
          todayRows.length;
    // Prefer the largest industry's chart; hydrate that real basket id.
    const chartSrc = [...list].sort((a, b) => (b.n || 0) - (a.n || 0))[0];
    out.push({
      id: `rollup:${label}`,
      label,
      n,
      up,
      down,
      starred: list.some((c) => c.starred),
      sector_pct,
      bench_pct,
      today_pct,
      search: list.map((c) => c.search || c.label).join(" "),
      mcaps: list.flatMap((c) => c.mcaps || []),
      tickers: list.flatMap((c) => c.tickers || []),
      sector: chartSrc?.sector || [],
      bench: chartSrc?.bench || [],
      sector_full: chartSrc?.sector_full,
      bench_full: chartSrc?.bench_full,
      window_range: chartSrc?.window_range,
      ss_sector: label,
      hydrateId: chartSrc?.id,
      childIds: list.map((c) => c.id),
    });
  }
  return out;
}

export function SectorRotationPanel() {
  const [range, setRange] = useState("6M");
  const [cards, setCards] = useState<Card[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [benchLabel, setBenchLabel] = useState(
    "Nifty 500",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    card: Card;
    members: Member[];
  } | null>(null);
  const [newName, setNewName] = useState("");
  const [newTickers, setNewTickers] = useState<Hit[]>([]);
  const [newQ, setNewQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [addQ, setAddQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [filter] = useState("");
  const [stockFilter, setStockFilter] = useState("");
  /** Hide thin sectors / industries (same idea as Value / Micro Min companies). */
  const [minN, setMinN] = useState(2);
  const MIN_N_OPTS = [1, 2, 3, 5, 10] as const;
  /** Market cap band (₹ Cr) — same defaults as Value ranking. */
  const [minCap, setMinCap] = useState("200");
  const [maxCap, setMaxCap] = useState("");
  /** Optional multi-pick (advanced); primary filters are type + movers below. */
  const [pickedSec, setPickedSec] = useState<string[]>([]);
  /** All / Top 20 / Bottom 20 by period return. */
  const [boardFilter, setBoardFilter] = useState<"all" | "top" | "bottom">("all");
  /** Watchlist only (starred baskets). */
  const [watchOnly, setWatchOnly] = useState(false);
  /** Sectors (default) / Industries / All. */
  const [typeFilter, setTypeFilter] = useState<"all" | "sector" | "industry">(
    "sector",
  );
  /** Side drawer: show every member vs top 10. */
  const [drawerAll, setDrawerAll] = useState(false);
  /** Always show all vs Nifty 500 (benchmark); no Outperform/Underperform filter. */
  const [vsNifty] = useState<"all" | "out" | "under">("all");
  /** Universe is not restricted to Nifty 500; benchmark is always Nifty 500. */
  const n500Only = false as boolean;
  const n500Set = null as Set<string> | null;
  const [sortKey, setSortKey] = useState<"return" | "today" | "name" | "n">(
    "return",
  );
  const [scale, setScale] = useState<"lin" | "log">("lin");
  const [maOn, setMaOn] = useState<number[]>([]);
  const [weight, setWeight] = useState<"equal" | "cap">("equal");
  const [memberQ, setMemberQ] = useState("");
  const [view, setView] = useUrlEnumParam("rot", ROTATION_VIEWS, "grid");
  /** Table view: sectors expanded to show their stocks inline. */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const [page, setPage] = useState(0);
  const [boardTick, setBoardTick] = useState(0);
  const [hydrating, setHydrating] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [ranking, setRanking] = useState(false);
  /** One pull per weight: all range chips’ returns. Range switches are local. */
  const [rankTable, setRankTable] = useState<{
    weight: string;
    as_of: string | null;
    bench: Record<string, number | null>;
    byId: Record<string, Record<string, number | null>>;
  } | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [shotBusy, setShotBusy] = useState(false);
  const [shotQueued, setShotQueued] = useState(0);
  const [shotPreview, setShotPreview] = useState<string | null>(null);
  const [shotDrag, setShotDrag] = useState(false);
  const [shotLog, setShotLog] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const hydrateGen = useRef(0);
  const rankGen = useRef(0);
  const detailGen = useRef(0);
  const shotUrl = useRef<string | null>(null);
  const shotWell = useRef<HTMLDivElement>(null);
  const shotQueue = useRef<File[]>([]);
  const shotRunning = useRef(false);
  const fromShotRef = useRef<(file: File) => void>(() => {});
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const openIdRef = useRef<string | null>(null);

  const loadBoard = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    if (!opts?.silent) setError(null);
    try {
      const res = await fetch("/api/sector-rotation?lite=1", {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        sectors?: Card[];
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      const next = json.sectors ?? [];
      // Keep period returns + sparklines so filter / star / silent reloads do not
      // wipe charts or force a full re-rank.
      setCards((prev) => {
        const prevById = new Map(prev.map((c) => [c.id, c] as const));
        return next.map((c) => {
          const p = prevById.get(c.id);
          if (!p) return c;
          return {
            ...c,
            sector_pct: p.sector_pct,
            bench_pct: p.bench_pct,
            today_pct: c.today_pct ?? p.today_pct,
            up: c.up ?? p.up,
            down: c.down ?? p.down,
            sector: p.sector?.length ? p.sector : c.sector,
            bench: p.bench?.length ? p.bench : c.bench,
            sector_full: p.sector_full ?? c.sector_full,
            bench_full: p.bench_full ?? c.bench_full,
            window_range: p.window_range,
            ss_sector: c.ss_sector ?? p.ss_sector,
          };
        });
      });
      setBoardTick((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(
    async (id: string) => {
      // Opening A then B quickly: only the newest request may paint.
      const gen = ++detailGen.current;
      setError(null);
      setDetailLoading(true);
      try {
        const res = await fetch(
          `/api/sector-rotation?id=${encodeURIComponent(id)}&range=${encodeURIComponent(rangeRef.current)}&weight=${encodeURIComponent(weight)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          card?: Card;
          members?: Member[];
        };
        if (gen !== detailGen.current || openIdRef.current !== id) return;
        if (!res.ok || json.ok === false || !json.card) {
          throw new Error(json.error || `HTTP ${res.status}`);
        }
        setDetail({ card: json.card, members: json.members ?? [] });
      } catch (e) {
        if (gen !== detailGen.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (gen === detailGen.current) setDetailLoading(false);
      }
    },
    [weight],
  );

  const refreshBoard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sector-rotation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refreshMetrics: true,
          ...(openId ? { id: openId } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || `Refresh failed (${res.status})`);
      }
      // Reload detail after metrics upsert so price / today % / OHLC paint.
      if (openId) await loadDetail(openId);
      await loadBoard({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [openId, loadBoard, loadDetail]);


  const rankedReady = rankTable?.weight === weight;

  // Weight changes the basket index — drop ranks + series so we pull once again.
  useEffect(() => {
    setRankTable(null);
    setCards((prev) =>
      prev.map((c) => ({
        ...c,
        sector_pct: null,
        bench_pct: null,
        sector: [],
        bench: [],
        sector_full: undefined,
        bench_full: undefined,
        window_range: undefined,
      })),
    );
  }, [weight]);

  // Range chip: only clear charts. Returns come from rankTable (one pull).
  useEffect(() => {
    setCards((prev) =>
      prev.map((c) =>
        c.window_range === range
          ? c
          : {
              ...c,
              sector: [],
              bench: [],
              sector_full: undefined,
              bench_full: undefined,
              window_range: undefined,
            },
      ),
    );
  }, [range]);

  // Apply the selected range’s returns from the one-shot rank table.
  useEffect(() => {
    if (!rankTable || rankTable.weight !== weight) return;
    const key = range.toUpperCase();
    const bench = rankTable.bench[key] ?? null;
    setCards((prev) =>
      prev.map((c) => ({
        ...c,
        sector_pct: rankTable.byId[c.id]?.[key] ?? null,
        bench_pct: bench,
      })),
    );
  }, [rankTable, range, weight]);

  // Rebase open-sector member sparks when asOf / range is known.
  useEffect(() => {
    if (!asOf) return;
    const start = rotationWindowStart(asOf, range);
    setDetail((prev) => {
      if (!prev) return prev;
      const stale = prev.card.window_range !== range;
      return {
        card: stale
          ? { ...prev.card, sector_pct: null, bench_pct: null, sector: [], bench: [] }
          : prev.card,
        members: prev.members.map((m) => {
          const full =
            m.spark_full && m.spark_full.length > 0 ? m.spark_full : m.spark;
          if (!full.length) return { ...m, window_pct: null };
          return {
            ...m,
            spark: windowRebaseSeries(full, start),
            // Blank when history is shorter than the range, never last range's value.
            window_pct: windowReturnPct(full, start),
            spark_full: m.spark_full ?? full,
          };
        }),
      };
    });
  }, [range, asOf]);

  // Pull board-wide returns once per weight (all range chips in one response).
  useEffect(() => {
    if (rankTable?.weight === weight) return;
    const gen = ++rankGen.current;
    setRanking(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/sector-rotation?rank=1&weight=${encodeURIComponent(weight)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          as_of?: string | null;
          bench_label?: string;
          range?: string;
          bench?: Record<string, number | null>;
          returns?: Record<string, Record<string, number | null>>;
          sectors?: Array<{ id: string; sector_pct: number | null; bench_pct: number | null }>;
        };
        if (gen !== rankGen.current) return;
        if (!res.ok || json.ok === false) {
          throw new Error(json.error || `HTTP ${res.status}`);
        }
        setAsOf(json.as_of ?? null);
        setBenchLabel(json.bench_label || "Nifty 500");
        let byId = json.returns ?? {};
        let bench = json.bench ?? {};
        // Older server shape: only one range — still usable once.
        if (!Object.keys(byId).length && json.sectors?.length) {
          const key = (json.range || "6M").toUpperCase();
          byId = {};
          for (const s of json.sectors) {
            byId[s.id] = { [key]: s.sector_pct };
          }
          bench = { [key]: json.sectors[0]?.bench_pct ?? null };
        }
        setRankTable({
          weight,
          as_of: json.as_of ?? null,
          bench,
          byId,
        });
      } catch (e) {
        if (gen !== rankGen.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (gen === rankGen.current) setRanking(false);
      }
    })();
  }, [rankTable, weight]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    openIdRef.current = openId;
  }, [openId]);

  useEffect(() => {
    if (openId) void loadDetail(openId);
  }, [openId, loadDetail]);

  // Refetch the open sector when its line was built for another period.
  useEffect(() => {
    if (!openId || !asOf) return;
    const d = detailRef.current;
    if (!d || d.card.id !== openId || d.card.window_range === range) return;
    void loadDetail(openId);
  }, [range, openId, asOf, loadDetail]);

  const pickCreateTicker = (h: TickerSuggestHit) => {
    setNewTickers((rows) =>
      rows.some((x) => x.ticker === h.ticker) ? rows : [...rows, h],
    );
    setNewQ("");
  };

  const create = async () => {
    const label = newName.replace(/\s+/g, " ").trim();
    if (label.length < 2 || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/sector-rotation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ create: true, label }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        sector?: { id: string };
      };
      if (!res.ok || !json.sector?.id) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setNewName("");
      setNewTickers([]);
      setNewQ("");
      setAdding(false);
      setOpenId(json.sector.id);
      openIdRef.current = json.sector.id;
      const failed: string[] = [];
      for (const h of newTickers) {
        const add = await fetch("/api/sector-rotation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: json.sector.id,
            add: true,
            ticker: h.ticker,
            name: h.name,
            market: h.market || "NSE",
          }),
        }).catch(() => null);
        const addJson = add
          ? ((await add.json().catch(() => ({}))) as { ok?: boolean })
          : null;
        if (!add || !add.ok || addJson?.ok === false) failed.push(h.ticker);
      }
      await loadBoard();
      await loadDetail(json.sector.id);
      if (failed.length) {
        setError(`Sector created, but could not add: ${failed.join(", ")}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const runScreenshot = useCallback(async (file: File, priorIndustry = "") => {
    if (file.type && !file.type.startsWith("image/") && file.type) return;
    if (shotUrl.current) URL.revokeObjectURL(shotUrl.current);
    const url = URL.createObjectURL(file);
    shotUrl.current = url;
    setShotPreview(url);
    setError(null);
    setShotLog((prev) => [
      ...prev,
      `— Screenshot (${file.name || "paste"}) —`,
      "Reading screenshot…",
    ]);
    const pushLog = (line: string) =>
      setShotLog((prev) => [...prev, line]);
    try {
      const form = new FormData();
      form.set("file", file);
      if (priorIndustry) form.set("priorIndustry", priorIndustry);
      const res = await fetch("/api/sector-rotation/screenshot", {
        method: "POST",
        body: form,
      });
      if (!res.body) throw new Error("No progress stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let donePayload: {
        industry?: string;
        unresolved?: string[];
        sector?: { id: string; label: string; members?: unknown[] };
        sectors?: Array<{ id: string; label: string; members?: unknown[] }>;
      } | null = null;
      let streamError: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const raw of parts) {
          const line = raw.trim();
          if (!line) continue;
          let ev: {
            t?: string;
            industry?: string;
            names?: string[];
            query?: string;
            ticker?: string;
            name?: string;
            label?: string;
            n?: number;
            extracted?: number;
            resolved?: number;
            unresolved?: string[] | number;
            before?: number;
            after?: number;
            error?: string;
            sector?: { id: string; label: string; members?: unknown[] };
            sectors?: Array<{ id: string; label: string; members?: unknown[] }>;
          };
          try {
            ev = JSON.parse(line) as typeof ev;
          } catch {
            continue;
          }
          if (ev.t === "ocr") {
            setShotLog((prev) => {
              const last = prev[prev.length - 1] || "";
              if (last.startsWith("OCR")) {
                return [...prev, "OCR still running (vision model)…"];
              }
              return [...prev, "OCR (vision; often 30–90s)…"];
            });
          }
          else if (ev.t === "parsed") {
            pushLog(
              `Industry “${ev.industry}” · ${ev.names?.length ?? 0} names`,
            );
          } else if (ev.t === "hit") {
            pushLog(`${ev.query} → ${ev.ticker}`);
          } else if (ev.t === "dup") {
            pushLog(`${ev.query} already ${ev.ticker}`);
          } else if (ev.t === "miss") {
            pushLog(`Unresolved: ${ev.query}`);
          } else if (ev.t === "count") {
            const extracted = ev.extracted ?? 0;
            const resolved = ev.resolved ?? 0;
            const missed = typeof ev.unresolved === "number" ? ev.unresolved : 0;
            const before = ev.before ?? 0;
            const after = ev.after ?? 0;
            const added = Math.max(0, after - before);
            pushLog(
              `Count: OCR ${extracted} · matched ${resolved} · missed ${missed} · basket ${before} → ${after} (+${added})`,
            );
            if (extracted !== resolved + missed) {
              pushLog(
                `Count mismatch: OCR ${extracted} vs matched+missed ${resolved + missed}`,
              );
            }
          } else if (ev.t === "save") {
            pushLog(`Saved ${ev.n} stocks in “${ev.label}”`);
          } else if (ev.t === "done") {
            donePayload = {
              industry: ev.industry,
              unresolved: ev.unresolved as string[] | undefined,
              sector: ev.sector,
              sectors: ev.sectors,
            };
          } else if (ev.t === "error") {
            streamError = ev.error || "Extract failed";
          }
        }
      }
      if (streamError) throw new Error(streamError);
      const json = donePayload;
      if (!json?.sector?.id) {
        throw new Error("Screenshot import did not finish");
      }
      setNewName("");
      if ((json.sectors?.length ?? 0) > 1) {
        pushLog(
          `Filled ${json.sectors!.length} sectors: ${json
            .sectors!.map((s) => `${s.label} (${s.members?.length ?? 0})`)
            .join(" · ")} — opening the largest`,
        );
      }
      setOpenId(json.sector.id);
      const saved = (json.sector.members ?? []) as Array<{
        ticker?: string;
        name?: string;
        market?: string;
      }>;
      if (saved.length) {
        setDetail({
          card: {
            id: json.sector.id,
            label: json.sector.label,
            n: saved.length,
            sector_pct: null,
            bench_pct: null,
            sector: [],
            bench: [],
          },
          members: saved
            .filter((m) => (m.ticker || "").trim())
            .map((m) => ({
              ticker: String(m.ticker).toUpperCase(),
              name: m.name || String(m.ticker),
              market: m.market || "NSE",
              mcap_cr: null,
              price: null,
              change_pct: null,
              window_pct: null,
              spark: [],
              tv_url: "",
            })),
        });
      }
      pushLog("Refreshing board…");
      await Promise.all([
        loadBoard({ silent: true }),
        loadDetail(json.sector.id),
      ]);
      pushLog("Done");
      return (
        json.industry ||
        json.sector.label ||
        ""
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setShotLog((prev) => [...prev, `Failed: ${msg}`]);
      return "";
    }
  }, [loadBoard, loadDetail]);

  const enqueueShot = useCallback((file: File) => {
    if (file.type && !file.type.startsWith("image/") && file.type) return;
    setAdding(true);
    shotQueue.current.push(file);
    setShotQueued(shotQueue.current.length);
    if (shotRunning.current) return;
    shotRunning.current = true;
    setShotBusy(true);
    void (async () => {
      let batchIndustry = "";
      try {
        while (shotQueue.current.length) {
          const next = shotQueue.current.shift()!;
          setShotQueued(shotQueue.current.length);
          const label = await runScreenshot(next, batchIndustry);
          if (label) batchIndustry = label;
        }
      } finally {
        shotRunning.current = false;
        setShotBusy(false);
      }
    })();
  }, [runScreenshot]);

  fromShotRef.current = (file: File) => {
    enqueueShot(file);
  };

  useEffect(() => {
    shotWell.current?.focus();
  }, []);

  useEffect(() => {
    function imageFromPaste(e: ClipboardEvent): File | null {
      const cd = e.clipboardData;
      if (!cd) return null;
      for (const item of [...cd.items]) {
        if (!item.type.startsWith("image/")) continue;
        const f = item.getAsFile();
        if (f) return f;
      }
      for (const f of [...cd.files]) {
        if (f.type.startsWith("image/") || !f.type) return f;
      }
      return null;
    }
    function onDocPaste(e: ClipboardEvent) {
      const file = imageFromPaste(e);
      if (!file) return;
      e.preventDefault();
      fromShotRef.current(file);
    }
    window.addEventListener("paste", onDocPaste);
    return () => window.removeEventListener("paste", onDocPaste);
  }, []);

  const addTicker = async (h: Hit) => {
    if (!openId) return;
    setError(null);
    setAddQ("");
    if (isRightsOrPartlyPaid(h.ticker, h.name)) {
      setError(
        `Skip ${h.ticker}: partly-paid / rights lines are not full equity`,
      );
      return;
    }
    const res = await fetch("/api/sector-rotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: openId,
        add: true,
        ticker: h.ticker,
        name: h.name,
        market: h.market || "NSE",
      }),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) {
      setError(json.error || `HTTP ${res.status}`);
      return;
    }
    setAddQ("");
    await loadDetail(openId);
    void loadBoard({ silent: true });
  };

  const removeTicker = async (ticker: string) => {
    if (!openId) return;
    const res = await fetch("/api/sector-rotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: openId, remove: true, ticker }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || json.ok === false) {
      setError(json.error || `Could not remove ${ticker} (${res.status})`);
      return;
    }
    await Promise.all([loadBoard({ silent: true }), loadDetail(openId)]);
  };

  const openCard = detail?.card;
  const minCapN = Number(minCap) || 0;
  const maxCapN = Number(maxCap) || 0;
  const sortedCards = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const stock = stockFilter.trim().toLowerCase();
    const capOn = !!(minCapN || maxCapN);
    const idxOn = n500Only && !!n500Set;
    let rows = [...cards]
      .map((c) => {
        if (!capOn && !idxOn) return c;
        const mcaps = c.mcaps || [];
        const tickers = c.tickers || [];
        let n = 0;
        const len = Math.max(mcaps.length, tickers.length, c.n || 0);
        for (let i = 0; i < len; i++) {
          if (capOn && !mcapInBand(mcaps[i] ?? null, minCapN, maxCapN)) continue;
          if (idxOn && !n500Set!.has((tickers[i] || "").toUpperCase())) continue;
          n += 1;
        }
        return n === c.n ? c : { ...c, n };
      })
      .filter((c) => {
      if ((c.n ?? 0) < minN) return false;
      if (needle && !c.label.toLowerCase().includes(needle)) return false;
      if (pickedSec.length && !pickedSec.includes(c.label)) return false;
      if (stock && !c.label.toLowerCase().includes(stock) && !(c.search || "").includes(stock)) {
        return false;
      }
      return true;
    });
    const byReturn = (a: Card, b: Card) =>
      (b.sector_pct ?? -Infinity) - (a.sector_pct ?? -Infinity);
    // Sectors with no members can't chart — keep them after real sectors.
    rows = [...rows.filter((c) => c.n > 0), ...rows.filter((c) => !(c.n > 0))];

    // Sectors view: roll industries up by StockScans parent sector.
    if (typeFilter === "sector" || typeFilter === "all") {
      const sectorCards = rollupSectorCards(rows);
      if (typeFilter === "sector") rows = sectorCards;
      else {
        // All = sector rollups first, then industries (dedupe labels).
        const seen = new Set(sectorCards.map((c) => c.label.toLowerCase()));
        rows = [
          ...sectorCards,
          ...rows.filter((c) => !seen.has(c.label.toLowerCase())),
        ];
      }
    }
    // typeFilter === "industry" keeps industry baskets as-is.
    // Watchlist after rollup so sector cards (starred if any child is) filter correctly.
    if (watchOnly) rows = rows.filter((c) => c.starred);

    // Top/Bottom need returns. Prefer board-wide ranks for this range; until
    // they land, keep showing provisional pcts (previous range / hydrate) so
    // the grid is never empty for a minute.
    if (
      (boardFilter === "top" ||
        boardFilter === "bottom" ||
        vsNifty !== "all") &&
      !rankedReady &&
      !rows.some((c) => c.sector_pct != null)
    ) {
      return [];
    }
    if (vsNifty === "out") {
      rows = rows.filter(
        (c) =>
          c.sector_pct != null &&
          c.bench_pct != null &&
          c.sector_pct >= c.bench_pct,
      );
    } else if (vsNifty === "under") {
      rows = rows.filter(
        (c) =>
          c.sector_pct != null &&
          c.bench_pct != null &&
          c.sector_pct < c.bench_pct,
      );
    }
    // Top/Bottom always by period return, whatever the display sort.
    if (boardFilter === "top" || boardFilter === "bottom") {
      const ranked = rows.filter((c) => c.sector_pct != null).sort(byReturn);
      rows =
        boardFilter === "top" ? ranked.slice(0, 20) : ranked.slice(-20).reverse();
    } else if (sortKey === "return") {
      // After rollup: Map insertion order ≠ return order.
      rows.sort(byReturn);
    } else if (sortKey === "today") {
      rows.sort((a, b) => (b.today_pct ?? -999) - (a.today_pct ?? -999));
    } else if (sortKey === "name") {
      rows.sort((a, b) => a.label.localeCompare(b.label));
    } else if (sortKey === "n") {
      rows.sort((a, b) => b.n - a.n);
    }
    return rows;
  }, [cards, filter, stockFilter, minN, minCapN, maxCapN, boardFilter, watchOnly, typeFilter, vsNifty, sortKey, rankedReady, pickedSec, n500Only, n500Set]);

  /** Top/Bottom with no provisional returns yet — empty state, not "No sectors". */
  const rankingWait =
    (boardFilter === "top" || boardFilter === "bottom" || vsNifty !== "all") &&
    !rankedReady &&
    !cards.some((c) => c.sector_pct != null);

  // Single key so adding a filter later does not change useEffect dep length (HMR).
  const pageResetKey = [
    filter,
    stockFilter,
    minN,
    minCap,
    maxCap,
    boardFilter,
    watchOnly,
    typeFilter,
    vsNifty,
    n500Only,
    sortKey,
    pickedSec.join("\0"),
  ].join("|");
  useEffect(() => {
    setPage(0);
  }, [pageResetKey]);

  // Top / Bottom 20 always fit in one batch. Otherwise show the full filtered
  // list (Sectors + Industries) — no "24 of N" pager. Charts hydrate in chunks.
  const pageSize =
    boardFilter === "top" || boardFilter === "bottom" ? 20 : PAGE_SIZE;
  const showAll = boardFilter !== "top" && boardFilter !== "bottom";
  const shownCount = showAll
    ? sortedCards.length
    : Math.min(sortedCards.length, (page + 1) * pageSize);
  const pageCards = sortedCards.slice(0, shownCount);
  // Hydrate real basket ids (rollup cards point at largest child via hydrateId).
  const pageIds = pageCards
    .map((c) => c.hydrateId || c.id)
    .filter((id) => id && !id.startsWith("rollup:"))
    .join(",");

  useEffect(() => {
    if (!pageIds) {
      hydrateGen.current += 1;
      setHydrating(false);
      return;
    }
    const ids = pageIds.split(",").filter(Boolean);
    const byId = new Map(cardsRef.current.map((c) => [c.id, c]));
    const missing = ids.filter((id) => byId.get(id)?.window_range !== range);
    if (!missing.length) {
      hydrateGen.current += 1;
      setHydrating(false);
      return;
    }
    const gen = ++hydrateGen.current;
    setHydrating(true);
    // Route hydrates ≤24 ids per call — fetch larger reveals in batches.
    const chunks: string[][] = [];
    for (let i = 0; i < missing.length; i += HYDRATE_CHUNK) {
      chunks.push(missing.slice(i, i + HYDRATE_CHUNK));
    }
    void (async () => {
      try {
       for (const chunk of chunks) {
        if (gen !== hydrateGen.current) return;
        const hydrateIds = chunk.join(",");
        const res = await fetch(
          `/api/sector-rotation?hydrate=${encodeURIComponent(hydrateIds)}&range=${encodeURIComponent(range)}&weight=${encodeURIComponent(weight)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          as_of?: string | null;
          bench_label?: string;
          sectors?: Card[];
        };
        if (gen !== hydrateGen.current) return;
        if (!res.ok || json.ok === false) {
          throw new Error(json.error || `HTTP ${res.status}`);
        }
        setAsOf(json.as_of ?? null);
        setBenchLabel(json.bench_label || "Nifty 500");
        const next = new Map((json.sectors ?? []).map((c) => [c.id, c]));
        setCards((prev) =>
          prev.map((c) => {
            const r = next.get(c.id);
            if (!r) return c;
            // Merge so a slow hydrate does not clobber fresher board ranks.
            return {
              ...c,
              ...r,
              sector_pct: r.sector_pct ?? c.sector_pct,
              bench_pct: r.bench_pct ?? c.bench_pct,
              today_pct: r.today_pct ?? c.today_pct,
              starred: c.starred,
              ss_sector: r.ss_sector ?? c.ss_sector,
            };
          }),
        );
      }
      } catch (e) {
        if (gen !== hydrateGen.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (gen === hydrateGen.current) setHydrating(false);
      }
    })();
  }, [pageIds, range, weight, boardTick]);

  const stocksShown = useMemo(
    () => sortedCards.reduce((sum, c) => sum + (c.n || 0), 0),
    [sortedCards],
  );
  /** Members ranked by their return over the selected period (highest first). */
  const byReturnMembers = useMemo(
    () =>
      [...(detail?.members ?? [])].sort(
        (a, b) => (b.window_pct ?? -Infinity) - (a.window_pct ?? -Infinity),
      ),
    [detail?.members],
  );

  const shownMembers = useMemo(() => {
    const needle = memberQ.trim().toLowerCase();
    const bench = openCard?.bench_pct ?? null;
    let rows = byReturnMembers;
    if (minCapN || maxCapN) {
      rows = rows.filter((m) => mcapInBand(m.mcap_cr, minCapN, maxCapN));
    }
    if (n500Only && n500Set) {
      rows = rows.filter((m) => n500Set.has(m.ticker.toUpperCase()));
    }
    if (vsNifty !== "all" && bench != null) {
      rows = rows.filter((m) => {
        if (m.window_pct == null) return false;
        return vsNifty === "out"
          ? m.window_pct >= bench
          : m.window_pct < bench;
      });
    }
    if (!needle) return rows;
    return rows.filter(
      (m) =>
        m.ticker.toLowerCase().includes(needle) ||
        m.name.toLowerCase().includes(needle),
    );
  }, [
    byReturnMembers,
    memberQ,
    minCapN,
    maxCapN,
    n500Only,
    n500Set,
    vsNifty,
    openCard?.bench_pct,
  ]);


  const closeSector = useCallback(() => {
    detailGen.current += 1;
    setDetailLoading(false);
    setOpenId(null);
    setDetail(null);
    setAddQ("");
    setMemberQ("");
    setEditLabel("");
    setDrawerAll(false);
  }, []);

  const openCardById = useCallback(
    (c: Card) => {
      setDrawerAll(false);
      if (c.id.startsWith("rollup:")) {
        const kids = cards.filter(
          (x) =>
            (x.ss_sector || "").trim() === c.label || x.label === c.label,
        );
        const best = [...kids].sort((a, b) => (b.n || 0) - (a.n || 0))[0];
        if (best) setOpenId(best.id);
        return;
      }
      setOpenId(c.id);
    },
    [cards],
  );

  useEffect(() => {
    if (openCard?.label) setEditLabel(openCard.label);
  }, [openCard?.label, openId]);

  const saveLabel = async () => {
    const label = editLabel.replace(/\s+/g, " ").trim();
    if (!openId || label.length < 2 || label === openCard?.label) return;
    const res = await fetch("/api/sector-rotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: openId, rename: true, label }),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) {
      setError(json.error || `HTTP ${res.status}`);
      return;
    }
    await Promise.all([loadBoard({ silent: true }), loadDetail(openId)]);
  };

  const deleteOpenSector = async () => {
    if (!openId) return;
    const label = (editLabel || openCard?.label || "this sector").trim();
    if (!window.confirm(`Delete sector “${label}”?`)) return;
    const res = await fetch("/api/sector-rotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: openId, deleteSector: true }),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) {
      setError(json.error || `HTTP ${res.status}`);
      return;
    }
    closeSector();
    await loadBoard({ silent: true });
  };

  const toggleStar = async (
    id: string,
    next: boolean,
    childIds?: string[],
  ) => {
    const ids =
      childIds && childIds.length
        ? childIds
        : id.startsWith("rollup:")
          ? []
          : [id];
    if (!ids.length) return;
    const want = new Set(ids);
    const set = (v: boolean) =>
      setCards((prev) =>
        prev.map((c) => (want.has(c.id) ? { ...c, starred: v } : c)),
      );
    set(next);
    try {
      for (const sid of ids) {
        const res = await fetch("/api/sector-rotation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: sid, star: true, starred: next }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!res.ok || json.ok === false) {
          throw new Error(json.error || `Star failed (${res.status})`);
        }
      }
    } catch (e) {
      set(!next); // undo the optimistic star
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!openId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      closeSector();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, closeSector]);

  return (
    <section className="rot-dash">
      <header className="rot-head">
        <div>
          <h2 className="rot-title">Sector Trend</h2>
          <p className="rot-sub">
            {weight === "cap" ? "Free-float cap" : "Equal-weight"} vs {benchLabel}
            {asOf ? ` · as of ${asOf}` : ""}
            {loading
              ? " · loading…"
              : ranking
                ? " · ranking…"
                : hydrating
                  ? " · charts…"
                  : detailLoading
                    ? " · sector…"
                    : ""}
          </p>
        </div>
        <div className="rot-head-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? "Cancel" : "+ Add sector"}
          </button>
        </div>
      </header>
      {loading || (ranking && (boardFilter === "top" || boardFilter === "bottom")) || detailLoading ? (
        <div
          className="rot-progress"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="rot-progress-bar" />
          <span>
            {loading
                ? "Loading sectors…"
                : ranking
                  ? `Ranking ${range}…`
                  : `Loading ${range} sector…`}
          </span>
        </div>
      ) : null}

      <div className="rot-bar">
        <div className="rot-bar-row rot-bar-row--main">
          <label className="rot-search rot-search--wide">
            <span aria-hidden>⌕</span>
            <input
              placeholder="Search sectors…"
              value={stockFilter}
              onChange={(e) => setStockFilter(e.target.value)}
              aria-label="Search sectors"
            />
          </label>
          <div className="rot-seg" role="group" aria-label="Type">
            {(
              [
                ["sector", "Sectors"],
                ["industry", "Industries"],
                ["all", "All"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={typeFilter === id ? "on" : ""}
                aria-pressed={typeFilter === id}
                onClick={() => setTypeFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="rot-seg" role="group" aria-label="Movers">
            {(
              [
                ["all", "All"],
                ["top", "Top 20"],
                ["bottom", "Bottom 20"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={boardFilter === id ? "on" : ""}
                aria-pressed={boardFilter === id}
                onClick={() => {
                  setBoardFilter((prev) =>
                    id === "all" ? "all" : prev === id ? "all" : id,
                  );
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={watchOnly ? "rot-watch on" : "rot-watch"}
            aria-pressed={watchOnly}
            onClick={() => setWatchOnly((v) => !v)}
          >
            <span aria-hidden>★</span> Watchlist only
          </button>
          <label className="rot-min-n" title="Hide baskets with fewer names">
            <span className="rot-min-n-label">Min</span>
            <select
              value={minN}
              onChange={(e) => setMinN(Number(e.target.value))}
              aria-label="Minimum companies"
            >
              {MIN_N_OPTS.map((n) => (
                <option key={n} value={n}>
                  {n}+
                </option>
              ))}
            </select>
          </label>
          <span className="rot-bar-spacer" />
          <div className="rot-seg rot-seg--quiet" role="group" aria-label="Period">
            {ROTATION_RANGES.map((r) => (
              <button
                key={r}
                type="button"
                className={range === r ? "on" : ""}
                aria-pressed={range === r}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
          <div className="rot-seg rot-seg--quiet" role="group" aria-label="Index type">
            <button
              type="button"
              className={weight === "equal" ? "on" : ""}
              aria-pressed={weight === "equal"}
              onClick={() => setWeight("equal")}
              title="Every stock counts the same"
            >
              Equal
            </button>
            <button
              type="button"
              className={weight === "cap" ? "on" : ""}
              aria-pressed={weight === "cap"}
              onClick={() => setWeight("cap")}
              title="Bigger companies count more"
            >
              Cap
            </button>
          </div>
          <button
            type="button"
            className="rot-act"
            onClick={() => void refreshBoard()}
            disabled={loading || ranking}
            title="Refresh prices and market caps"
          >
            ↻
          </button>
        </div>
      </div>

      {adding ? (
      <form
        className="fam-dash-create"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="rot-create-top">
        <input
          className="fam-dash-search"
          placeholder="Sector name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          aria-label="New sector name"
        />
        <button
          type="submit"
          className="btn-ghost"
          disabled={creating || newName.trim().length < 2}
        >
          {creating ? "Saving…" : "Create sector"}
        </button>
        </div>
        <div className="fam-dash-create-cos">
          {newTickers.map((t) => (
            <span key={t.ticker} className="fam-dash-create-chip">
              <span className="mono">{t.ticker}</span>
              <button
                type="button"
                title={`Remove ${t.ticker}`}
                onClick={() =>
                  setNewTickers((rows) =>
                    rows.filter((x) => x.ticker !== t.ticker),
                  )
                }
              >
                ×
              </button>
            </span>
          ))}
          <TickerSuggest
            value={newQ}
            onChange={setNewQ}
            onSelect={pickCreateTicker}
            clearOnSelect
            persistGroww={false}
            placeholder="Add company…"
            className="fam-dash-search"
            submitLabel="add"
          />
        </div>
        <div
          ref={shotWell}
          className={`din-paste-well rot-shot rot-shot-mini${shotDrag ? " is-drag" : ""}${shotBusy ? " is-busy" : ""}`}
          tabIndex={0}
          role="button"
          aria-label="Paste sector screenshot"
          onClick={() => shotWell.current?.focus()}
          onPaste={(e) => {
            const file =
              [...e.clipboardData.items]
                .find((i) => i.type.startsWith("image/"))
                ?.getAsFile() ??
              [...e.clipboardData.files].find((f) => f.type.startsWith("image/")) ??
              null;
            if (file) {
              e.preventDefault();
              void enqueueShot(file);
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setShotDrag(true);
          }}
          onDragLeave={() => setShotDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setShotDrag(false);
            const file = e.dataTransfer.files[0];
            if (file) void enqueueShot(file);
          }}
        >
          {shotPreview ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="din-paste-preview rot-shot-preview" src={shotPreview} alt="" />
              <label className="din-paste-upload">
                Add images
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])];
                    for (const f of files) enqueueShot(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </>
          ) : (
            <div className="din-paste-hint">
              <span>Or paste / drop a screener screenshot</span>
              <label className="din-paste-upload">
                Choose images
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])];
                    for (const f of files) enqueueShot(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          )}
          {shotBusy ? (
            <p className="din-paste-busy">
              {shotLog[shotLog.length - 1] || "Working…"}
              {shotQueued ? ` · ${shotQueued} waiting` : ""}
            </p>
          ) : null}
        </div>
      </form>
      ) : null}

      {error ? <div className="table-meta">{error}</div> : null}
      {notice ? (
        <div className="table-meta rot-notice">
          {notice}{" "}
          <button type="button" className="link-btn" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {rankingWait ? (
        <div className="table-meta">
          Pulling returns once for all periods… Top / Bottom unlocks when this finishes
          {ranking ? " (first run can take a minute)." : "."}
        </div>
      ) : ranking ? (
        <div className="table-meta">
          Pulling returns once for all periods… range chips stay instant after.
        </div>
      ) : null}

      <div className={openId ? "rot-shell is-drawer" : "rot-shell"}>
        <div className="rot-shell-main">
          <div className="rot-pager">
            <span>
              {sortedCards.length
                ? showAll || shownCount >= sortedCards.length
                  ? `${sortedCards.length} ${typeFilter === "industry" ? "industries" : typeFilter === "sector" ? "sectors" : "baskets"}`
                  : `Showing ${shownCount} of ${sortedCards.length}`
                : rankingWait
                  ? "Ranking…"
                  : "No sectors"}
              {sortedCards.length > 0 && ranking && sortKey === "return"
                ? " · ranking…"
                : hydrating
                  ? " · charts…"
                  : ""}
            </span>
          </div>
          <div className="rot-grid">
            {loading && !cards.length ? (
              <Loading label="Loading sectors" variant="block" />
            ) : null}
            {pageCards.map((c) => (
              <article
                key={c.id}
                className={openId === c.id ? "rot-card is-open" : "rot-card"}
                tabIndex={0}
                role="button"
                onClick={() => openCardById(c)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openCardById(c);
                  }
                }}
              >
                <div className="rot-card-top">
                  <div className="rot-card-title">
                    <strong>{c.label}</strong>
                    <span className="rot-card-n">
                      {c.n} stock{c.n === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="rot-card-ret">
                    <span
                      className={
                        c.sector_pct == null
                          ? "rot-card-pct"
                          : c.sector_pct >= 0
                            ? "rot-card-pct pos"
                            : "rot-card-pct neg"
                      }
                      title={`${range} return`}
                    >
                      {fmtPct(c.sector_pct)}
                    </span>
                    <button
                      type="button"
                      className={c.starred ? "rot-star on" : "rot-star"}
                      aria-label={c.starred ? "Unstar" : "Star"}
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleStar(
                          c.hydrateId || c.id,
                          !c.starred,
                          c.childIds,
                        );
                      }}
                    >
                      ★
                    </button>
                  </div>
                </div>
                <DualSpark
                  a={c.sector}
                  b={c.bench}
                  height={140}
                  fill
                  aLabel={c.label}
                  bLabel={benchLabel}
                  logScale={scale === "log"}
                  ma={maOn}
                  aAbove={
                    c.sector_pct == null || c.bench_pct == null
                      ? true
                      : c.sector_pct >= c.bench_pct
                  }
                />
              </article>
            ))}
          </div>
          {shownCount < sortedCards.length ? (
            <div className="rot-more">
              <span>
                {shownCount} of {sortedCards.length} shown
              </span>
              <button
                type="button"
                className="rot-chip"
                disabled={hydrating}
                onClick={() => setPage((p) => p + 1)}
              >
                Show {Math.min(pageSize, sortedCards.length - shownCount)} more
              </button>
              <button
                type="button"
                className="rot-chip"
                disabled={hydrating}
                title="Loads charts in batches of 24 — may take a minute"
                onClick={() =>
                  setPage(Math.ceil(sortedCards.length / pageSize) - 1)
                }
              >
                Show all
              </button>
            </div>
          ) : null}
        </div>

        {openId ? (
          <aside className="rot-drawer" aria-label="Sector detail">
            <div className="rot-drawer-head">
              <div className="rot-drawer-title">
                <h3>{openCard?.label || editLabel || "…"}</h3>
                <button
                  type="button"
                  className="rot-drawer-x"
                  onClick={closeSector}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              <div className="rot-drawer-stats">
                <span className={(openCard?.sector_pct ?? 0) >= 0 ? "pos" : "neg"}>
                  Sector: {fmtPct(openCard?.sector_pct ?? null)}
                </span>
                <span className={(openCard?.bench_pct ?? 0) >= 0 ? "pos" : "neg"}>
                  {benchLabel}: {fmtPct(openCard?.bench_pct ?? null)}
                </span>
                <span className="rot-muted">{openCard?.n ?? 0} stocks</span>
              </div>
              <p className="rot-drawer-sub">
                {asOf ? `as of ${asOf}` : ""}
                {openCard
                  ? ` · ${(openCard.up ?? 0)} stocks up, ${(openCard.down ?? 0)} down`
                  : ""}
              </p>
            </div>
            {detailLoading && !detail ? (
              <Loading label="Loading stocks" variant="block" />
            ) : (
              <ol className="rot-drawer-list">
                {(drawerAll ? shownMembers : shownMembers.slice(0, 10)).map(
                  (m, mi) => (
                    <li key={m.ticker} className="rot-drawer-row">
                      <span className="rot-drawer-rank">{mi + 1}</span>
                      <div className="rot-drawer-name">
                        <strong title={m.name}>{m.name}</strong>
                        <span className="rot-muted">{m.ticker}</span>
                      </div>
                      <MiniSpark pts={m.spark} />
                      <span
                        className={
                          m.window_pct == null
                            ? "rot-drawer-pct"
                            : m.window_pct >= 0
                              ? "rot-drawer-pct pos"
                              : "rot-drawer-pct neg"
                        }
                      >
                        {fmtPct(m.window_pct)}
                      </span>
                      <span className="rot-drawer-price">
                        {m.price == null
                          ? "—"
                          : `₹${m.price.toLocaleString("en-IN", {
                              maximumFractionDigits: 2,
                            })}`}
                      </span>
                    </li>
                  ),
                )}
              </ol>
            )}
            {shownMembers.length > 10 ? (
              <button
                type="button"
                className="rot-drawer-more"
                onClick={() => setDrawerAll((v) => !v)}
              >
                {drawerAll
                  ? "Show top 10 ↑"
                  : `Show all ${shownMembers.length} stocks ↓`}
              </button>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
