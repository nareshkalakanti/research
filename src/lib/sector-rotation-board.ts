import { loadAllCompanies } from "./db";
import { fetchNifty500DailyBars } from "./ohlc";
import { masterLabels } from "./stock-master";
import { cachedRotationCloses, onRotationBarsRefreshed, rotationCloses } from "./rotation-bars";
import { isRightsOrPartlyPaid } from "./listing-name-match";
import { loadMetricsMap, refreshPagePrices, upsertMetrics } from "./metrics";
import { tradingviewUrl } from "./links";
import { runConcurrent } from "./scrape-pool";
import {
  listRotationSectors,
  type RotationSector,
  type SectorMember,
} from "./sector-rotation";
import { NIFTY_INDEX_META } from "./nse-index-constituents";
import {
  barsCoverWindow,
  capWeightIndex,
  downsampleSeries,
  equalWeightIndex,
  rebaseCloses,
  rotationFetchYears,
  rotationMaxLookbackStart,
  ROTATION_RANGES,
  rotationWindowStart,
  seriesReturnPct,
  stitchWarmup,
  windowRebaseSeries,
  windowReturnPct,
  type SeriesPoint,
} from "./sector-rotation-series";
import {
  fetchScreenerAnnual,
  fetchScreenerAnnualBs,
} from "./screener-annual";
import { screenerPausedUntil } from "./screener-fetch";
import { fetchScreenerTopRatios } from "./screener-ratios";
import { fetchHtIvForTicker } from "./strategy/ht-fetch";
import { rankIntrinsicValue } from "./strategy/ht-math";
import { loadHtIvMap, upsertHtIvRows } from "./strategy/ht-store";
import type { HtCachedRow, HtStockRow } from "./strategy/ht-types";

/** Complete HT legs usable for intra-sector ranking (freshness optional). */
function htRankable(ht: HtCachedRow | undefined): boolean {
  return (
    !!ht &&
    ht.status === "ok" &&
    ht.sales_growth_3y != null &&
    ht.roce_3y != null &&
    ht.pb != null &&
    ht.pb > 0
  );
}

function isHtRateLimited(row: HtCachedRow): boolean {
  return /too many requests|rate.?limit|429|Edge:\s*Too Many/i.test(
    row.detail || "",
  );
}

function salesCagr3yPct(sales: Array<number | null>): number | null {
  const vals = sales.filter(
    (v): v is number => v != null && Number.isFinite(v) && v > 0,
  );
  if (vals.length < 2) return null;
  const latest = vals[vals.length - 1]!;
  // Prefer true 3Y (4 points); else longest available span for young listings.
  const span = Math.min(3, vals.length - 1);
  const prior = vals[vals.length - 1 - span]!;
  if (prior <= 0) return null;
  return Math.round(((latest / prior) ** (1 / span) - 1) * 10000) / 100;
}

