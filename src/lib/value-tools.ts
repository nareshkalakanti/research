import { trailingYear } from "./ttm";
import { rotationCloses } from "./rotation-bars";
import { fetchScreenerAllAnnual, screenerPagesTriedSince } from "./screener-annual";
import { screenerBulkDeferred, screenerPausedUntil, ScreenerPausedError } from "./screener-fetch";
import { openSqliteNamed } from "./sqlite-utils";
import { fillHtIvFromYahoo } from "./sector-rotation-board";
import { buildScannerData } from "./scanner";
import { loadCachedQuartersSeries } from "./screener-quarters";
import { rotationFetchYears } from "./sector-rotation-series";
import { loadStockMaster } from "./stock-master";
import { loadHtIvMap } from "./strategy/ht-store";
import { isRightsOrPartlyPaid } from "./listing-name-match";
import { runConcurrent } from "./scrape-pool";
import {
  fillHtIvFromUpstox,
  isinForTicker,
  upstoxConfigured,
  UPSTOX_STOCKS_PER_RUN,
  UpstoxRateLimitError,
} from "./upstox-fundamentals";
import {
  fillHtIvFromIndianApi,
  indianApiConfigured,
  INDIANAPI_FILL_CONCURRENCY,
  INDIANAPI_STOCKS_PER_RUN,
  IndianApiRateLimitError,
} from "./indianapi-fundamentals";
import { recoveryPeak, roce3yFromAnnual, sales3yFromAnnual } from "./value-legs-math";

/**
 * Value page: the ranking universe (Sales growth 3Y, ROCE 3Y, P/B per stock,
 * StockScans industry) and Favour / Out of favour breadth (incl. Full Market).
 * Everything comes from stored data — no live fetches.
 */

/**
 * Screener annual series for every cached stock: 3-year sales CAGR (last FY vs
 * three years earlier) and 3-year average ROCE — the same definitions as the
 * Intrinsic Value ranking. Read in one pass from metrics.db.
 */
/**
 * Why a stock's legs can never be completed from its own results — shown as a
 * label instead of a blank, and kept out of the fill queue (no source can fix it).
 */
export type ValueNa = "no_revenue" | "short_history" | "erratic" | "negative_equity";

/** Sales 3Y is null on full annual data: say why (same rules as sales3yFromAnnual). */
function salesNaReason(sales: Array<number | null>): ValueNa | null {
  const known = sales.filter((v) => v != null).length;
  if (known < 4) return "short_history";
  const end = sales[sales.length - 1];
  const start = sales[sales.length - 4];
  if (end == null || end <= 0 || start == null || start < 1) return "no_revenue";
  if (end / start > 20 || start / end > 20) return "erratic";
  return null;
}

type ScreenerLegs = {
  sales3y: number | null;
  roce3y: number | null;
  fy: string | null;
  bv?: number | null;
  /** Latest full-year book value even when zero / negative (bv keeps only > 0). */
  bvLatest?: number | null;
  salesNa?: ValueNa | null;
  /** 3-yr window starts in a trough (below 60% of an earlier year): a recovery, not growth. */
  salesRecovery?: boolean;
};

function loadScreenerLegs(): Map<string, ScreenerLegs> {
  const out = new Map<string, ScreenerLegs>();
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, annual_json FROM screener_annual_cache`).all() as Array<{
        t: string;
        annual_json: string;
      }>) {
        try {
          const a = JSON.parse(r.annual_json) as { dates: string[]; sales: Array<number | null>; roce: Array<number | null> };
          // Annual columns only (the most common month — drops half-year columns).
          const months = new Map<string, number>();
          for (const d of a.dates) months.set(d.slice(5, 7), (months.get(d.slice(5, 7)) ?? 0) + 1);
          const main = [...months].sort((x, y) => y[1] - x[1])[0]?.[0];
          const idx = a.dates.map((d, i) => (d.slice(5, 7) === main ? i : -1)).filter((i) => i >= 0);
          const sales = idx.map((i) => a.sales[i] ?? null);
          const roce = idx.map((i) => a.roce[i] ?? null);
          const sales3y = sales3yFromAnnual(sales);
          const roce3y = roce3yFromAnnual(roce);
          out.set(r.t, {
            sales3y,
            roce3y,
            fy: idx.length ? a.dates[idx[idx.length - 1]!]!.slice(0, 4) : null,
            salesNa: sales3y == null ? salesNaReason(sales) : null,
            salesRecovery: sales3y != null && sales.length >= 4 && recoveryPeak(sales, sales.length - 4) != null,
          });
        } catch {
          /* bad row */
        }
      }
      // Latest book value (equity + reserves) → P/B when Yahoo has none.
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, bs_json FROM screener_annual_bs_cache`).all() as Array<{ t: string; bs_json: string }>) {
        try {
          const b = JSON.parse(r.bs_json) as { dates: string[]; book_value: Array<number | null> };
          // Last full-year (most common month, i.e. March) book value — not the half-year column.
          const months = new Map<string, number>();
          for (const d of b.dates) months.set(d.slice(5, 7), (months.get(d.slice(5, 7)) ?? 0) + 1);
          const main = [...months].sort((x, y) => y[1] - x[1])[0]?.[0];
          let bv: number | null = null;
          let bvLatest: number | null = null;
          for (let i = b.dates.length - 1; i >= 0; i--) {
            const v = b.book_value[i];
            if (b.dates[i]!.slice(5, 7) !== main || v == null) continue;
            if (bvLatest == null) bvLatest = v;
            if (v > 0) {
              bv = v;
              break;
            }
          }
          const e = out.get(r.t);
          if (e) {
            e.bv = bv;
            e.bvLatest = bvLatest;
          } else out.set(r.t, { sales3y: null, roce3y: null, fy: null, bv, bvLatest });
        } catch {
          /* skip */
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* no cache */
  }
  return out;
}

/** Don't re-pull a Screener page within this window; at most this many pages per click. */
const SCREENER_RETRY_MS = 30 * 86_400_000;
/** Empty annual (no cache) may retry sooner than a full page success. */
const SCREENER_EMPTY_RETRY_MS = 2 * 60 * 60 * 1000;
/** Was 150 — that + cons/stand dual pulls tripped Screener's global pause. */
const SCREENER_PAGES_PER_RUN = 12;
/** Dedicated Sales/ROCE gap fill: more pages; Screener gap already paced in fetch. */
const SALES_ROCE_PAGES_PER_RUN = 50;
/** Yahoo soft-fail retries per dedicated run (after Upstox). */
const SALES_ROCE_YAHOO_PER_RUN = 120;
/** Parallel Upstox workers (API allows 50/s; each stock ~3 calls with internal throttle). */
const UPSTOX_FILL_CONCURRENCY = 4;
/** Parallel Yahoo workers — keep low to avoid 429. */
const YAHOO_FILL_CONCURRENCY = 3;

