"use client";

import { Loading } from "@/components/Loading";
import { HoldingsIndustryCheck, MultiPick } from "@/components/FilterBar";
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

/** Cards shown first on "All"; "Show more" adds this many each click. */
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
  /** Hide thin sectors (same idea as Value's Min companies). */
  const [minN, setMinN] = useState(1);
  /** Market cap band (₹ Cr) — same defaults as Value ranking. */
  const [minCap, setMinCap] = useState("200");
  const [maxCap, setMaxCap] = useState("");
  /** Industry picker: rotation baskets are StockScans industries. */
  const [pickedSec, setPickedSec] = useState<string[]>([]);
  const [boardFilter, setBoardFilter] = useState<
    "all" | "top" | "bottom" | "starred" | "upcycle"
  >("all");
  /** Entering an upcycle: weak 1Y, beating the Nifty over 3M, up over 1M. */
  const [upcycle, setUpcycle] = useState<{
    weight: string;
    order: Map<string, number>;
    info: Map<string, { r1m: number; r3m: number; r1y: number; rel3m: number }>;
  } | null>(null);
  const [upcycleBusy, setUpcycleBusy] = useState(false);
  const [upcycleErr, setUpcycleErr] = useState<string | null>(null);
  /** vs Nifty over the selected range: Outperform (≥) / Underperform (<). */
  const [vsNifty, setVsNifty] = useState<"all" | "out" | "under">("all");
  /** Restrict board / member lists to Nifty 500 constituents. */
  const [n500Only, setN500Only] = useState(false);
  const [n500Set, setN500Set] = useState<Set<string> | null>(null);
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
  const [rankedKey, setRankedKey] = useState<string | null>(null);
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
      setCards(json.sectors ?? []);
      setRankedKey(null);
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
      // Rank cache was invalidated server-side — force upcycle to recompute.
      setUpcycle(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [openId, loadBoard, loadDetail]);


  const rankKey = `${range}:${weight}`;
  const rankedReady = rankedKey === rankKey;

  // Weight changes the basket index — drop cached series so hydrate/detail refetch.
  useEffect(() => {
    setRankedKey(null);
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

  // Range chips: each period has its own stock set, so a sector line can't be
  // re-cut locally. Blank it until rank / hydrate / detail load the new period.
  useEffect(() => {
    setRankedKey(null);
    if (!asOf) return;
    const start = rotationWindowStart(asOf, range);
    setCards((prev) =>
      prev.map((c) =>
        c.window_range === range
          ? c
          : {
              ...c,
              sector_pct: null,
              bench_pct: null,
              sector: [],
              bench: [],
              sector_full: undefined,
              bench_full: undefined,
              window_range: undefined,
            },
      ),
    );
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

  // Board-wide period returns: the only source for return sort, Best,
  // Top/Bottom 20 and Above (server caches all ranges, so re-ranks are fast).
  useEffect(() => {
    if (rankedKey === rankKey) return;
    const gen = ++rankGen.current;
    setRanking(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/sector-rotation?rank=1&range=${encodeURIComponent(range)}&weight=${encodeURIComponent(weight)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          as_of?: string | null;
          bench_label?: string;
          sectors?: Card[];
        };
        if (gen !== rankGen.current) return;
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
            return {
              ...c,
              sector_pct: r.sector_pct,
              bench_pct: r.bench_pct,
              today_pct: r.today_pct ?? c.today_pct,
              up: r.up ?? c.up,
              down: r.down ?? c.down,
            };
          }),
        );
        setRankedKey(rankKey);
      } catch (e) {
        if (gen !== rankGen.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (gen === rankGen.current) setRanking(false);
      }
    })();
  }, [rankedKey, rankKey, range, weight]);

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
  // Load Nifty 500 membership when the filter is on (cached in memory after first fetch).
  useEffect(() => {
    if (!n500Only || n500Set) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/index-constituents?index=NIFTY_500", {
          cache: "no-store",
        });
        const json = (await res.json()) as {
          ok?: boolean;
          tickers?: string[];
          error?: string;
        };
        if (!live) return;
        if (!res.ok || json.ok === false) {
          throw new Error(json.error || `HTTP ${res.status}`);
        }
        setN500Set(new Set((json.tickers || []).map((t) => t.toUpperCase())));
      } catch (e) {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setN500Only(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [n500Only, n500Set]);

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
    if (sortKey === "today") {
      rows.sort((a, b) => (b.today_pct ?? -999) - (a.today_pct ?? -999));
    } else if (sortKey === "name") {
      rows.sort((a, b) => a.label.localeCompare(b.label));
    } else if (sortKey === "n") {
      rows.sort((a, b) => b.n - a.n);
    } else if (rankedReady) {
      // Return sort only on board-wide ranks. Before they land, keep the
      // stable board order: sorting on whichever cards had hydrated mixed
      // period returns with today % and reshuffled pages in a loop.
      rows.sort(byReturn);
    }
    // Sectors with no members can't chart — keep them after real sectors.
    rows = [...rows.filter((c) => c.n > 0), ...rows.filter((c) => !(c.n > 0))];
    if (boardFilter === "starred") rows = rows.filter((c) => c.starred);
    if (boardFilter === "upcycle") {
      if (!upcycle || upcycle.weight !== weight) return [];
      // Ignore "Beating Nifty" / return sort — order is strongest 3M turn first.
      rows = rows
        .filter((c) => upcycle.order.has(c.id))
        .sort((a, b) => upcycle.order.get(a.id)! - upcycle.order.get(b.id)!);
      return rows;
    }
    // Top/Bottom/Outperform/Underperform need board-wide returns (see rankingWait).
    if (
      (boardFilter === "top" ||
        boardFilter === "bottom" ||
        vsNifty !== "all") &&
      !rankedReady
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
    }
    return rows;
  }, [cards, filter, stockFilter, minN, minCapN, maxCapN, boardFilter, vsNifty, sortKey, rankedReady, upcycle, weight, pickedSec, n500Only, n500Set]);

  useEffect(() => {
    if (boardFilter !== "upcycle") {
      setUpcycleBusy(false);
      setUpcycleErr(null);
      return;
    }
    if (upcycle?.weight === weight) return;
    let live = true;
    setUpcycleBusy(true);
    setUpcycleErr(null);
    // Drop stale equal/cap result so the list does not flash the wrong set.
    setUpcycle(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/sector-rotation?upcycle=1&weight=${encodeURIComponent(weight)}`,
          { cache: "no-store" },
        );
        const j = (await res.json()) as {
          ok?: boolean;
          error?: string;
          sectors?: Array<{ id: string; r1m: number; r3m: number; r1y: number; rel3m: number }>;
        };
        if (!live) return;
        if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
        const list = j.sectors ?? [];
        setUpcycle({
          weight,
          order: new Map(list.map((x, i) => [x.id, i])),
          info: new Map(list.map((x) => [x.id, x])),
        });
        setUpcycleErr(null);
      } catch (e) {
        if (!live) return;
        setUpcycle(null);
        setUpcycleErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (live) setUpcycleBusy(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [boardFilter, weight, upcycle?.weight]);

  // Upcycle rule is 1Y weak / 3M beat / 1M up — pin the board to 3M so the
  // return column matches the "turning" leg instead of a random range chip.
  useEffect(() => {
    if (boardFilter === "upcycle" && range !== "3M") setRange("3M");
  }, [boardFilter, range]);

  /** Filter needs ranks that are still computing — say so, not "No sectors". */
  const rankingWait =
    (boardFilter === "top" || boardFilter === "bottom" || vsNifty !== "all") &&
    !rankedReady;
  const upcycleWait = boardFilter === "upcycle" && (upcycleBusy || !upcycle || upcycle.weight !== weight);

  // Single key so adding a filter later does not change useEffect dep length (HMR).
  const pageResetKey = [
    filter,
    stockFilter,
    minN,
    minCap,
    maxCap,
    boardFilter,
    vsNifty,
    n500Only,
    sortKey,
    pickedSec.join("\0"),
  ].join("|");
  useEffect(() => {
    setPage(0);
  }, [pageResetKey]);

  // "page" = how many extra batches are revealed (0 → first PAGE_SIZE).
  // Top / Bottom 20 always fit in one batch.
  const pageSize =
    boardFilter === "top" || boardFilter === "bottom" ? 20 : PAGE_SIZE;
  const shownCount = Math.min(sortedCards.length, (page + 1) * pageSize);
  const pageCards = sortedCards.slice(0, shownCount);
  const pageIds = pageCards.map((c) => c.id).join(",");

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
        setCards((prev) => prev.map((c) => next.get(c.id) ?? c));
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
  }, []);

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

  const toggleStar = async (id: string, next: boolean) => {
    const set = (v: boolean) =>
      setCards((prev) =>
        prev.map((c) => (c.id === id ? { ...c, starred: v } : c)),
      );
    set(next);
    try {
      const res = await fetch("/api/sector-rotation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, star: true, starred: next }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || `Star failed (${res.status})`);
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
          {openId ? (
            <button
              type="button"
              className="btn-ghost rot-back"
              onClick={closeSector}
            >
              ← Back to sectors
            </button>
          ) : (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setAdding((v) => !v)}
            >
              {adding ? "Cancel" : "+ Add sector"}
            </button>
          )}
        </div>
      </header>
      {loading || ranking || hydrating || detailLoading ? (
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
                  : hydrating
                    ? `Updating ${range} charts…`
                    : `Loading ${range} sector…`}
          </span>
        </div>
      ) : null}

      <div className="rot-bar">
        <div className="rot-bar-row">
          <div className="rot-seg" role="group" aria-label="View">
            {(
              [
                ["grid", "Grid"],
                ["table", "Table"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={view === id ? "on" : ""}
                aria-pressed={view === id}
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="rot-seg" role="group" aria-label="Period">
            {ROTATION_RANGES.map((r) => (
              <button
                key={r}
                type="button"
                className={range === r ? "on" : ""}
                aria-pressed={range === r}
                disabled={boardFilter === "upcycle" && r !== "3M"}
                title={
                  boardFilter === "upcycle" && r !== "3M"
                    ? "Entering upcycle uses the 3M turn vs Nifty"
                    : undefined
                }
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
          <div className="rot-seg" role="group" aria-label="Index type">
            <button
              type="button"
              className={weight === "equal" ? "on" : ""}
              aria-pressed={weight === "equal"}
              onClick={() => setWeight("equal")}
              title="Every stock counts the same"
            >
              Equal weight
            </button>
            <button
              type="button"
              className={weight === "cap" ? "on" : ""}
              aria-pressed={weight === "cap"}
              onClick={() => setWeight("cap")}
              title="Bigger companies count more"
            >
              Market cap
            </button>
          </div>
          {view === "grid" || openId ? (
            <div className="rot-seg rot-seg--quiet" role="group" aria-label="Chart">
              <span className="rot-seg-k">Chart</span>
              <button
                type="button"
                className={scale === "lin" ? "on" : ""}
                aria-pressed={scale === "lin"}
                onClick={() => setScale("lin")}
              >
                Lin
              </button>
              <button
                type="button"
                className={scale === "log" ? "on" : ""}
                aria-pressed={scale === "log"}
                onClick={() => setScale("log")}
              >
                Log
              </button>
              <span className="rot-seg-k">MA</span>
              {ROTATION_MA_PERIODS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={maOn.includes(n) ? "on" : ""}
                  aria-pressed={maOn.includes(n)}
                  onClick={() =>
                    setMaOn((prev) =>
                      prev.includes(n)
                        ? prev.filter((x) => x !== n)
                        : [...prev, n].sort((a, b) => a - b),
                    )
                  }
                >
                  {n}
                </button>
              ))}
            </div>
          ) : null}
          <span className="rot-bar-spacer" />
          <button
            type="button"
            className="rot-act"
            onClick={() => void refreshBoard()}
            disabled={loading || ranking}
            title="Refresh prices and market caps"
          >
            ↻ Refresh
          </button>

        </div>
        {!openId ? (
          <div className="rot-bar-row">
            <MultiPick
              label="Industry"
              allLabel="All industries"
              values={pickedSec}
              onChange={setPickedSec}
              options={cards
                .filter((c) => (c.n ?? 0) >= minN)
                .map((c) => ({ id: c.label, label: c.label, count: c.n }))
                .sort((a, b) => a.label.localeCompare(b.label))}
              searchable
            />
            <HoldingsIndustryCheck
              values={pickedSec}
              onChange={setPickedSec}
              available={cards.filter((c) => (c.n ?? 0) >= minN).map((c) => c.label)}
            />
            <label className="rot-sort">
              <span>Min companies</span>
              <select
                value={minN}
                onChange={(e) => setMinN(Number(e.target.value))}
                aria-label="Minimum companies in sector"
              >
                {[1, 2, 3, 5, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}+
                  </option>
                ))}
              </select>
            </label>
            <label className="rot-cap">
              <span>Min market cap</span>
              <input
                inputMode="numeric"
                value={minCap}
                onChange={(e) => setMinCap(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="₹ Cr"
                aria-label="Minimum market cap in ₹ crore"
              />
            </label>
            <label className="rot-cap">
              <span>Max market cap</span>
              <input
                inputMode="numeric"
                value={maxCap}
                onChange={(e) => setMaxCap(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="₹ Cr"
                aria-label="Maximum market cap in ₹ crore"
              />
            </label>
            <label className="rot-search">
              <span aria-hidden>⌕</span>
              <input
                placeholder="Search stock"
                value={stockFilter}
                onChange={(e) => setStockFilter(e.target.value)}
                aria-label="Search stock"
              />
            </label>
            <div className="rot-seg" role="group" aria-label="Show">
              {(
                [
                  ["all", "All"],
                  ["top", "Top 20"],
                  ["bottom", "Bottom 20"],
                  ["upcycle", "↗ Entering upcycle"],
                  ["starred", "★ Starred"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={boardFilter === id ? "on" : ""}
                  aria-pressed={boardFilter === id}
                  title={
                    id === "upcycle"
                      ? "1Y below Nifty 500, 3M above it, 1M up — strongest 3M turn first"
                      : undefined
                  }
                  onClick={() => {
                    setBoardFilter((prev) =>
                      id === "all" ? "all" : prev === id ? "all" : id,
                    );
                    // Upcycle already encodes the vs-Nifty turn — clear Out/Under.
                    if (id === "upcycle") setVsNifty("all");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="rot-seg" role="group" aria-label="Vs Nifty">
              {(
                [
                  ["all", "All"],
                  ["out", "Outperform"],
                  ["under", "Underperform"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={vsNifty === id ? "on" : ""}
                  aria-pressed={vsNifty === id}
                  disabled={boardFilter === "upcycle" && id !== "all"}
                  title={
                    boardFilter === "upcycle"
                      ? "Entering upcycle already requires beating Nifty over 3M"
                      : id === "out"
                        ? `Sector ≥ ${benchLabel} over the selected range`
                        : id === "under"
                          ? `Sector below ${benchLabel} over the selected range`
                          : "Show all vs Nifty"
                  }
                  onClick={() =>
                    setVsNifty((prev) =>
                      id === "all" ? "all" : prev === id ? "all" : id,
                    )
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={n500Only ? "rot-toggle on" : "rot-toggle"}
              aria-pressed={n500Only}
              onClick={() => setN500Only((v) => !v)}
              title="Only stocks in the Nifty 500 (NSE list)"
            >
              <span className="rot-toggle-dot" aria-hidden />
              Nifty 500
            </button>
            <span className="rot-bar-spacer" />
            <label className="rot-sort">
              <span>Sort</span>
              <select
                value={sortKey}
                onChange={(e) =>
                  setSortKey(e.target.value as typeof sortKey)
                }
                aria-label="Sort"
              >
                <option value="return">Return</option>
                <option value="today">Today</option>
                <option value="name">Name</option>
                <option value="n">Stocks</option>
              </select>
            </label>
          </div>
        ) : null}
      </div>

      {!openId && adding ? (
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
      {!openId && rankingWait ? (
        <div className="table-meta">
          Ranking all {cards.length} sectors by {range} return… the first run
          takes about a minute, then range and filter changes are instant.
        </div>
      ) : null}

      {!openId ? (
        <div className="rot-stats" aria-label="Trend summary">
          <div className="rot-stat">
            <span className="rot-stat-k">Sectors shown</span>
            <span className="rot-stat-v">{sortedCards.length}</span>
          </div>
          <div className="rot-stat">
            <span className="rot-stat-k">Stocks</span>
            <span className="rot-stat-v">{stocksShown}</span>
          </div>
        </div>
      ) : null}

      {openId ? (
        <div className="rot-detail">
          <div className="rot-detail-bar">
            <button type="button" className="btn-ghost rot-back" onClick={closeSector}>
              ← Back
            </button>
            <input
              className="fam-dash-search rot-rename"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              onBlur={() => void saveLabel()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveLabel();
                }
              }}
              aria-label="Sector name"
            />
            <span
              className={`rot-pct ${(openCard?.sector_pct ?? 0) >= 0 ? "pos" : "neg"}`}
            >
              Sector {fmtPct(openCard?.sector_pct ?? null)}
            </span>
            <span
              className={`rot-pct ${(openCard?.bench_pct ?? 0) >= 0 ? "pos" : "neg"}`}
            >
              {benchLabel} {fmtPct(openCard?.bench_pct ?? null)}
            </span>
            <span className="rot-muted">
              {openCard
                ? minCapN || maxCapN || memberQ.trim()
                  ? `${shownMembers.length} of ${openCard.n} stocks`
                  : `${openCard.n} stocks`
                : ""}
            </span>

            <button
              type="button"
              className="btn-ghost"
              onClick={() => void deleteOpenSector()}
            >
              Delete sector
            </button>
          </div>
          <div className="rot-stats rot-stats--detail" aria-label="Sector detail">
            <div className="rot-stat">
              <span className="rot-stat-k">Companies shown</span>
              <span className="rot-stat-v">{shownMembers.length}</span>
            </div>
          </div>
          {openCard && openCard.sector.length > 1 ? (
            <DualSpark
              a={openCard.sector}
              b={openCard.bench}
              height={180}
              fill
              aLabel={openCard.label}
              bLabel={benchLabel}
              logScale={scale === "log"}
              ma={maOn}
              aAbove={
                openCard.sector_pct == null || openCard.bench_pct == null
                  ? true
                  : openCard.sector_pct >= openCard.bench_pct
              }
            />
          ) : openCard ? null : (
            <Loading label="Loading sector" variant="block" />
          )}
          <p className="rot-tone-hint">
            Sector line: green = at/above {benchLabel}, red = below. Change % follows
            the selected range (green up / red down).
          </p>
          <div className="rot-add-row">
            <TickerSuggest
              value={addQ}
              onChange={setAddQ}
              onSelect={(h) => void addTicker(h)}
              clearOnSelect
              persistGroww={false}
              placeholder="Add company…"
              className="fam-dash-search"
              submitLabel="add"
            />
            <label className="rot-cap">
              <span>Min market cap</span>
              <input
                inputMode="numeric"
                value={minCap}
                onChange={(e) => setMinCap(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="₹ Cr"
                aria-label="Minimum market cap in ₹ crore"
              />
            </label>
            <label className="rot-cap">
              <span>Max market cap</span>
              <input
                inputMode="numeric"
                value={maxCap}
                onChange={(e) => setMaxCap(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="₹ Cr"
                aria-label="Maximum market cap in ₹ crore"
              />
            </label>
            <input
              className="fam-dash-search rot-member-filter"
              placeholder="Search by name or code…"
              value={memberQ}
              onChange={(e) => setMemberQ(e.target.value)}
              aria-label="Filter constituents"
            />
          </div>
          <table className="rot-table rot-table--members">
            <thead>
              <tr>
                <th className="rot-col-num" title={`Ranked by ${range} return`}>Rank</th>
                <th className="rot-col-stock">Company</th>
                <th className="rot-col-sym">Symbol</th>
                <th className="rot-col-num">Market Cap</th>
                <th className="rot-col-num">Today %</th>
                <th className="rot-col-num">{range} return</th>
                <th className="rot-col-num" title={`Stock return minus ${benchLabel} return over ${range}`}>
                  vs {benchLabel}
                </th>
                <th className="rot-col-vs">Vs Nifty</th>
                <th className="rot-col-trend">Trend</th>
                <th className="rot-col-act" />
              </tr>
            </thead>
            <tbody>
              {shownMembers.map((m, mi) => (
                <tr key={m.ticker}>
                  <td className="rot-num">{m.window_pct == null ? "—" : byReturnMembers.indexOf(m) + 1 || mi + 1}</td>
                  <td className="rot-stock">
                    {m.tv_url ? (
                      <a
                        href={m.tv_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`${m.name} · Open in TradingView`}
                      >
                        {m.name}
                      </a>
                    ) : (
                      <span title={m.name}>{m.name}</span>
                    )}
                  </td>
                  <td className="mono rot-sym">
                    <span className="rot-sym-line">
                      {m.ticker}
                      <ReviewPlusButton ticker={m.ticker} />
                      <StockLinks ticker={m.ticker} market={m.market} />
                    </span>
                  </td>
                  <td className="rot-num">{fmtCr(m.mcap_cr)}</td>
                  <td
                    className={`rot-num ${
                      m.change_pct == null
                        ? ""
                        : m.change_pct >= 0
                          ? "pos"
                          : "neg"
                    }`.trim()}
                  >
                    {fmtPct(m.change_pct)}
                  </td>
                  <td
                    className={`rot-num ${
                      m.window_pct == null
                        ? ""
                        : m.window_pct >= 0
                          ? "pos"
                          : "neg"
                    }`.trim()}
                  >
                    {fmtPct(m.window_pct)}
                  </td>
                  {(() => {
                    const b = openCard?.bench_pct;
                    const rel = m.window_pct != null && b != null ? m.window_pct - b : null;
                    return (
                      <td className={`rot-num ${rel == null ? "" : rel >= 0 ? "pos" : "neg"}`.trim()}>
                        {rel == null ? "—" : `${rel >= 0 ? "+" : ""}${rel.toFixed(1)} pts`}
                      </td>
                    );
                  })()}
                  {(() => {
                    const b = openCard?.bench_pct;
                    const tag =
                      m.window_pct == null || b == null
                        ? null
                        : m.window_pct >= b
                          ? "Outperform"
                          : "Underperform";
                    return (
                      <td>
                        {tag ? (
                          <span
                            className={
                              tag === "Outperform" ? "rot-pill pos" : "rot-pill neg"
                            }
                          >
                            {tag}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    );
                  })()}
                  <td className="rot-trend">
                    <MiniSpark pts={m.spark} />
                  </td>
                  <td className="rot-act">
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => void removeTicker(m.ticker)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
        <div className="rot-page">
          <span>
            {boardFilter === "upcycle"
              ? upcycleErr
                ? `Could not load upcycle: ${upcycleErr}`
                : upcycleWait
                  ? "Finding sectors that are turning up…"
                  : `${sortedCards.length} sectors entering an upcycle · 1Y below ${benchLabel}, 3M beating it, 1M up · strongest turn first`
              : sortedCards.length
              ? `Showing ${shownCount} of ${sortedCards.length} sectors`
              : rankingWait
                ? "Ranking…"
                : "No sectors"}
            {sortedCards.length > 0 && !rankedReady && sortKey === "return" && boardFilter !== "upcycle"
              ? " · ranking by return…"
              : ""}
          </span>
        </div>
        {view === "table" ? (
        <div className="rot-tcard">
        <table className="rot-table rot-table--modern">
          <thead>
            <tr>
              <th className="rot-tc-x" aria-label="Show stocks"></th>
              <th>Sector</th>
              <th className="num">Stocks</th>
              <th className="num">Today</th>
              <th className="num">{range} return</th>
              <th className="num">vs {benchLabel}</th>
              <th>Vs Nifty</th>
              <th className="rot-tc-star" aria-label="Starred"></th>
            </tr>
          </thead>
          <tbody>
            {pageCards.map((c) => {
              const open = expanded.has(c.id);
              const rel =
                c.sector_pct != null && c.bench_pct != null ? c.sector_pct - c.bench_pct : null;
              const vsTag =
                c.sector_pct == null || c.bench_pct == null
                  ? null
                  : c.sector_pct >= c.bench_pct
                    ? "Outperform"
                    : "Underperform";
              return (
              <Fragment key={c.id}>
              <tr
                className={["rot-row", open ? "is-open" : ""].join(" ")}
                onClick={() => toggleExpanded(c.id)}
                aria-expanded={open}
              >
                <td className="rot-tc-x">
                  <button
                    type="button"
                    className={open ? "rot-expand on" : "rot-expand"}
                    aria-label={open ? `Hide ${c.label} stocks` : `Show ${c.label} stocks`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpanded(c.id);
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </td>
                <td>
                  <span className="rot-tname">
                    {c.label}
                    {boardFilter === "upcycle" && upcycle?.info.get(c.id) ? (
                      <span className="rot-turn" title="1-year return → 3-month return">
                        1Y {fmtPct(upcycle.info.get(c.id)!.r1y)} → 3M {fmtPct(upcycle.info.get(c.id)!.r3m)}
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="num">
                  <span className="rot-tcount">{c.n}</span>
                  {(c.up ?? 0) > 0 ? <span className="rot-up">▲{c.up}</span> : null}
                  {(c.down ?? 0) > 0 ? <span className="rot-dn">▼{c.down}</span> : null}
                </td>
                <td className={`num ${(c.today_pct ?? 0) >= 0 ? "pos" : "neg"}`}>
                  {fmtPct(c.today_pct ?? null)}
                </td>
                <td className="num">
                  <span
                    className={
                      c.sector_pct == null
                        ? "rot-pill"
                        : c.sector_pct >= 0
                          ? "rot-pill pos"
                          : "rot-pill neg"
                    }
                  >
                    {fmtPct(c.sector_pct)}
                  </span>
                </td>
                <td className={`num ${rel == null ? "" : rel >= 0 ? "pos" : "neg"}`}>
                  {rel == null ? "—" : `${rel >= 0 ? "+" : ""}${rel.toFixed(1)} pts`}
                </td>
                <td>
                  {vsTag ? (
                    <span
                      className={
                        vsTag === "Outperform" ? "rot-pill pos" : "rot-pill neg"
                      }
                    >
                      {vsTag}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="rot-tc-star">
                  <button
                    type="button"
                    className={c.starred ? "rot-star on" : "rot-star"}
                    aria-label={c.starred ? "Unstar" : "Star"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleStar(c.id, !c.starred);
                    }}
                  >
                    ★
                  </button>
                </td>
              </tr>
              {open ? (
                <SectorStocksRow
                  id={c.id}
                  range={range}
                  colSpan={9}
                  onOpen={() => setOpenId(c.id)}
                  minCap={minCapN}
                  maxCap={maxCapN}
                  n500Only={n500Only}
                  n500Set={n500Set}
                  vsNifty={vsNifty}
                  benchPct={c.bench_pct}
                />
              ) : null}
              </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      ) : (
        <div className="rot-grid">
          {loading && !cards.length ? (
            <Loading label="Loading sectors" variant="block" />
          ) : null}
          {pageCards.map((c) => (
            <article
              key={c.id}
              className="rot-card"
              tabIndex={0}
              role="button"
              onClick={() => setOpenId(c.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenId(c.id);
                }
              }}
            >
              <div className="rot-card-top">
                <strong>
                  {c.label}
                  {boardFilter === "upcycle" && upcycle?.info.get(c.id) ? (
                    <span className="rot-turn" title="1-year return → 3-month return">
                      1Y {fmtPct(upcycle.info.get(c.id)!.r1y)} → 3M {fmtPct(upcycle.info.get(c.id)!.r3m)}
                    </span>
                    ) : null}
                </strong>
                <span className="rot-card-ret">
                  <span
                    className={
                      c.sector_pct == null
                        ? "rot-pill"
                        : c.sector_pct >= 0
                          ? "rot-pill pos"
                          : "rot-pill neg"
                    }
                    title={`Sector return, ${range}`}
                  >
                    {fmtPct(c.sector_pct)}
                  </span>
                  {c.sector_pct != null && c.bench_pct != null ? (
                    <span
                      className={
                        c.sector_pct >= c.bench_pct
                          ? "rot-pill pos"
                          : "rot-pill neg"
                      }
                      title={
                        c.sector_pct >= c.bench_pct
                          ? `≥ ${benchLabel} over ${range}`
                          : `Below ${benchLabel} over ${range}`
                      }
                    >
                      {c.sector_pct >= c.bench_pct
                        ? "Outperform"
                        : "Underperform"}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className={c.starred ? "rot-star on" : "rot-star"}
                    aria-label={c.starred ? "Unstar" : "Star"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleStar(c.id, !c.starred);
                    }}
                  >
                    ★
                  </button>
                </span>
              </div>
              <div className="rot-card-meta" aria-label="Sector vs benchmark">
                <div className="rot-meta-cell">
                  <span className="rot-meta-k">{benchLabel}</span>
                  <span
                    className={`rot-meta-v ${(c.bench_pct ?? 0) >= 0 ? "pos" : "neg"}`}
                  >
                    {fmtPct(c.bench_pct)}
                  </span>
                </div>
                <div className="rot-meta-cell">
                  <span className="rot-meta-k">Stocks</span>
                  <span className="rot-meta-v rot-meta-breadth">
                    <span className="rot-meta-n">{c.n}</span>
                    <span className="rot-meta-ud" aria-label="Breadth today">
                      <span
                        className={(c.up ?? 0) > 0 ? "rot-up" : "rot-ud-flat"}
                        title="Up today"
                      >
                        ▲{c.up ?? 0}
                      </span>
                      <span
                        className={(c.down ?? 0) > 0 ? "rot-dn" : "rot-ud-flat"}
                        title="Down today"
                      >
                        ▼{c.down ?? 0}
                      </span>
                    </span>
                  </span>
                </div>
                <div className="rot-meta-cell">
                  <span className="rot-meta-k">Today</span>
                  <span
                    className={`rot-meta-v ${(c.today_pct ?? 0) >= 0 ? "pos" : "neg"}`}
                  >
                    {fmtPct(c.today_pct ?? null)}
                  </span>
                </div>
              </div>
              <DualSpark
                a={c.sector}
                b={c.bench}
                height={110}
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
        )}
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
        </>
      )}
    </section>
  );
}