function roceAvg3yPct(roce: Array<number | null>): number | null {
  const vals: number[] = [];
  for (let i = roce.length - 1; i >= 0 && vals.length < 3; i--) {
    const v = roce[i];
    if (v == null || !Number.isFinite(v)) continue;
    // Screener annual series is usually percent; tolerate ratios.
    vals.push(Math.abs(v) <= 1.5 ? v * 100 : v);
  }
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

/** Screener fallback when Yahoo HT is rate-limited / incomplete. */
async function fetchHtIvFromScreener(opts: {
  ticker: string;
  market?: string | null;
  name?: string | null;
  /** Bypass Screener TTL so a prior empty scrape does not stick. */
  force?: boolean;
}): Promise<HtCachedRow> {
  const ticker = opts.ticker.toUpperCase();
  const now = new Date().toISOString();
  const force = opts.force === true;
  try {
    const [annual, bs, ratios] = await Promise.all([
      fetchScreenerAnnual(ticker, { force }),
      fetchScreenerAnnualBs(ticker, { force }),
      fetchScreenerTopRatios(ticker, { force }),
    ]);
    const growth = salesCagr3yPct(annual.sales);
    const roce = roceAvg3yPct(annual.roce);
    const bookCr = [...(bs.book_value || [])]
      .reverse()
      .find((v) => v != null && v > 0);
    const mcap = ratios.market_cap_cr;
    const price = ratios.current_price;
    let pb: number | null = null;
    if (mcap != null && mcap > 0 && bookCr != null && bookCr > 0) {
      pb = Math.round((mcap / bookCr) * 100) / 100;
    }
    if (
      growth != null &&
      roce != null &&
      pb != null &&
      pb > 0
    ) {
      return {
        ticker,
        market: opts.market ?? null,
        name: opts.name ?? null,
        price: price ?? null,
        market_cap_cr: mcap ?? null,
        sales_growth_3y: growth,
        earnings_growth_3y: null,
        roce_3y: roce,
        pb,
        pe_ratio: ratios.stock_pe ?? null,
        status: "ok",
        detail: "screener",
        fetched_at: now,
      };
    }
    return {
      ticker,
      market: opts.market ?? null,
      name: opts.name ?? null,
      price: price ?? null,
      market_cap_cr: mcap ?? null,
      sales_growth_3y: growth,
      earnings_growth_3y: null,
      roce_3y: roce,
      pb,
      pe_ratio: ratios.stock_pe ?? null,
      status: "failed",
      detail: `screener incomplete (g=${growth} roce=${roce} pb=${pb})`,
      fetched_at: now,
    };
  } catch (e) {
    return {
      ticker,
      market: opts.market ?? null,
      name: opts.name ?? null,
      price: null,
      market_cap_cr: null,
      sales_growth_3y: null,
      earnings_growth_3y: null,
      roce_3y: null,
      pb: null,
      pe_ratio: null,
      status: "failed",
      detail: e instanceof Error ? e.message.slice(0, 120) : "screener failed",
      fetched_at: now,
    };
  }
}

/**
 * Ensure HT IV legs for sector members.
 * - Keep existing ok rows when Yahoo rate-limits
 * - Fall back to Screener for Sales/ROCE/P/B
 * - Serial-ish Yahoo to reduce 429s
 */
async function ensureHtIvForMembers(
  members: SectorMember[],
): Promise<Map<string, HtCachedRow>> {
  const cache = loadHtIvMap();
  const need = members.filter((m) => !htRankable(cache.get(m.ticker.toUpperCase())));
  if (!need.length || screenerPausedUntil()) return cache;

  const batch = need.slice(0, 24);
  const results: HtCachedRow[] = await runConcurrent(batch, 2, async (m) => {
    const prev = cache.get(m.ticker.toUpperCase());
    let row = await fetchHtIvForTicker({
      ticker: m.ticker,
      market: m.market,
      name: m.name,
    });
    if (!htRankable(row)) {
      // Don't let 429 wipe a previously good row.
      if (isHtRateLimited(row) && htRankable(prev)) return prev!;
      const viaScreener = await fetchHtIvFromScreener({
        ticker: m.ticker,
        market: m.market,
        name: m.name,
      });
      if (htRankable(viaScreener)) row = viaScreener;
      else if (htRankable(prev)) return prev!;
    }
    return row;
  });

  const toSave = results.filter((r) => {
    if (htRankable(r)) return true;
    // Persist hard fails, but never replace ok data with rate-limit noise.
    if (isHtRateLimited(r)) return false;
    const prev = cache.get(r.ticker.toUpperCase());
    return !htRankable(prev);
  });
  if (toSave.length) upsertHtIvRows(toSave);
  return loadHtIvMap();
}

export function countMissingHtIv(members: SectorMember[]): number {
  const cache = loadHtIvMap();
  return members.filter((m) => !htRankable(cache.get(m.ticker.toUpperCase())))
    .length;
}

/**
 * User-triggered fill for Sales Growth / ROCE / P/B gaps.
 * Prefer Screener (Yahoo often 429s); process every incomplete member.
 */
const HT_PER_CLICK = 40;
/** Screener fallbacks per click (3 pages each); the 30-min job does the rest slowly. */
const SCREENER_PER_CLICK = 6;

export async function refreshMissingHtIvForMembers(
  members: SectorMember[],
): Promise<{ tried: number; filled: number; still_missing: number }> {
  const cache = loadHtIvMap();
  const missing = members.filter(
    (m) => !htRankable(cache.get(m.ticker.toUpperCase())),
  );
  if (!missing.length) {
    return { tried: 0, filled: 0, still_missing: 0 };
  }
  // At most HT_PER_CLICK stocks per click. Yahoo first (fast, separate
  // limits); Screener (throttled, 3 pages each) only for what Yahoo lacks and
  // only while Screener isn't paused. Click again for the next lot.
  const need = missing.slice(0, HT_PER_CLICK);
  let screenerLeft = SCREENER_PER_CLICK;

  const got = await runConcurrent(need, 2, async (m): Promise<HtCachedRow | null> => {
    const prev = cache.get(m.ticker.toUpperCase());
    const viaYahoo = await fetchHtIvForTicker({
      ticker: m.ticker,
      market: m.market,
      name: m.name,
    });
    if (htRankable(viaYahoo)) return viaYahoo;
    // Screener blocks bursts — only a few fallbacks per click.
    if (screenerLeft <= 0 || screenerPausedUntil()) return htRankable(prev) ? prev! : null;
    screenerLeft -= 1;
    const viaScreener = await fetchHtIvFromScreener({
      ticker: m.ticker,
      market: m.market,
      name: m.name,
      force: true,
    });
    if (htRankable(viaScreener)) return viaScreener;
    if (htRankable(prev)) return prev!;
    return isHtRateLimited(viaYahoo) ? viaScreener : viaYahoo;
  });

  const results = got.filter((r): r is HtCachedRow => !!r);
  const toSave = results.filter((r) => {
    if (htRankable(r)) return true;
    if (isHtRateLimited(r)) return false;
    const prev = cache.get(r.ticker.toUpperCase());
    return !htRankable(prev);
  });
  if (toSave.length) upsertHtIvRows(toSave);

  const next = loadHtIvMap();
  const filled = need.filter((m) =>
    htRankable(next.get(m.ticker.toUpperCase())),
  ).length;
  const still_missing = missing.length - filled;
  return { tried: need.length, filled, still_missing };
}

/**
 * Rotation members without Sales growth / ROCE / P/B, biggest first (₹200 Cr+
 * names are what Top stocks ranks by default). Skips `skip` (tried recently).
 */
export function missingHtIvQueue(skip: Set<string>): SectorMember[] {
  const cache = loadHtIvMap();
  const metrics = loadMetricsMap();
  const seen = new Map<string, SectorMember>();
  for (const s of listRotationSectors()) {
    for (const m of s.members) {
      const k = m.ticker.toUpperCase();
      if (seen.has(k) || skip.has(k) || htRankable(cache.get(k))) continue;
      seen.set(k, m);
    }
  }
  const cap = (m: SectorMember) => metrics.get(m.ticker.toUpperCase())?.market_cap_cr ?? 0;
  return [...seen.values()].sort((a, b) => cap(b) - cap(a));
}

/**
 * Fill one stock's quality legs (Screener only, so the background job stays on
 * the throttled path). Returns true when it is now rankable. Throws
 * ScreenerPausedError-style errors when Screener is paused.
 */
export async function fillHtIvForMember(m: SectorMember): Promise<boolean> {
  if (screenerPausedUntil()) throw new Error("Screener paused");
  const cache = loadHtIvMap();
  const prev = cache.get(m.ticker.toUpperCase());
  const row = await fetchHtIvFromScreener({ ticker: m.ticker, market: m.market, name: m.name, force: true });
  if (htRankable(row)) {
    upsertHtIvRows([row]);
    return true;
  }
  if (!isHtRateLimited(row) && !htRankable(prev)) upsertHtIvRows([row]);
  if (screenerPausedUntil()) throw new Error("Screener paused");
  return false;
}

/**
 * Fill one stock's quality legs from Yahoo (annual results + balance sheet,
 * P/B from the quote). Fast and outside Screener's budget; misses most SME /
 * small BSE names. Throws when Yahoo rate-limits so the caller can stop.
 */
export async function fillHtIvFromYahoo(m: SectorMember): Promise<boolean> {
  const row = await fetchHtIvForTicker({ ticker: m.ticker, market: m.market, name: m.name });
  if (htRankable(row)) {
    upsertHtIvRows([row]);
    return true;
  }
  if (isHtRateLimited(row)) throw new Error("Yahoo rate-limited");
  return false;
}

export async function refreshAllMissingHtIv(): Promise<{
  tried: number;
  filled: number;
  still_missing: number;
}> {
  const seen = new Map<string, SectorMember>();
  for (const s of listRotationSectors()) {
    for (const m of s.members) {
      const k = m.ticker.toUpperCase();
      if (!seen.has(k)) seen.set(k, m);
    }
  }
  return refreshMissingHtIvForMembers([...seen.values()]);
}

export type RotationMemberHtPatch = {
  ticker: string;
  sales_growth_3y: number | null;
  roce_3y: number | null;
  pb: number | null;
  growth_rank: number | null;
  roce_rank: number | null;
  pb_rank: number | null;
  total_score: number | null;
  rank: number | null;
};

/**
 * Rank HT legs from cache only — no OHLC / chart rebuild.
 * Used after "Refresh missing" so the UI can patch the table in place.
 */
export function loadRotationMemberHtPatches(
  members: SectorMember[],
  sectorLabel: string,
  pre?: { cache: Map<string, HtCachedRow>; metrics: ReturnType<typeof loadMetricsMap> },
): RotationMemberHtPatch[] {
  const cache = pre?.cache ?? loadHtIvMap();
  const metrics = pre?.metrics ?? loadMetricsMap();
  const base = members.map((m) => {
    const key = m.ticker.toUpperCase();
    const ht = cache.get(key);
    const ok = htRankable(ht);
    const met = metrics.get(key);
    return {
      ticker: key,
      market: m.market,
      name: m.name,
      price: met?.price ?? ht?.price ?? null,
      market_cap_cr: met?.market_cap_cr ?? ht?.market_cap_cr ?? null,
      sales_growth_3y: ok ? ht!.sales_growth_3y : null,
      roce_3y: ok ? ht!.roce_3y : null,
      pb: ok ? ht!.pb : null,
    };
  });
  const htRows: HtStockRow[] = base
    .filter(
      (m) =>
        m.sales_growth_3y != null &&
        m.roce_3y != null &&
        m.pb != null &&
        m.pb > 0,
    )
    .map((m) => ({
      ticker: m.ticker,
      market: m.market,
      name: m.name,
      sector: sectorLabel,
      sub_sector: null,
      price: m.price,
      market_cap_cr: m.market_cap_cr,
      sales_growth_3y: m.sales_growth_3y!,
      roce_3y: m.roce_3y!,
      pb: m.pb!,
      pe_ratio: null,
    }));
  const ranked = rankIntrinsicValue(htRows);
  const byTicker = new Map(ranked.map((r) => [r.ticker.toUpperCase(), r]));
  return base.map((m) => {
    const r = byTicker.get(m.ticker);
    return {
      ticker: m.ticker,
      sales_growth_3y: m.sales_growth_3y,
      roce_3y: m.roce_3y,
      pb: m.pb,
      growth_rank: r?.growth_rank ?? null,
      roce_rank: r?.roce_rank ?? null,
      pb_rank: r?.pb_rank ?? null,
      total_score: r?.total_score ?? null,
      rank: r?.rank ?? null,
    };
  });
}

/** Refresh Yahoo quotes for members missing price / mcap / today %. */
export async function refreshRotationMemberMetrics(
  members: SectorMember[],
  opts?: { force?: boolean },
): Promise<number> {
  if (!members.length) return 0;
  return refreshPagePrices(
    members.map((m) => ({ ticker: m.ticker, market: m.market })),
    { force: opts?.force, concurrency: 8 },
  );
}

export async function refreshAllRotationMetricsGaps(): Promise<number> {
  const seen = new Map<string, SectorMember>();
  for (const s of listRotationSectors()) {
    for (const m of s.members) {
      const k = m.ticker.toUpperCase();
      if (!seen.has(k)) seen.set(k, m);
    }
  }
  const metrics = loadMetricsMap();
  const gaps = [...seen.values()].filter((m) => {
    const row = metrics.get(m.ticker.toUpperCase());
    return (
      !row ||
      row.price == null ||
      row.market_cap_cr == null ||
      row.change_pct == null
    );
  });
  return refreshRotationMemberMetrics(gaps, { force: true });
}

export type RotationMemberRow = {
  ticker: string;
  name: string;
  market: string;
  mcap_cr: number | null;
  price: number | null;
  change_pct: number | null;
  window_pct: number | null;
  spark: SeriesPoint[];
  /** Long unrebased-to-window path for client range switches. */
  spark_full?: SeriesPoint[];
  tv_url: string;
  /** Hard-Truth / Ranked Companies legs (within this sector). */
  sales_growth_3y?: number | null;
  roce_3y?: number | null;
  pb?: number | null;
  growth_rank?: number | null;
  roce_rank?: number | null;
  pb_rank?: number | null;
  total_score?: number | null;
  rank?: number | null;
};

export type RotationSectorCard = {
  id: string;
  label: string;
  n: number;
  up: number;
  down: number;
  starred: boolean;
  sector_pct: number | null;
  bench_pct: number | null;
  today_pct: number | null;
  search: string;
  /** Member market caps (₹ Cr) — client min/max mcap filter. */
  mcaps: Array<number | null>;
  /** Member tickers (upper) — parallel to mcaps; client Nifty 500 filter. */
  tickers: string[];
  sector: SeriesPoint[];
  bench: SeriesPoint[];
  /** Sector line with moving-average warm-up, valid for `window_range` only. */
  sector_full?: SeriesPoint[];
  bench_full?: SeriesPoint[];
  /** Period the sector series was built for; its stock set differs by period. */
  window_range?: string;
};

/** Metrics older than this are ignored when no bars are at hand (lite board). */
const STALE_METRICS_MS = 3 * 86_400_000;

function dayStats(
  members: SectorMember[],
  metrics: ReturnType<typeof loadMetricsMap>,
  packed?: Array<{ member: SectorMember; bars: Array<{ date: string; close: number }> }>,
): { today_pct: number | null; up: number; down: number } {
  let up = 0;
  let down = 0;
  let sum = 0;
  let n = 0;
  const now = Date.now();
  const changes = packed
    ? packed.map(({ member, bars }) => priceAndChange(metrics.get(member.ticker.toUpperCase()), bars).change_pct)
    : members.map((m) => {
        const row = metrics.get(m.ticker.toUpperCase());
        const at = row?.fetched_at ? Date.parse(row.fetched_at) : NaN;
        // Without bars, a weeks-old change_pct is worse than none.
        return Number.isFinite(at) && now - at < STALE_METRICS_MS ? row!.change_pct : null;
      });
  for (const ch of changes) {
    if (ch == null || !Number.isFinite(ch)) continue;
    n += 1;
    sum += ch;
    if (ch > 0) up += 1;
    else if (ch < 0) down += 1;
  }
  return {
    today_pct: n ? sum / n : null,
    up,
    down,
  };
}

const IST_OFFSET_MS = 5.5 * 3_600_000;

/**
 * Price and day change for a row. metrics.db can lag by weeks for thinly
 * refreshed tickers (e.g. VIPULORG showed +3.53% from Oct 23), while the
 * rotation bars refresh after every close — so the bars win unless the
 * metrics row was fetched on a later IST day than the last bar.
 */
function priceAndChange(
  m: { price: number | null; change_pct: number | null; fetched_at: string } | undefined,
  bars: Array<{ date: string; close: number }>,
): { price: number | null; change_pct: number | null } {
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const barPrice = last && Number.isFinite(last.close) ? last.close : null;
  const barChange =
    barPrice != null && prev && prev.close > 0 ? ((barPrice - prev.close) / prev.close) * 100 : null;
  const fetchedMs = m?.fetched_at ? Date.parse(m.fetched_at) : NaN;
  const metricsDay = Number.isFinite(fetchedMs)
    ? new Date(fetchedMs + IST_OFFSET_MS).toISOString().slice(0, 10)
    : "";
  const metricsNewer = !!m && (!last || metricsDay > last.date);
  return {
    price: metricsNewer ? m!.price ?? barPrice : barPrice ?? m?.price ?? null,
    change_pct: metricsNewer ? m!.change_pct ?? barChange : barChange ?? m?.change_pct ?? null,
  };
}

async function memberBars(members: SectorMember[], years: number) {
  const bars = await runConcurrent(members, 4, async (m) => {
    try {
      return await rotationCloses(m.ticker, m.market, years);
    } catch {
      return [];
    }
  });
  return members.map((m, i) => ({ member: m, bars: bars[i] ?? [] }));
}

/**
 * Nifty 500 bars or a clear error. An empty benchmark (Yahoo rate limit)
 * used to give `as_of` "" → every window started in 1970, so cards showed
 * whole-history returns (+30,000%) for every range.
 */
async function niftyBarsOrThrow(years: number) {
  const bars = await fetchNifty500DailyBars(years);
  if (!bars.length || !bars[bars.length - 1]?.date) {
    throw new Error(
      "Nifty 500 prices unavailable right now (Yahoo) — returns not computed. Try again in a minute.",
    );
  }
  return bars;
}

export type RotationWeight = "equal" | "cap";

type PackedMember = { member: SectorMember; bars: Array<{ date: string; close: number }> };

/** Drop rights / partly-paid stubs so they don't dilute the sector line. */
function coreMembers(packed: PackedMember[]): PackedMember[] {
  const core = packed.filter(
    (p) => !isRightsOrPartlyPaid(p.member.ticker, p.member.name),
  );
  return core.length ? core : packed;
}

/**
 * Sector line for one period: only stocks with prices across the whole period,
 * each starting at the same base on the first day. A recent listing can't
 * inflate the return. `long` adds earlier history for moving-average warm-up.
 */
function sectorWindow(
  packed: PackedMember[],
  start: string,
  lookback: string,
  weight: RotationWeight,
  metrics: ReturnType<typeof loadMetricsMap>,
): { windowed: SeriesPoint[]; long: SeriesPoint[] } {
  const use = coreMembers(packed).filter((p) => barsCoverWindow(p.bars, start));
  if (!use.length) return { windowed: [], long: [] };
  const windowed = sectorIndex(use, start, weight, metrics);
  return {
    windowed,
    long: stitchWarmup(sectorIndex(use, lookback, weight, metrics), windowed),
  };
}

function sectorIndex(
  packed: PackedMember[],
  start: string,
  weight: RotationWeight,
  metrics: ReturnType<typeof loadMetricsMap>,
) {
  const use = coreMembers(packed);
  if (weight === "cap") {
    return capWeightIndex(
      use.map((p) => ({
        bars: p.bars,
        mcap: metrics.get(p.member.ticker.toUpperCase())?.market_cap_cr ?? null,
      })),
      start,
    );
  }
  return equalWeightIndex(
    use.map((p) => p.bars),
    start,
  );
}

function memberMcaps(
  members: SectorMember[],
  metrics: ReturnType<typeof loadMetricsMap>,
): Array<number | null> {
  return members.map((m) => metrics.get(m.ticker.toUpperCase())?.market_cap_cr ?? null);
}

function liteCard(
  s: RotationSector,
  metrics: ReturnType<typeof loadMetricsMap>,
): RotationSectorCard {
  const members = s.members;
  const day = dayStats(members, metrics);
  return {
    id: s.id,
    label: s.label,
    n: members.length,
    up: day.up,
    down: day.down,
    starred: s.starred,
    sector_pct: null,
    bench_pct: null,
    today_pct: day.today_pct,
    search: [s.label, ...members.map((m) => `${m.ticker} ${m.name}`)]
      .join(" ")
      .toLowerCase(),
    mcaps: memberMcaps(members, metrics),
    tickers: members.map((m) => m.ticker.toUpperCase()),
    sector: [],
    bench: [],
  };
}

async function cardWithSeries(
  s: RotationSector,
  years: number,
  start: string,
  lookback: string,
  weight: RotationWeight,
  metrics: ReturnType<typeof loadMetricsMap>,
  benchLong: SeriesPoint[],
  windowRange: string,
  spark = true,
): Promise<RotationSectorCard> {
  const members = s.members;
  const packed = await memberBars(members, years);
  const { windowed, long: seriesLong } = sectorWindow(packed, start, lookback, weight, metrics);
  const benchWin = windowRebaseSeries(benchLong, start);
  const day = dayStats(members, metrics, packed);
  return {
    id: s.id,
    label: s.label,
    n: members.length,
    up: day.up,
    down: day.down,
    starred: s.starred,
    sector_pct: seriesReturnPct(windowed),
    bench_pct: seriesReturnPct(benchWin),
    today_pct: day.today_pct,
    search: [s.label, ...members.map((m) => `${m.ticker} ${m.name}`)]
      .join(" ")
      .toLowerCase(),
    mcaps: memberMcaps(members, metrics),
    tickers: members.map((m) => m.ticker.toUpperCase()),
    sector: spark ? downsampleSeries(windowed) : seriesLong,
    bench: spark ? downsampleSeries(benchWin) : benchWin,
    sector_full: seriesLong,
    bench_full: benchLong,
    window_range: windowRange,
  };
}

/** Metrics-only board — no OHLC. Fast first paint. */
export function buildRotationLiteBoard(): {
  sectors: RotationSectorCard[];
} {
  const metrics = loadMetricsMap();
  return {
    sectors: listRotationSectors().map((s) => liteCard(s, metrics)),
  };
}

export async function hydrateRotationCards(
  ids: string[],
  range: string,
  weight: RotationWeight = "equal",
): Promise<{
  range: string;
  as_of: string | null;
  bench_label: string;
  sectors: RotationSectorCard[];
}> {
  const want = new Set(
    ids.map((id) => id.trim()).filter(Boolean),
  );
  const sectors = listRotationSectors().filter((s) => want.has(s.id));
  const years = rotationFetchYears();
  const metrics = loadMetricsMap();
  const nifty = await niftyBarsOrThrow(years);
  const last = nifty[nifty.length - 1]?.date || "";
  const start = rotationWindowStart(last, range);
  const lookback = rotationMaxLookbackStart(last);
  const benchLong = rebaseCloses(nifty, lookback);
  const cards = await runConcurrent(sectors, 3, (s) =>
    cardWithSeries(s, years, start, lookback, weight, metrics, benchLong, (range || "6M").toUpperCase(), true),
  );
  return {
    range: (range || "6M").toUpperCase(),
    as_of: nifty[nifty.length - 1]?.date ?? null,
    bench_label: NIFTY_INDEX_META.NIFTY_500.label,
    sectors: cards.filter(Boolean),
  };
}

/** Window returns for one sector across every range chip. */
type RankEntry = {
  /** Members signature — recompute just this sector when it changes. */
  sig: string;
  pct: Record<string, number | null>;
};

type RankSnapshot = {
  at: number;
  last: string;
  bench: Record<string, number | null>;
  bySector: Map<string, RankEntry>;
};

/** Ranking is ~1 min for the whole board — cache it per weight. */
const RANK_TTL_MS = 15 * 60 * 1000;
const rankCache = new Map<RotationWeight, RankSnapshot>();
const rankInflight = new Map<RotationWeight, Promise<RankSnapshot>>();

function sectorSig(s: RotationSector): string {
  return s.members
    .map((m) => `${m.ticker.toUpperCase()}:${m.market || ""}`)
    .sort()
    .join(",");
}

function pctByRange(
  series: SeriesPoint[],
  last: string,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const r of ROTATION_RANGES) {
    out[r] = seriesReturnPct(
      windowRebaseSeries(series, rotationWindowStart(last, r)),
    );
  }
  return out;
}