export type ValueStock = {
  t: string;
  name: string;
  market: string;
  sector: string | null;
  industry: string | null;
  mcap: number | null;
  web: string | null;
  /** Quality legs (null = not fetched yet). */
  sales3y: number | null;
  roce3y: number | null;
  pb: number | null;
  /** Where Sales growth / ROCE came from: Screener annual (preferred), then APIs. */
  src: "screener" | "upstox" | "indianapi" | "yahoo" | null;
  /** Legs can't be completed (shell / young / erratic / negative equity): not a data gap. */
  na: ValueNa | null;
  /** Sales growth measured from a trough: shown, but ranked last on growth. */
  sales_recovery: boolean;
};

/** Below this market cap (₹ Cr) the gap fill skips a stock unless asked to include micro-caps. */
export const VALUE_FILL_MIN_MCAP_CR = 50;

export type ValueUniverse = {
  rows: ValueStock[];
  /** Unranked stocks whose Screener page has not been tried in the last 30 days. */
  unranked_fetchable: number;
  industries: Array<{ name: string; n: number; ranked: number }>;
  as_of: string | null;
};

const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** Same stocks and the same industry as the Scanner page, plus quality legs. */
export function buildValueUniverse(_opts?: {
  /** Kept for callers; Portfolio names stay in Value (not filtered). */
  includePortfolio?: boolean;
}): ValueUniverse {
  const scan = buildScannerData();
  const ht = loadHtIvMap();
  const rows: ValueStock[] = [];
  let asOf: string | null = null;
  const legs = loadScreenerLegs();
  for (const r of scan.rows) {
    // Rights entitlements / partly-paid lines are not separate companies.
    if (isRightsOrPartlyPaid(r.t, r.name)) continue;
    const h = ht.get(r.t);
    const sc = legs.get(r.t);
    const mcapNow = r.mcap ?? h?.market_cap_cr ?? null;
    // Prefer Screener per leg; fill gaps from Yahoo. Do not discard Sales/ROCE
    // when book value / P/B is missing (negative equity, BS not fetched yet).
    const scPb = sc?.bv != null && sc.bv > 0 && mcapNow != null && mcapNow > 0 ? mcapNow / sc.bv : null;
    const yahooPb = h && ok(h.pb) && h.pb > 0 ? h.pb : null;
    const sales3y = sc?.sales3y ?? (h && ok(h.sales_growth_3y) ? h.sales_growth_3y : null);
    const roce3y = sc?.roce3y ?? (h && ok(h.roce_3y) ? h.roce_3y : null);
    // Latest full-year book value ≤ 0 (Screener balance sheet) is negative equity:
    // no P/B even if Yahoo reports one, ranked last on P/B instead.
    const negEquity = sc?.bvLatest != null && sc.bvLatest <= 0;
    const pb = negEquity ? null : scPb ?? yahooPb;
    const na: ValueNa | null =
      sales3y == null && sc?.salesNa ? sc.salesNa : negEquity ? "negative_equity" : null;
    if (h?.fetched_at && (ok(h.sales_growth_3y) || ok(h.roce_3y) || yahooPb) && (!asOf || h.fetched_at > asOf)) {
      asOf = h.fetched_at;
    }
    const fromSc = sc?.sales3y != null || sc?.roce3y != null || scPb != null;
    const fromUpstox = !fromSc && /^upstox:/i.test(h?.detail || "");
    const fromIndian = !fromSc && !fromUpstox && /^indianapi:/i.test(h?.detail || "");
    const fromYahoo =
      !fromSc &&
      !fromUpstox &&
      !fromIndian &&
      (ok(h?.sales_growth_3y) || ok(h?.roce_3y) || yahooPb != null);
    rows.push({
      t: r.t,
      name: r.name,
      market: r.market || "NSE",
      sector: r.sector,
      industry: r.industry,
      mcap: r.mcap ?? (h?.market_cap_cr ?? null),
      web: r.web,
      sales3y,
      roce3y,
      pb,
      na,
      sales_recovery: sc?.sales3y != null && !!sc.salesRecovery,
      src:
        sales3y == null && roce3y == null && pb == null
          ? null
          : fromSc
            ? "screener"
            : fromUpstox
              ? "upstox"
              : fromIndian
                ? "indianapi"
                : fromYahoo
                  ? "yahoo"
                  : "screener",
    });
  }
  const ind = new Map<string, { n: number; ranked: number }>();
  for (const r of rows) {
    if (!r.industry) continue;
    const e = ind.get(r.industry) ?? { n: 0, ranked: 0 };
    e.n++;
    if (r.sales3y != null) e.ranked++;
    ind.set(r.industry, e);
  }
  return {
    rows,
    industries: [...ind.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => a.name.localeCompare(b.name)),
    as_of: asOf,
    unranked_fetchable: (() => {
      const tried = screenerPagesTriedSince(SCREENER_RETRY_MS);
      return rows.filter((r) => valueGapFixable(r) && !tried.has(r.t)).length;
    })(),
  };
}

/** True when Sales / ROCE / P/B are not all ready for Intrinsic Value ranking. */
export function valueLegsIncomplete(r: Pick<ValueStock, "sales3y" | "roce3y" | "pb">): boolean {
  return r.sales3y == null || r.roce3y == null || r.pb == null || r.pb <= 0;
}

/**
 * A gap worth fetching: legs incomplete, not explained by the company's own
 * results (`na`), and at least ₹50 Cr unless micro-caps are included.
 */
export function valueGapFixable(
  r: Pick<ValueStock, "sales3y" | "roce3y" | "pb" | "na" | "mcap">,
  opts?: { includeMicro?: boolean },
): boolean {
  if (!valueLegsIncomplete(r) || r.na) return false;
  return !!opts?.includeMicro || (r.mcap ?? 0) >= VALUE_FILL_MIN_MCAP_CR;
}

// ---- Headwind / Tailwind ------------------------------------------------------------

export type WindIndicator = "FAVOUR" | "OUT" | "NEUTRAL";

export type WindRow = {
  industry: string;
  sector: string | null;
  n: number;
  above: number;
  below: number;
  /** (above − below) / n, from −1 to +1. */
  score: number;
  /** Median 3-month return of the industry's stocks (%). */
  ret3m: number | null;
  indicator: WindIndicator;
  /** Universe-wide breadth row (always first when present). */
  is_market?: boolean;
};