async function buildRankSnapshot(
  weight: RotationWeight,
  prev: RankSnapshot | null,
): Promise<RankSnapshot> {
  const sectors = listRotationSectors();
  const years = rotationFetchYears();
  const metrics = loadMetricsMap();
  const nifty = await niftyBarsOrThrow(years);
  const last = nifty[nifty.length - 1]?.date || "";
  const lookback = rotationMaxLookbackStart(last);
  const benchLong = rebaseCloses(nifty, lookback);
  // Same trading day + still fresh: only (re)compute sectors whose members changed.
  const reuse =
    prev && prev.last === last && Date.now() - prev.at < RANK_TTL_MS
      ? prev
      : null;
  const bySector = new Map<string, RankEntry>();
  const todo: RotationSector[] = [];
  for (const sec of sectors) {
    const sig = sectorSig(sec);
    const hit = reuse?.bySector.get(sec.id);
    if (hit && hit.sig === sig) bySector.set(sec.id, hit);
    else todo.push(sec);
  }
  const fresh = await runConcurrent(todo, 4, async (sec) => {
    const packed = await memberBars(sec.members, years);
    const pct: Record<string, number | null> = {};
    for (const r of ROTATION_RANGES) {
      const start = rotationWindowStart(last, r);
      const use = coreMembers(packed).filter((p) => barsCoverWindow(p.bars, start));
      pct[r] = use.length ? seriesReturnPct(sectorIndex(use, start, weight, metrics)) : null;
    }
    return { id: sec.id, sig: sectorSig(sec), pct };
  });
  for (const f of fresh) {
    if (f) bySector.set(f.id, { sig: f.sig, pct: f.pct });
  }
  return {
    at: reuse ? reuse.at : Date.now(),
    last,
    bench: pctByRange(benchLong, last),
    bySector,
  };
}

async function rankSnapshot(weight: RotationWeight): Promise<RankSnapshot> {
  const cached = rankCache.get(weight) ?? null;
  if (cached && Date.now() - cached.at < RANK_TTL_MS) {
    // Cheap when membership is unchanged: only edited sectors recompute.
    const sectors = listRotationSectors();
    const stale = sectors.some(
      (sec) => cached.bySector.get(sec.id)?.sig !== sectorSig(sec),
    );
    if (!stale) return cached;
  }
  const running = rankInflight.get(weight);
  if (running) return running;
  const job = buildRankSnapshot(weight, cached)
    .then((snap) => {
      rankCache.set(weight, snap);
      return snap;
    })
    .finally(() => rankInflight.delete(weight));
  rankInflight.set(weight, job);
  return job;
}

/** Drop cached ranks (e.g. after a full price refresh). */
export function invalidateRotationRank(): void {
  rankCache.clear();
}
// Stale prices refresh in the background; re-rank once they are all in.
onRotationBarsRefreshed(invalidateRotationRank);
// …and carry the new closes into price / market cap (Yahoo quotes get throttled).
onRotationBarsRefreshed(() => {
  try {
    syncMetricsFromBars();
  } catch {
    /* next refresh retries */
  }
});

const IST_MS = 5.5 * 3_600_000;
/** Biggest move accepted between the stored price and the latest close; beyond it is a split or bad data. */
const MAX_CLOSE_RATIO = 2;