export const WIND = {
  /** Price vs its own N-day average decides "rising" / "falling". */
  smaDays: 50,
  /** Breadth score ≥ this → In favour. */
  favour: 0.2,
  /** Breadth score ≤ this → Out of favour. */
  out: -0.2,
  minStocks: 1,
  marketLabel: "Full Market",
} as const;

export function windIndicator(score: number): WindIndicator {
  if (score >= WIND.favour) return "FAVOUR";
  if (score <= WIND.out) return "OUT";
  return "NEUTRAL";
}

/** Drop cached Headwind / Cycle / Valuation results (app Refresh button). */
export function clearValueCaches(): void {
  windCache = null;
  marketScoreCache.clear();
  cycleCache = null;
  valCache = null;
}

let windCache: { at: number; data: { rows: WindRow[]; as_of: string | null } } | null = null;

/** Market Score chart: display score is 1 + wind score so Neutral sits at 1.0. */
export type MarketScoreSignal = "UPCYCLE" | "DOWNCYCLE" | "REVERSAL" | "NEUTRAL";
export type MarketScorePoint = { date: string; score: number; above: number; below: number; n: number };
export type MarketScoreSeries = {
  industry: string;
  is_market: boolean;
  as_of: string | null;
  current: number;
  signal: MarketScoreSignal;
  points: MarketScorePoint[];
};

const marketScoreCache = new Map<string, { at: number; data: MarketScoreSeries }>();

/** 1 + (above − below) / n — Neutral at 1.0 (chart scale). */
export function marketDisplayScore(above: number, below: number): number {
  const n = above + below;
  if (n <= 0) return 1;
  return Math.round((1 + (above - below) / n) * 10000) / 10000;
}

export function marketScoreSignal(points: Array<{ score: number }>): MarketScoreSignal {
  if (points.length < 2) {
    const s = points[0]?.score ?? 1;
    if (s >= 1.02) return "UPCYCLE";
    if (s <= 0.98) return "DOWNCYCLE";
    return "NEUTRAL";
  }
  const cur = points[points.length - 1]!.score;
  const look = Math.min(6, points.length - 1);
  const prev = points[points.length - 1 - look]!.score;
  const delta = cur - prev;
  const peak = Math.max(...points.slice(-Math.min(12, points.length)).map((p) => p.score));
  if (peak >= 1.08 && cur < peak - 0.06 && delta < 0) return "REVERSAL";
  if (cur >= 1.0 && delta >= -0.02) return "UPCYCLE";
  if (cur <= 1.0 && delta <= 0.02) return "DOWNCYCLE";
  if (delta > 0.04) return "UPCYCLE";
  if (delta < -0.04) return "DOWNCYCLE";
  return "NEUTRAL";
}

/**
 * Historical Market Score for Full Market (or one industry): breadth vs 50-day
 * average sampled along a shared calendar. Display score Neutral = 1.0.
 */