/**
 * Price and market cap from the cached daily close, without calling Yahoo:
 * market cap × (latest close ÷ stored price), i.e. the stored share count at
 * today's price. Only rows older than the newest bar; blanks need a real quote
 * (no share count to scale), and moves beyond 2× are skipped (split / bad data).
 */
export function syncMetricsFromBars(): { checked: number; updated: number; skipped_ratio: number } {
  const metrics = loadMetricsMap();
  const years = rotationFetchYears();
  const seen = new Set<string>();
  const quotes: Parameters<typeof upsertMetrics>[0] = [];
  const marketBy: Record<string, string> = {};
  let checked = 0;
  let skippedRatio = 0;
  for (const sec of listRotationSectors()) {
    for (const m of sec.members) {
      const t = m.ticker.toUpperCase();
      if (seen.has(t)) continue;
      seen.add(t);
      const row = metrics.get(t);
      if (!row || !(row.price != null && row.price > 0) || !(row.market_cap_cr != null && row.market_cap_cr > 0)) continue;
      const bars = cachedRotationCloses(m.ticker, m.market, years);
      const last = bars[bars.length - 1];
      if (!last || !(last.close > 0)) continue;
      checked++;
      const fetchedMs = Date.parse(row.fetched_at);
      const fetchedDay = Number.isFinite(fetchedMs) ? new Date(fetchedMs + IST_MS).toISOString().slice(0, 10) : "";
      if (fetchedDay >= last.date) continue;
      const ratio = last.close / row.price;
      if (ratio > MAX_CLOSE_RATIO || ratio < 1 / MAX_CLOSE_RATIO) {
        skippedRatio++;
        continue;
      }
      const prev = bars[bars.length - 2];
      quotes.push({
        ticker: t,
        yf_symbol: "",
        price: last.close,
        mcap_cr: Math.round(row.market_cap_cr * ratio * 100) / 100,
        sector: null,
        change_pct: prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : null,
      });
      marketBy[t] = m.market;
    }
  }
  const updated = quotes.length ? upsertMetrics(quotes, marketBy) : 0;
  return { checked, updated, skipped_ratio: skippedRatio };
}

/**
 * Window returns for every sector (no sparklines), so Top/Bottom 20, Above
 * and the default return sort rank on real period returns. All range chips
 * are computed in one pass and cached for RANK_TTL_MS, so switching range or
 * filter after the first load is instant.
 */
export async function rankRotationBoard(
  range: string,
  weight: RotationWeight = "equal",
): Promise<{
  range: string;
  as_of: string | null;
  bench_label: string;
  sectors: RotationSectorCard[];
}> {
  const key = (range || "6M").toUpperCase();
  const snap = await rankSnapshot(weight);
  const metrics = loadMetricsMap();
  const sectors = listRotationSectors().map((sec) => {
    const card = liteCard(sec, metrics);
    return {
      ...card,
      sector_pct: snap.bySector.get(sec.id)?.pct[key] ?? null,
      bench_pct: snap.bench[key] ?? null,
    };
  });
  return {
    range: key,
    as_of: snap.last || null,
    bench_label: NIFTY_INDEX_META.NIFTY_500.label,
    sectors,
  };
}

export async function buildRotationBoard(
  range: string,
  weight: RotationWeight = "equal",
): Promise<{
  range: string;
  as_of: string | null;
  bench_label: string;
  sectors: RotationSectorCard[];
}> {
  const all = listRotationSectors();
  return hydrateRotationCards(
    all.map((s) => s.id),
    range,
    weight,
  );
}