export async function buildMarketScoreHistory(opts?: {
  fresh?: boolean;
  industry?: string | null;
}): Promise<MarketScoreSeries> {
  const industry = (opts?.industry ?? "").trim() || WIND.marketLabel;
  const isMarket = industry === WIND.marketLabel;
  const cacheKey = isMarket ? "__market__" : industry.toLowerCase();
  if (!opts?.fresh) {
    const hit = marketScoreCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 60 * 60_000) return hit.data;
  }

  const master = loadStockMaster();
  const stocks = [...master.entries()].filter(([, m]) => {
    if (!m.tracked || !m.active || !m.industry) return false;
    if (isMarket) return true;
    return m.industry === industry;
  });
  const years = rotationFetchYears();
  const seriesList = await runConcurrent(stocks, 8, async ([t, m]) => {
    try {
      const bars = await rotationCloses(t, m.exchange || "NSE", years);
      if (bars.length < WIND.smaDays + 5) return null;
      const last = bars[bars.length - 1]!;
      if (Date.now() - Date.parse(`${last.date}T12:00:00Z`) > 21 * 86_400_000) return null;
      return bars;
    } catch {
      return null;
    }
  });
  const alive = seriesList.filter((b): b is NonNullable<typeof b> => !!b && b.length > 0);
  if (!alive.length) {
    const empty: MarketScoreSeries = {
      industry,
      is_market: isMarket,
      as_of: null,
      current: 1,
      signal: "NEUTRAL",
      points: [],
    };
    marketScoreCache.set(cacheKey, { at: Date.now(), data: empty });
    return empty;
  }

  // Shared trading calendar = longest series (date alignment only).
  let calendar = alive[0]!;
  for (const bars of alive) {
    if (bars.length > calendar.length) calendar = bars;
  }
  const SAMPLE_STEP = 5;
  const MAX_POINTS = 72;
  const firstIdx = WIND.smaDays - 1;
  const sampleIdx: number[] = [];
  for (let i = calendar.length - 1; i >= firstIdx; i -= SAMPLE_STEP) sampleIdx.push(i);
  sampleIdx.reverse();
  const trimmed =
    sampleIdx.length > MAX_POINTS
      ? sampleIdx.slice(sampleIdx.length - MAX_POINTS)
      : sampleIdx;
  // Always include the latest bar.
  if (trimmed[trimmed.length - 1] !== calendar.length - 1) {
    trimmed.push(calendar.length - 1);
  }
  const sampleDates = trimmed.map((i) => calendar[i]!.date);

  const byDate = new Map<string, { up: number; down: number }>();
  for (const d of sampleDates) byDate.set(d, { up: 0, down: 0 });

  for (const bars of alive) {
    let j = 0;
    for (const date of sampleDates) {
      while (j + 1 < bars.length && bars[j + 1]!.date <= date) j += 1;
      if (bars[j]!.date > date) continue;
      if (j < WIND.smaDays - 1) continue;
      // Skip if this stock's last bar for this date is stale vs sample (>10 sessions gap).
      const gap =
        (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${bars[j]!.date}T12:00:00Z`)) / 86_400_000;
      if (gap > 14) continue;
      let sum = 0;
      for (let k = j - WIND.smaDays + 1; k <= j; k += 1) sum += bars[k]!.close;
      const sma = sum / WIND.smaDays;
      const e = byDate.get(date)!;
      if (bars[j]!.close > sma) e.up += 1;
      else e.down += 1;
    }
  }

  const points: MarketScorePoint[] = [];
  for (const date of sampleDates) {
    const e = byDate.get(date)!;
    const n = e.up + e.down;
    if (n < Math.max(WIND.minStocks, isMarket ? 50 : 1)) continue;
    points.push({
      date,
      score: marketDisplayScore(e.up, e.down),
      above: e.up,
      below: e.down,
      n,
    });
  }

  const current = points[points.length - 1]?.score ?? 1;
  const data: MarketScoreSeries = {
    industry,
    is_market: isMarket,
    as_of: points[points.length - 1]?.date ?? null,
    current,
    signal: marketScoreSignal(points),
    points,
  };
  marketScoreCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Breadth per StockScans industry: share of stocks trading above their 50-day
 * average minus the share below it. +1 = every stock rising, −1 = every stock
 * falling. Uses the Rotation price cache (refreshed after each close).
 */
export async function buildHeadwinds(opts?: { fresh?: boolean }): Promise<{ rows: WindRow[]; as_of: string | null }> {
  if (!opts?.fresh && windCache && Date.now() - windCache.at < 10 * 60_000) return windCache.data;
  const master = loadStockMaster();
  const stocks = [...master.entries()].filter(([, m]) => m.tracked && m.active && m.industry);
  const years = rotationFetchYears();
  let asOf: string | null = null;
  const stats = await runConcurrent(stocks, 8, async ([t, m]) => {
    try {
      const bars = await rotationCloses(t, m.exchange || "NSE", years);
      if (bars.length < WIND.smaDays + 5) return null;
      const last = bars[bars.length - 1]!;
      if (!asOf || last.date > asOf) asOf = last.date;
      // Skip stocks with no trade for 3+ weeks (suspended / illiquid).
      if (Date.now() - Date.parse(`${last.date}T12:00:00Z`) > 21 * 86_400_000) return null;
      const win = bars.slice(-WIND.smaDays);
      const sma = win.reduce((a, b) => a + b.close, 0) / win.length;
      const back = bars[bars.length - 64];
      return {
        industry: m.industry!,
        sector: m.sector,
        up: last.close > sma,
        ret3m: back && back.close > 0 ? (last.close / back.close - 1) * 100 : null,
      };
    } catch {
      return null;
    }
  });
  const by = new Map<string, { sector: string | null; up: number; down: number; rets: number[] }>();
  for (const s of stats) {
    if (!s) continue;
    const e = by.get(s.industry) ?? { sector: s.sector, up: 0, down: 0, rets: [] };
    if (s.up) e.up++;
    else e.down++;
    if (s.ret3m != null) e.rets.push(s.ret3m);
    by.set(s.industry, e);
  }
  const rows: WindRow[] = [];
  let mUp = 0;
  let mDown = 0;
  const mRets: number[] = [];
  for (const [industry, e] of by) {
    const n = e.up + e.down;
    mUp += e.up;
    mDown += e.down;
    mRets.push(...e.rets);
    if (n < WIND.minStocks) continue;
    const score = Math.round(((e.up - e.down) / n) * 10000) / 10000;
    rows.push({
      industry,
      sector: e.sector,
      n,
      above: e.up,
      below: e.down,
      score,
      ret3m: median(e.rets),
      indicator: windIndicator(score),
    });
  }
  rows.sort((a, b) => b.score - a.score || b.n - a.n);
  const mN = mUp + mDown;
  if (mN >= WIND.minStocks) {
    const score = Math.round(((mUp - mDown) / mN) * 10000) / 10000;
    rows.unshift({
      industry: WIND.marketLabel,
      sector: null,
      n: mN,
      above: mUp,
      below: mDown,
      score,
      ret3m: median(mRets),
      indicator: windIndicator(score),
      is_market: true,
    });
  }
  const data = { rows, as_of: asOf };
  windCache = { at: Date.now(), data };
  return data;
}

// ---- Fill missing quality legs -------------------------------------------------------

const FILL_STOP = "__valueFillStop";
type StopHolder = { [FILL_STOP]?: boolean };
export function stopValueFill(): void {
  (globalThis as StopHolder)[FILL_STOP] = true;
}

export type SalesRoceGapKind = "never_fetched" | "ht_failed" | "short_history" | "gaps" | "other";

export type SalesRoceGap = ValueStock & { kind: SalesRoceGapKind };

function annualYearCount(annualJson: string): number {
  try {
    const a = JSON.parse(annualJson) as { dates: string[] };
    const months = new Map<string, number>();
    for (const d of a.dates) months.set(d.slice(5, 7), (months.get(d.slice(5, 7)) ?? 0) + 1);
    const main = [...months].sort((x, y) => y[1] - x[1])[0]?.[0];
    if (!main) return 0;
    return a.dates.filter((d) => d.slice(5, 7) === main).length;
  } catch {
    return 0;
  }
}

function loadAnnualMeta(): Map<string, { years: number }> {
  const out = new Map<string, { years: number }>();
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, annual_json FROM screener_annual_cache`).all() as Array<{
        t: string;
        annual_json: string;
      }>) {
        out.set(r.t, { years: annualYearCount(r.annual_json) });
      }
    } finally {
      db.close();
    }
  } catch {
    /* no cache */
  }
  return out;
}

/** Screener pages tried recently (empty or not). */
function screenerTriedSince(sinceMs: number): Map<string, string> {
  const out = new Map<string, string>();
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      for (const r of db
        .prepare(`SELECT UPPER(ticker) AS t, tried_at FROM screener_page_tried WHERE tried_at >= ?`)
        .all(cutoff) as Array<{ t: string; tried_at: string }>) {
        out.set(r.t, r.tried_at);
      }
    } finally {
      db.close();
    }
  } catch {
    /* no db */
  }
  return out;
}

/**
 * Why Sales 3Y / ROCE 3Y is missing on the Value universe.
 * Fixable: never_fetched → gaps → ht_failed. Skip short_history (not enough years).
 */
export function classifySalesRoceGaps(opts?: { includePortfolio?: boolean; includeMicro?: boolean }): {
  counts: Record<SalesRoceGapKind, number>;
  gaps: SalesRoceGap[];
  fixable: SalesRoceGap[];
} {
  const { rows } = buildValueUniverse({ includePortfolio: opts?.includePortfolio });
  // Shell / young / erratic / negative-equity stocks and micro-caps never enter the queue.
  const miss = rows.filter(
    (r) => (r.sales3y == null || r.roce3y == null) && valueGapFixable(r, { includeMicro: opts?.includeMicro }),
  );
  const annual = loadAnnualMeta();
  const ht = loadHtIvMap();
  const counts: Record<SalesRoceGapKind, number> = {
    never_fetched: 0,
    ht_failed: 0,
    short_history: 0,
    gaps: 0,
    other: 0,
  };
  const gaps: SalesRoceGap[] = [];
  for (const r of miss) {
    const sc = annual.get(r.t);
    const h = ht.get(r.t);
    let kind: SalesRoceGapKind;
    if (!sc) kind = h ? "ht_failed" : "never_fetched";
    else if (sc.years < 3) kind = "short_history";
    else kind = "gaps";
    counts[kind]++;
    gaps.push({ ...r, kind });
  }
  const order: Record<SalesRoceGapKind, number> = {
    never_fetched: 0,
    gaps: 1,
    ht_failed: 2,
    other: 3,
    short_history: 9,
  };
  const fixable = gaps
    .filter((g) => g.kind !== "short_history")
    .sort((a, b) => order[a.kind] - order[b.kind] || (b.mcap ?? 0) - (a.mcap ?? 0));
  return { counts, gaps, fixable };
}

export type FillSalesRoceResult = {
  tried: number;
  filled: number;
  left: number;
  not_found: number;
  counts: Record<SalesRoceGapKind, number>;
  screener: number;
  upstox: number;
  indianapi: number;
  yahoo: number;
};

/**
 * Fix missing Sales 3Y / ROCE 3Y: never_fetched → gaps → ht_failed.
 * Fast path: Upstox → IndianAPI → Yahoo (yfinance). Screener last for missing annual.
 * Skips short_history (&lt;3 FY columns).
 */
export async function fillMissingSalesRoce(
  onProgress: (done: number, total: number, filled: number) => void,
  opts?: { pageLimit?: number; upstoxLimit?: number; indianLimit?: number; yahooLimit?: number },
): Promise<FillSalesRoceResult> {
  const holder = globalThis as StopHolder;
  holder[FILL_STOP] = false;
  const { counts, fixable } = classifySalesRoceGaps();
  const pageLimit = Math.max(1, opts?.pageLimit ?? SALES_ROCE_PAGES_PER_RUN);
  const upstoxLimit = Math.max(0, opts?.upstoxLimit ?? Math.max(UPSTOX_STOCKS_PER_RUN, 120));
  const indianLimit = Math.max(0, opts?.indianLimit ?? INDIANAPI_STOCKS_PER_RUN);
  const yahooLimit = Math.max(0, opts?.yahooLimit ?? SALES_ROCE_YAHOO_PER_RUN);
  const ht = loadHtIvMap();
  const sinceYahoo = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const sinceUpstox = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const sinceIndian = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const detailOf = (t: string) => ht.get(t)?.detail || "";
  const upstoxTried = (t: string) => {
    const h = ht.get(t);
    return !!h && /^upstox:/i.test(detailOf(t)) && h.status !== "ok" && (h.fetched_at ?? "") >= sinceUpstox;
  };
  const indianTried = (t: string) => {
    const h = ht.get(t);
    return !!h && /^indianapi:/i.test(detailOf(t)) && h.status !== "ok" && (h.fetched_at ?? "") >= sinceIndian;
  };
  const yahooTried = (t: string) => {
    const h = ht.get(t);
    const d = detailOf(t);
    return (
      !!h &&
      h.status !== "ok" &&
      !/^upstox:/i.test(d) &&
      !/^indianapi:/i.test(d) &&
      (h.fetched_at ?? "") >= sinceYahoo
    );
  };

  const total = upstoxLimit + indianLimit + yahooLimit + pageLimit;
  let done = 0;
  let filled = 0;
  let screenerN = 0;
  let upstoxN = 0;
  let indianN = 0;
  let yahooN = 0;
  let yahooLimits = 0;
  /** Gap count before a phase — "filled" = how many left the fixable set. */
  const fixableLeft = () => classifySalesRoceGaps().fixable.length;
  let leftMark = fixableLeft();
  const creditCleared = () => {
    const now = fixableLeft();
    filled += Math.max(0, leftMark - now);
    leftMark = now;
  };
  onProgress(0, Math.max(total, 1), 0);

  const earlyReturn = (): FillSalesRoceResult => ({
    tried: done,
    filled,
    left: fixableLeft(),
    not_found: Math.max(0, done - filled),
    counts,
    screener: screenerN,
    upstox: upstoxN,
    indianapi: indianN,
    yahoo: yahooN,
  });

  // 1) Upstox first (fast, high coverage when ISIN exists).
  const useUpstox = upstoxConfigured();
  const upstoxBatch: SalesRoceGap[] = [];
  const leftover: SalesRoceGap[] = [];
  for (const r of fixable) {
    if (upstoxBatch.length >= upstoxLimit) {
      leftover.push(r);
      continue;
    }
    if (!useUpstox || upstoxTried(r.t) || !isinForTicker(r.t)) {
      leftover.push(r);
      continue;
    }
    upstoxBatch.push(r);
  }

  let upstoxRateLimited = false;
  const upstoxOutcomes = await runConcurrent(upstoxBatch, UPSTOX_FILL_CONCURRENCY, async (r) => {
    if (holder[FILL_STOP] || upstoxRateLimited) return { r, got: false as boolean, skip: true };
    try {
      const got = await fillHtIvFromUpstox({
        ticker: r.t,
        name: r.name,
        market: r.market,
        knownMcapCr: r.mcap,
      });
      return { r, got, skip: false };
    } catch (e) {
      if (e instanceof UpstoxRateLimitError) {
        upstoxRateLimited = true;
        return { r, got: false, skip: true };
      }
      return { r, got: false, skip: false };
    }
  });
  for (const o of upstoxOutcomes) {
    if (o.skip && !o.got) {
      leftover.push(o.r);
      continue;
    }
    upstoxN++;
    done++;
    if (!o.got) leftover.push(o.r);
  }
  creditCleared();
  onProgress(done, Math.max(total, done), filled);
  if (holder[FILL_STOP]) return earlyReturn();

  // 2) IndianAPI for unresolved (parallel).
  const afterUpstox = classifySalesRoceGaps().fixable;
  const useIndian = indianApiConfigured();
  const indianBatch: SalesRoceGap[] = [];
  const afterIndian: SalesRoceGap[] = [];
  for (const r of afterUpstox) {
    if (indianBatch.length >= indianLimit) {
      afterIndian.push(r);
      continue;
    }
    if (!useIndian || indianTried(r.t)) {
      afterIndian.push(r);
      continue;
    }
    indianBatch.push(r);
  }
  let indianRateLimited = false;
  const indianOutcomes = await runConcurrent(indianBatch, INDIANAPI_FILL_CONCURRENCY, async (r) => {
    if (holder[FILL_STOP] || indianRateLimited) return { r, got: false as boolean, skip: true };
    try {
      const got = await fillHtIvFromIndianApi({
        ticker: r.t,
        name: r.name,
        market: r.market,
        knownMcapCr: r.mcap,
      });
      return { r, got, skip: false };
    } catch (e) {
      if (e instanceof IndianApiRateLimitError) {
        indianRateLimited = true;
        return { r, got: false, skip: true };
      }
      return { r, got: false, skip: false };
    }
  });
  for (const o of indianOutcomes) {
    if (o.skip && !o.got) {
      afterIndian.push(o.r);
      continue;
    }
    indianN++;
    done++;
    if (!o.got) afterIndian.push(o.r);
  }
  creditCleared();
  onProgress(done, Math.max(total, done), filled);
  if (holder[FILL_STOP]) return earlyReturn();

  // 3) Yahoo / yfinance for unresolved (parallel).
  const stillNeed = classifySalesRoceGaps().fixable;
  const stillSet = new Set(stillNeed.map((r) => r.t));
  const yahooPool = afterIndian
    .filter((r) => stillSet.has(r.t) && !yahooTried(r.t))
    .concat(stillNeed.filter((r) => !afterIndian.some((x) => x.t === r.t) && !yahooTried(r.t)));
  const still = yahooPool.slice(0, yahooLimit);
  let yahooStop = false;
  const yahooOutcomes = await runConcurrent(still, YAHOO_FILL_CONCURRENCY, async (r) => {
    if (holder[FILL_STOP] || yahooStop) return { got: false as boolean, tried: false };
    try {
      const got = await fillHtIvFromYahoo({ ticker: r.t, name: r.name, market: r.market });
      return { got, tried: true };
    } catch {
      yahooLimits++;
      if (yahooLimits > 5) yahooStop = true;
      else await new Promise((s) => setTimeout(s, 30_000));
      return { got: false, tried: false };
    }
  });
  for (const o of yahooOutcomes) {
    if (!o.tried) continue;
    yahooN++;
    done++;
  }
  creditCleared();
  onProgress(done, Math.max(total, done), filled);
  if (holder[FILL_STOP]) return earlyReturn();

  // 4) Screener last — only never_fetched / ht_failed still open (gaps already have annual).
  const emptyTried = screenerTriedSince(SCREENER_EMPTY_RETRY_MS);
  const screenerBatch = classifySalesRoceGaps()
    .fixable.filter((r) => {
      if (r.kind !== "never_fetched" && r.kind !== "ht_failed") return false;
      return !emptyTried.has(r.t);
    })
    .slice(0, pageLimit);

  for (const r of screenerBatch) {
    if (holder[FILL_STOP] || screenerPausedUntil() || screenerBulkDeferred()) break;
    try {
      await fetchScreenerAllAnnual(r.t);
      screenerN++;
      done++;
    } catch (e) {
      // Pause / block → stop the batch. Soft misses (bad ticker, 404) → next.
      if (e instanceof ScreenerPausedError || /paused|blocked|429|403|captcha/i.test(String(e))) break;
      screenerN++;
      done++;
    }
    onProgress(done, Math.max(total, done), filled);
  }
  creditCleared();
  onProgress(done, Math.max(total, done), filled);

  return earlyReturn();
}