export async function buildRotationDetail(
  sector: RotationSector,
  range: string,
  weight: RotationWeight = "equal",
): Promise<{
  range: string;
  as_of: string | null;
  bench_label: string;
  card: RotationSectorCard;
  members: RotationMemberRow[];
}> {
  // Prices and HT legs refresh in the background: wait at most 3 s, then paint
  // with what is stored (the rest lands for the next open). Waiting on them
  // made big sectors take minutes.
  const capped = <T,>(p: Promise<T>) =>
    Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(r, 3000))]);
  const years = rotationFetchYears();
  const [, nifty, packed] = await Promise.all([
    capped(refreshRotationMemberMetrics(sector.members)),
    niftyBarsOrThrow(years),
    memberBars(sector.members, years),
    capped(ensureHtIvForMembers(sector.members)),
  ]);
  const metrics = loadMetricsMap();
  const htCache = loadHtIvMap();
  // When Nifty Yahoo flakes, still window Change % / Trend off member tips.
  const last =
    nifty[nifty.length - 1]?.date ||
    packed
      .map((p) => p.bars[p.bars.length - 1]?.date || "")
      .filter(Boolean)
      .sort()
      .at(-1) ||
    "";
  const start = rotationWindowStart(last, range);
  const lookback = rotationMaxLookbackStart(last);
  const benchLong = rebaseCloses(nifty, lookback);
  const bench = windowRebaseSeries(benchLong, start);
  const { windowed, long: seriesLong } = sectorWindow(packed, start, lookback, weight, metrics);
  const sector_pct = seriesReturnPct(windowed);
  const members: RotationMemberRow[] = packed.map(({ member, bars }) => {
    const key = member.ticker.toUpperCase();
    const m = metrics.get(key);
    const sparkFull = rebaseCloses(bars, lookback);
    const spark = windowRebaseSeries(sparkFull, start);
    const live = priceAndChange(m, bars);
    const ht = htCache.get(key);
    const htOk = htRankable(ht);
    return {
      ticker: member.ticker,
      name: member.name,
      market: member.market,
      mcap_cr: m?.market_cap_cr ?? ht?.market_cap_cr ?? null,
      price: live.price ?? ht?.price ?? null,
      change_pct: live.change_pct,
      window_pct: windowReturnPct(sparkFull, start),
      spark,
      spark_full: sparkFull,
      tv_url: tradingviewUrl(member.ticker, member.market),
      sales_growth_3y: htOk ? ht?.sales_growth_3y ?? null : null,
      roce_3y: htOk ? ht?.roce_3y ?? null : null,
      pb: htOk ? ht?.pb ?? null : null,
    };
  });

  const htRows: HtStockRow[] = members
    .filter(
      (m) =>
        m.sales_growth_3y != null &&
        m.roce_3y != null &&
        m.pb != null &&
        m.pb > 0,
    )
    .map((m) => ({
      ticker: m.ticker.toUpperCase(),
      market: m.market,
      name: m.name,
      sector: sector.label,
      sub_sector: null,
      price: m.price,
      market_cap_cr: m.mcap_cr,
      sales_growth_3y: m.sales_growth_3y!,
      roce_3y: m.roce_3y!,
      pb: m.pb!,
      pe_ratio: null,
    }));
  const ranked = rankIntrinsicValue(htRows);
  const byTicker = new Map(ranked.map((r) => [r.ticker.toUpperCase(), r]));
  for (const m of members) {
    const r = byTicker.get(m.ticker.toUpperCase());
    if (!r) continue;
    m.growth_rank = r.growth_rank ?? null;
    m.roce_rank = r.roce_rank ?? null;
    m.pb_rank = r.pb_rank ?? null;
    m.total_score = r.total_score ?? null;
    m.rank = r.rank ?? null;
  }

  members.sort((a, b) => {
    const ar = a.rank ?? 1e9;
    const br = b.rank ?? 1e9;
    if (ar !== br) return ar - br;
    return (b.mcap_cr ?? -1) - (a.mcap_cr ?? -1);
  });
  const day = dayStats(sector.members, metrics, packed);
  return {
    range: (range || "6M").toUpperCase(),
    as_of: nifty[nifty.length - 1]?.date ?? null,
    bench_label: NIFTY_INDEX_META.NIFTY_500.label,
    card: {
      id: sector.id,
      label: sector.label,
      n: sector.members.length,
      up: day.up,
      down: day.down,
      starred: sector.starred,
      sector_pct,
      bench_pct: seriesReturnPct(bench),
      today_pct: day.today_pct,
      search: "",
      mcaps: memberMcaps(sector.members, metrics),
      tickers: sector.members.map((m) => m.ticker.toUpperCase()),
      // Long sector path for MA warm-up; bench is windowed for DualSpark plotFrom.
      sector: seriesLong,
      bench,
      sector_full: seriesLong,
      bench_full: benchLong,
      window_range: (range || "6M").toUpperCase(),
    },
    members,
  };
}

// ---- Table view: one sector's stocks, inline ------------------------------------------

export type RotationListRow = {
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

/**
 * Stocks of one sector for the expandable table row: cached closes only (no
 * live fetches), so it answers in well under a second.
 */
export async function buildRotationList(
  sector: RotationSector,
  range: string,
): Promise<{ range: string; rows: RotationListRow[] }> {
  const years = rotationFetchYears();
  const metrics = loadMetricsMap();
  const labels = masterLabels();
  const sites = new Map<string, string | null>();
  try {
    for (const c of loadAllCompanies()) sites.set(c.ticker.toUpperCase(), c.website ?? null);
  } catch {
    /* websites optional */
  }
  const packed = await memberBars(sector.members, years);
  const last = packed
    .map((p) => p.bars[p.bars.length - 1]?.date || "")
    .filter(Boolean)
    .sort()
    .at(-1) || "";
  const start = rotationWindowStart(last, range);
  const rows = packed.map(({ member, bars }) => {
    const key = member.ticker.toUpperCase();
    const m = metrics.get(key);
    const lab = labels.get(key);
    return {
      ticker: key,
      name: member.name,
      market: member.market,
      sector: lab?.sector ?? null,
      industry: lab?.industry ?? null,
      website: sites.get(key) ?? null,
      mcap_cr: m?.market_cap_cr ?? null,
      ...priceAndChange(m, bars),
      window_pct: windowReturnPct(bars.map((b) => ({ date: b.date, value: b.close })), start),
    };
  });
  rows.sort((a, b) => (b.window_pct ?? -Infinity) - (a.window_pct ?? -Infinity));
  return { range: (range || "6M").toUpperCase(), rows };
}

// ---- Top stocks across every sector ----------------------------------------------------

export type RotationTopRow = RotationListRow & {
  bench_pct: number | null;
  sector_id: string;
  sector_label: string;
  sector_pct: number | null;
  sector_n: number;
  /** Total Score rank inside its rotation sector (1 = best), cache only. */
  q_rank: number | null;
  q_of: number;
  total_score: number | null;
  /** The sector's "Best ranked" stock (top Total Score over ₹200 Cr). */
  is_best: boolean;
};

/**
 * Every stock on the board with its period return, its sector's return and its
 * quality rank inside the sector. Cached closes and cached HT legs only — no
 * live fetches — so it answers in about a second.
 */
export async function buildRotationTopStocks(
  range: string,
  weight: RotationWeight = "equal",
): Promise<{ range: string; as_of: string | null; rows: RotationTopRow[] }> {
  const key = (range || "6M").toUpperCase();
  const sectors = listRotationSectors();
  const snap = await rankSnapshot(weight);
  const years = rotationFetchYears();
  const metrics = loadMetricsMap();
  const cache = loadHtIvMap();
  const labels = masterLabels();
  const sites = new Map<string, string | null>();
  try {
    for (const c of loadAllCompanies()) sites.set(c.ticker.toUpperCase(), c.website ?? null);
  } catch {
    /* optional */
  }
  const last = snap.last;
  const start = rotationWindowStart(last, key);
  const rows: RotationTopRow[] = [];
  for (const sec of sectors) {
    const patches = new Map(
      loadRotationMemberHtPatches(sec.members, sec.label, { cache, metrics }).map((p) => [p.ticker, p]),
    );
    const ranked = [...patches.values()].filter((p) => p.rank != null);
    const best = ranked
      .filter((p) => (metrics.get(p.ticker)?.market_cap_cr ?? 0) > 200)
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))[0]?.ticker;
    const packed = await memberBars(sec.members, years);
    for (const { member, bars } of packed) {
      const t = member.ticker.toUpperCase();
      const m = metrics.get(t);
      const lab = labels.get(t);
      const pt = patches.get(t);
      rows.push({
        ticker: t,
        name: member.name,
        market: member.market,
        sector: lab?.sector ?? null,
        industry: lab?.industry ?? null,
        website: sites.get(t) ?? null,
        mcap_cr: m?.market_cap_cr ?? null,
        ...priceAndChange(m, bars),
        window_pct: windowReturnPct(bars.map((b) => ({ date: b.date, value: b.close })), start),
        sector_id: sec.id,
        sector_label: sec.label,
        sector_pct: snap.bySector.get(sec.id)?.pct[key] ?? null,
        bench_pct: snap.bench[key] ?? null,
        sector_n: sec.members.length,
        q_rank: pt?.rank ?? null,
        q_of: ranked.length,
        total_score: pt?.total_score ?? null,
        is_best: best === t,
      });
    }
  }
  return { range: key, as_of: last || null, rows };
}

// ---- Entering an upcycle ----------------------------------------------------------------

export type UpcycleRow = {
  id: string;
  label: string;
  n: number;
  r1m: number | null;
  r3m: number | null;
  r1y: number | null;
  /** 3M return minus Nifty 500 3M return (points). */
  rel3m: number | null;
  /** 1Y return minus Nifty 500 1Y return (points). */
  rel1y: number | null;
};

/**
 * Sectors turning up after a weak stretch: 1Y return below the Nifty 500
 * (was out of favour), 3M return above it (turning), 1M return positive
 * (momentum now), 3+ stocks. Sorted by how far 3M beats the Nifty.
 */
export async function buildUpcycle(weight: RotationWeight = "equal"): Promise<{
  as_of: string | null;
  bench: { r1m: number | null; r3m: number | null; r1y: number | null };
  sectors: UpcycleRow[];
}> {
  const snap = await rankSnapshot(weight);
  const b1m = snap.bench["1M"] ?? null;
  const b3m = snap.bench["3M"] ?? null;
  const b1y = snap.bench["1Y"] ?? null;
  const out: UpcycleRow[] = [];
  for (const sec of listRotationSectors()) {
    if (sec.members.length < 3) continue;
    const pct = snap.bySector.get(sec.id)?.pct;
    if (!pct) continue;
    const r1m = pct["1M"] ?? null;
    const r3m = pct["3M"] ?? null;
    const r1y = pct["1Y"] ?? null;
    if (r1m == null || r3m == null || r1y == null || b3m == null || b1y == null) continue;
    const wasWeak = r1y < b1y;
    const turning = r3m > b3m;
    const nowUp = r1m > 0;
    if (!(wasWeak && turning && nowUp)) continue;
    out.push({ id: sec.id, label: sec.label, n: sec.members.length, r1m, r3m, r1y, rel3m: r3m - b3m, rel1y: r1y - b1y });
  }
  out.sort((a, b) => (b.rel3m ?? 0) - (a.rel3m ?? 0));
  return { as_of: snap.last || null, bench: { r1m: b1m, r3m: b3m, r1y: b1y }, sectors: out };
}