/**
 * Sales growth 3Y / ROCE 3Y / P/B for every Value stock that has none, biggest
 * first. Prefers the Sales/ROCE gap fix, then Screener BS for P/B-only rows.
 */
export async function fillValueQuality(onProgress: (done: number, total: number, filled: number) => void) {
  const holder = globalThis as StopHolder;
  holder[FILL_STOP] = false;

  // 1) Sales / ROCE gaps (never_fetched → gaps → ht_failed).
  const sales = await fillMissingSalesRoce(onProgress, {
    pageLimit: SCREENER_PAGES_PER_RUN,
    upstoxLimit: UPSTOX_STOCKS_PER_RUN,
  });
  if (holder[FILL_STOP]) {
    return { tried: sales.tried, filled: sales.filled, left: sales.left, not_found: sales.not_found };
  }

  // 2) P/B-only (Sales+ROCE already in).
  const { rows } = buildValueUniverse();
  const needBsOnly = rows
    .filter((r) => r.sales3y != null && r.roce3y != null && (r.pb == null || r.pb <= 0) && valueGapFixable(r))
    .sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0));
  const tried = screenerPagesTriedSince(SCREENER_RETRY_MS);
  const todo = needBsOnly.filter((r) => !tried.has(r.t)).slice(0, SCREENER_PAGES_PER_RUN);
  let done = sales.tried;
  let filled = sales.filled;
  const total = done + todo.length;
  onProgress(done, Math.max(total, 1), filled);
  for (const r of todo) {
    if (holder[FILL_STOP] || screenerPausedUntil() || screenerBulkDeferred()) break;
    try {
      const res = await fetchScreenerAllAnnual(r.t);
      if (res.annual || res.bs) filled++;
    } catch {
      break;
    }
    done++;
    onProgress(done, Math.max(total, done), filled);
  }
  return {
    tried: done,
    filled,
    left: classifySalesRoceGaps().fixable.length + needBsOnly.length - todo.length,
    not_found: Math.max(0, done - filled),
  };
}

// ---- Industry cycle: out of favour → hot -------------------------------------------------

export const CYCLE = {
  /** Classification on the median constituent-company return (per year). Checked in this order. */
  deepOut5y: 2,
  out3y: 0,
  extremeHot5y: 35,
  hot3y: 25,
} as const;
export type CycleStatus = "deep_out" | "out" | "extreme_hot" | "hot" | "neutral";
export type CycleRow = {
  industry: string;
  status: CycleStatus;
  /** Median company return per year; null when too few companies have that history. */
  ret3y: number | null;
  ret5y: number | null;
  n: number;
  cov3y: number;
  cov5y: number;
};

/** A window's first close must be within this many days of its start date (else the series has a hole). */
const CYCLE_START_SLACK_DAYS = 10;

let cycleCache: { at: number; data: { rows: CycleRow[]; as_of: string | null } } | null = null;

/**
 * Each industry's median 3-year and 5-year return per year (CAGR) across its
 * companies, from the stored daily prices. Median, not average: one stock with
 * an unadjusted capital reduction (SWANDEF ₹38 → ₹2,865) must not label a whole
 * industry. Rights / partly-paid lines are left out, as on the Value page.
 * Classified:
 * deep out of favour 5Y < 2% · out of favour 3Y < 0% · extremely hot 5Y > 35% ·
 * hot 3Y > 25% · neutral the rest.
 */
export async function buildIndustryCycle(opts?: { fresh?: boolean }): Promise<{ rows: CycleRow[]; as_of: string | null }> {
  if (!opts?.fresh && cycleCache && Date.now() - cycleCache.at < 30 * 60_000) return cycleCache.data;
  const scan = buildScannerData();
  const years = rotationFetchYears();
  let asOf: string | null = null;
  const rows0 = scan.rows.filter((r) => r.industry && !isRightsOrPartlyPaid(r.t, r.name));
  const per = await runConcurrent(rows0, 8, async (r) => {
    if (!r.industry) return null;
    try {
      const bars = await rotationCloses(r.t, r.market || "NSE", years);
      if (bars.length < 60) return null;
      const last = bars[bars.length - 1]!;
      if (Date.now() - Date.parse(`${last.date}T12:00:00Z`) > 21 * 86_400_000) return null;
      if (!asOf || last.date > asOf) asOf = last.date;
      const at = (y: number) => {
        const d = new Date(`${last.date}T00:00:00Z`);
        d.setUTCFullYear(d.getUTCFullYear() - y);
        const want = d.toISOString().slice(0, 10);
        // First bar on/after the date, but only if the series really starts by then
        // and has no hole there (SICAGEN's "5-year" start was 7 months ago).
        if (bars[0]!.date > want) return null;
        const b = bars.find((x) => x.date >= want);
        if (!b || !(b.close > 0)) return null;
        const lateDays = (Date.parse(`${b.date}T00:00:00Z`) - Date.parse(`${want}T00:00:00Z`)) / 86_400_000;
        return lateDays <= CYCLE_START_SLACK_DAYS ? b.close : null;
      };
      const c3 = at(3);
      const c5 = at(5);
      return {
        industry: r.industry,
        r3: c3 ? (Math.pow(last.close / c3, 1 / 3) - 1) * 100 : null,
        r5: c5 ? (Math.pow(last.close / c5, 1 / 5) - 1) * 100 : null,
      };
    } catch {
      return null;
    }
  });
  const by = new Map<string, { n: number; r3: number[]; r5: number[] }>();
  for (const r of rows0) {
    if (!r.industry) continue;
    const e = by.get(r.industry) ?? { n: 0, r3: [], r5: [] };
    e.n++;
    by.set(r.industry, e);
  }
  for (const p of per) {
    if (!p) continue;
    const e = by.get(p.industry)!;
    if (p.r3 != null) e.r3.push(p.r3);
    if (p.r5 != null) e.r5.push(p.r5);
  }
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  const rows: CycleRow[] = [];
  for (const [industry, e] of by) {
    const ret3y = median(e.r3);
    const ret5y = median(e.r5);
    if (ret3y == null && ret5y == null) continue;
    // A horizon only counts when enough of the industry has that much history
    // (≥ 3 stocks and ≥ half of them): one old stock must not label a group of
    // recent listings (e.g. New age Platform E Retail = Nykaa + 5 new IPOs).
    const need = Math.max(Math.min(3, e.n), Math.ceil(e.n / 2));
    const c3 = e.r3.length >= need ? ret3y : null;
    const c5 = e.r5.length >= need ? ret5y : null;
    const status: CycleStatus =
      c5 != null && c5 < CYCLE.deepOut5y
        ? "deep_out"
        : c3 != null && c3 < CYCLE.out3y
          ? "out"
          : c5 != null && c5 > CYCLE.extremeHot5y
            ? "extreme_hot"
            : c3 != null && c3 > CYCLE.hot3y
              ? "hot"
              : "neutral";
    const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
    // Uncounted horizons are not shown either: a figure that contradicts the label misleads.
    rows.push({ industry, status, ret3y: r2(c3), ret5y: r2(c5), n: e.n, cov3y: e.r3.length, cov5y: e.r5.length });
  }
  rows.sort((a, b) => (a.ret3y ?? 1e9) - (b.ret3y ?? 1e9));
  const data = { rows, as_of: asOf };
  cycleCache = { at: Date.now(), data };
  return data;
}

// ---- Sector valuation: % of companies under / over their own history --------------------

export const VAL = {
  /** Under / over = current P/E this far below / above the company's 5-year median P/E. */
  band: 0.15,
  /** Extreme under / over = twice the soft band (30%). */
  extremeBand: 0.3,
  years: 5,
  minYears: 3,
} as const;
export type ValVerdict = "under" | "fair" | "over";
export type ValDistKey = "extreme_under" | "under" | "fair" | "over" | "extreme_over";
export type ValStock = { t: string; name: string; pe: number; peMedian: number; ratio: number; verdict: ValVerdict };
export type ValSector = {
  industry: string;
  n: number;
  scored: number;
  under: number;
  over: number;
  under_pct: number;
  over_pct: number;
  stocks: ValStock[];
};
export type ValDistribution = {
  analyzed: number;
  buckets: Array<{ key: ValDistKey; label: string; n: number }>;
};
export type ValMcapSegment = {
  key: string;
  label: string;
  n: number;
  under_pct: number;
  over_pct: number;
};
export type ValGraphs = {
  distribution: ValDistribution;
  mcap_segments: ValMcapSegment[];
};

const VAL_DIST_LABELS: Record<ValDistKey, string> = {
  extreme_under: "Extremely Undervalued",
  under: "Undervalued",
  fair: "Fairly Valued",
  over: "Overvalued",
  extreme_over: "Extremely Overvalued",
};

/** Market-cap buckets (₹ Cr) for Segment Under/Over % — same bands as the reference UI. */
const VAL_MCAP_BANDS: Array<{ key: string; label: string; min: number; max: number | null }> = [
  { key: "0-100", label: "0-100 Cr", min: 0, max: 100 },
  { key: "100-250", label: "100-250 Cr", min: 100, max: 250 },
  { key: "250-500", label: "250-500 Cr", min: 250, max: 500 },
  { key: "500-1000", label: "500-1000 Cr", min: 500, max: 1000 },
  { key: "1000-2500", label: "1000-2500 Cr", min: 1000, max: 2500 },
  { key: "2500-5000", label: "2500-5000 Cr", min: 2500, max: 5000 },
  { key: "5000-10000", label: "5000-10000 Cr", min: 5000, max: 10000 },
  { key: "10000-20000", label: "10000-20000 Cr", min: 10000, max: 20000 },
  { key: "20000-50000", label: "20000-50000 Cr", min: 20000, max: 50000 },
  { key: "50000+", label: "Above 50000 Cr", min: 50000, max: null },
];

export function valDistKey(ratio: number): ValDistKey {
  if (ratio < 1 - VAL.extremeBand) return "extreme_under";
  if (ratio < 1 - VAL.band) return "under";
  if (ratio > 1 + VAL.extremeBand) return "extreme_over";
  if (ratio > 1 + VAL.band) return "over";
  return "fair";
}

function valMcapBand(mcap: number | null | undefined) {
  if (mcap == null || !Number.isFinite(mcap) || mcap < 0) return null;
  for (const b of VAL_MCAP_BANDS) {
    if (mcap >= b.min && (b.max == null || mcap < b.max)) return b;
  }
  return VAL_MCAP_BANDS[VAL_MCAP_BANDS.length - 1]!;
}

let valCache: {
  at: number;
  data: { rows: ValSector[]; as_of: string | null; distribution: ValDistribution; mcap_segments: ValMcapSegment[] };
} | null = null;

/**
 * For every company with Screener annual EPS: P/E at each year end (price on
 * that date ÷ that year's EPS) over the last 5 years → median, vs today's P/E
 * (price ÷ last-4-quarter EPS, else latest annual EPS). Loss years are skipped.
 * A sector's undervalued % = share of its scored companies more than 15% below
 * their own median P/E (overvalued: more than 15% above).
 */
export async function buildSectorValuation(opts?: {
  fresh?: boolean;
}): Promise<{
  rows: ValSector[];
  as_of: string | null;
  distribution: ValDistribution;
  mcap_segments: ValMcapSegment[];
}> {
  if (!opts?.fresh && valCache && Date.now() - valCache.at < 30 * 60_000) return valCache.data;
  const scan = buildScannerData();
  const annual = new Map<string, { dates: string[]; eps: Array<number | null> }>();
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, annual_json FROM screener_annual_cache`).all() as Array<{
        t: string;
        annual_json: string;
      }>) {
        try {
          const a = JSON.parse(r.annual_json) as { dates: string[]; eps: Array<number | null> };
          if (a.dates?.length) annual.set(r.t, a);
        } catch {
          /* skip */
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* none */
  }
  const years = rotationFetchYears();
  let asOf: string | null = null;
  const per = await runConcurrent(scan.rows, 8, async (r) => {
    const a = annual.get(r.t);
    if (!a || !r.industry) return null;
    try {
      const bars = await rotationCloses(r.t, r.market || "NSE", years);
      if (bars.length < 200) return null;
      const last = bars[bars.length - 1]!;
      if (!asOf || last.date > asOf) asOf = last.date;
      const priceOn = (date: string) => {
        if (bars[0]!.date > date) return null;
        let hit: number | null = null;
        for (const b of bars) {
          if (b.date > date) break;
          hit = b.close;
        }
        return hit;
      };
      // Year-end P/Es over the last 5 years (annual columns only, positive EPS).
      const months = new Map<string, number>();
      for (const d of a.dates) months.set(d.slice(5, 7), (months.get(d.slice(5, 7)) ?? 0) + 1);
      const main = [...months].sort((x, y) => y[1] - x[1])[0]?.[0];
      const pes: number[] = [];
      a.dates.forEach((d, i) => {
        if (d.slice(5, 7) !== main) return;
        const e = a.eps[i];
        if (e == null || e <= 0) return;
        const p = priceOn(d);
        if (p != null) pes.push(p / e);
      });
      const hist = pes.slice(-VAL.years);
      if (hist.length < VAL.minYears) return null;
      const sorted = [...hist].sort((x, y) => x - y);
      const med = sorted.length % 2 ? sorted[sorted.length >> 1]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
      // Today's EPS: last 4 quarters, else latest annual.
      const qs = trailingYear(loadCachedQuartersSeries(r.t) ?? [], Date.now(), (q) => q.eps != null);
      const ttm = qs ? qs.reduce((s, q) => s + (q.eps as number), 0) : null;
      const lastAnnual = [...a.eps].reverse().find((e) => e != null) ?? null;
      const epsNow = ttm ?? lastAnnual;
      if (epsNow == null || epsNow <= 0 || med <= 0) return null;
      const pe = last.close / epsNow;
      const ratio = pe / med;
      const verdict: ValVerdict = ratio < 1 - VAL.band ? "under" : ratio > 1 + VAL.band ? "over" : "fair";
      return {
        industry: r.industry,
        mcap: r.mcap,
        s: {
          t: r.t,
          name: r.name,
          pe: Math.round(pe * 10) / 10,
          peMedian: Math.round(med * 10) / 10,
          ratio: Math.round(ratio * 100) / 100,
          verdict,
        },
      };
    } catch {
      return null;
    }
  });
  const by = new Map<string, ValSector>();
  for (const r of scan.rows) {
    if (!r.industry) continue;
    const e = by.get(r.industry) ?? { industry: r.industry, n: 0, scored: 0, under: 0, over: 0, under_pct: 0, over_pct: 0, stocks: [] };
    e.n++;
    by.set(r.industry, e);
  }
  const mcapAcc = new Map<string, { n: number; under: number; over: number }>();
  for (const b of VAL_MCAP_BANDS) mcapAcc.set(b.key, { n: 0, under: 0, over: 0 });
  for (const p of per) {
    if (!p) continue;
    const e = by.get(p.industry)!;
    e.scored++;
    if (p.s.verdict === "under") e.under++;
    if (p.s.verdict === "over") e.over++;
    e.stocks.push(p.s);
    const band = valMcapBand(p.mcap);
    if (band) {
      const m = mcapAcc.get(band.key)!;
      m.n += 1;
      const dist = valDistKey(p.s.ratio);
      if (dist === "under" || dist === "extreme_under") m.under += 1;
      if (dist === "over" || dist === "extreme_over") m.over += 1;
    }
  }
  const rows = [...by.values()].filter((e) => e.scored > 0);
  for (const e of rows) {
    e.under_pct = Math.round((e.under / e.scored) * 1000) / 10;
    e.over_pct = Math.round((e.over / e.scored) * 1000) / 10;
    e.stocks.sort((x, y) => x.ratio - y.ratio);
  }
  const counts: Record<ValDistKey, number> = {
    extreme_under: 0,
    under: 0,
    fair: 0,
    over: 0,
    extreme_over: 0,
  };
  for (const e of rows) {
    for (const s of e.stocks) counts[valDistKey(s.ratio)] += 1;
  }
  const order: ValDistKey[] = ["extreme_under", "under", "fair", "over", "extreme_over"];
  const distribution: ValDistribution = {
    analyzed: order.reduce((a, k) => a + counts[k], 0),
    buckets: order.map((key) => ({ key, label: VAL_DIST_LABELS[key], n: counts[key] })),
  };
  const mcap_segments: ValMcapSegment[] = VAL_MCAP_BANDS.map((b) => {
    const m = mcapAcc.get(b.key)!;
    return {
      key: b.key,
      label: b.label,
      n: m.n,
      under_pct: m.n ? Math.round((m.under / m.n) * 1000) / 10 : 0,
      over_pct: m.n ? Math.round((m.over / m.n) * 1000) / 10 : 0,
    };
  }).filter((s) => s.n > 0);
  const data = { rows, as_of: asOf, distribution, mcap_segments };
  valCache = { at: Date.now(), data };
  return data;
}
