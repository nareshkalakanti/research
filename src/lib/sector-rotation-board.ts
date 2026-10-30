import { fetchDailyBars, fetchNifty500DailyBars } from "./ohlc";
import { isRightsOrPartlyPaid } from "./listing-name-match";
import { loadMetricsMap, refreshPagePrices } from "./metrics";
import { tradingviewUrl } from "./links";
import { runConcurrent } from "./scrape-pool";
import {
  listRotationSectors,
  type RotationSector,
  type SectorMember,
} from "./sector-rotation";
import { NIFTY_INDEX_META } from "./nse-index-constituents";
import {
  capWeightIndex,
  downsampleSeries,
  equalWeightIndex,
  rebaseCloses,
  rotationFetchYears,
  rotationMaxLookbackStart,
  rotationWindowStart,
  seriesReturnPct,
  windowRebaseSeries,
  type SeriesPoint,
} from "./sector-rotation-series";
import {
  fetchScreenerAnnual,
  fetchScreenerAnnualBs,
} from "./screener-annual";
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
  let cache = loadHtIvMap();
  const need = members.filter((m) => !htRankable(cache.get(m.ticker.toUpperCase())));
  if (!need.length) return cache;

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
export async function refreshMissingHtIvForMembers(
  members: SectorMember[],
): Promise<{ tried: number; filled: number; still_missing: number }> {
  const cache = loadHtIvMap();
  const need = members.filter(
    (m) => !htRankable(cache.get(m.ticker.toUpperCase())),
  );
  if (!need.length) {
    return { tried: 0, filled: 0, still_missing: 0 };
  }

  const results: HtCachedRow[] = await runConcurrent(need, 2, async (m) => {
    const prev = cache.get(m.ticker.toUpperCase());
    // Screener first — force refresh so a prior empty scrape does not stick.
    let row = await fetchHtIvFromScreener({
      ticker: m.ticker,
      market: m.market,
      name: m.name,
      force: true,
    });
    if (!htRankable(row)) {
      const viaYahoo = await fetchHtIvForTicker({
        ticker: m.ticker,
        market: m.market,
        name: m.name,
      });
      if (htRankable(viaYahoo)) row = viaYahoo;
      else if (isHtRateLimited(viaYahoo) && htRankable(prev)) return prev!;
      else if (htRankable(prev)) return prev!;
    }
    return row;
  });

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
  const still_missing = need.length - filled;
  return { tried: need.length, filled, still_missing };
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
): RotationMemberHtPatch[] {
  const cache = loadHtIvMap();
  const metrics = loadMetricsMap();
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
  sector: SeriesPoint[];
  bench: SeriesPoint[];
  /** Max-lookback series so shorter range chips window without refetch. */
  sector_full?: SeriesPoint[];
  bench_full?: SeriesPoint[];
};

function dayStats(
  members: SectorMember[],
  metrics: ReturnType<typeof loadMetricsMap>,
): { today_pct: number | null; up: number; down: number } {
  let up = 0;
  let down = 0;
  let sum = 0;
  let n = 0;
  for (const m of members) {
    const ch = metrics.get(m.ticker.toUpperCase())?.change_pct;
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

async function memberBars(members: SectorMember[], years: number) {
  const bars = await runConcurrent(members, 4, async (m) => {
    try {
      return await fetchDailyBars(m.ticker, m.market, years);
    } catch {
      return [];
    }
  });
  return members.map((m, i) => ({ member: m, bars: bars[i] ?? [] }));
}

export type RotationWeight = "equal" | "cap";

function sectorIndex(
  packed: Array<{ member: SectorMember; bars: Array<{ date: string; close: number }> }>,
  start: string,
  weight: RotationWeight,
  metrics: ReturnType<typeof loadMetricsMap>,
) {
  // Drop rights / partly-paid stubs so they don't dilute the sector line.
  const core = packed.filter(
    (p) => !isRightsOrPartlyPaid(p.member.ticker, p.member.name),
  );
  const use = core.length ? core : packed;
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

function liteCard(
  s: RotationSector,
  metrics: ReturnType<typeof loadMetricsMap>,
): RotationSectorCard {
  const day = dayStats(s.members, metrics);
  return {
    id: s.id,
    label: s.label,
    n: s.members.length,
    up: day.up,
    down: day.down,
    starred: s.starred,
    sector_pct: null,
    bench_pct: null,
    today_pct: day.today_pct,
    search: [s.label, ...s.members.map((m) => `${m.ticker} ${m.name}`)]
      .join(" ")
      .toLowerCase(),
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
  spark = true,
): Promise<RotationSectorCard> {
  const packed = await memberBars(s.members, years);
  const seriesLong = sectorIndex(packed, lookback, weight, metrics);
  const windowed = windowRebaseSeries(seriesLong, start);
  const benchWin = windowRebaseSeries(benchLong, start);
  const day = dayStats(s.members, metrics);
  return {
    id: s.id,
    label: s.label,
    n: s.members.length,
    up: day.up,
    down: day.down,
    starred: s.starred,
    sector_pct: seriesReturnPct(windowed),
    bench_pct: seriesReturnPct(benchWin),
    today_pct: day.today_pct,
    search: [s.label, ...s.members.map((m) => `${m.ticker} ${m.name}`)]
      .join(" ")
      .toLowerCase(),
    sector: spark ? downsampleSeries(windowed) : seriesLong,
    bench: spark ? downsampleSeries(benchWin) : benchWin,
    sector_full: seriesLong,
    bench_full: benchLong,
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
  const nifty = await fetchNifty500DailyBars(years);
  const last = nifty[nifty.length - 1]?.date || "";
  const start = rotationWindowStart(last, range);
  const lookback = rotationMaxLookbackStart(last);
  const benchLong = rebaseCloses(nifty, lookback);
  const cards = await runConcurrent(sectors, 3, (s) =>
    cardWithSeries(s, years, start, lookback, weight, metrics, benchLong, true),
  );
  return {
    range: (range || "6M").toUpperCase(),
    as_of: nifty[nifty.length - 1]?.date ?? null,
    bench_label: NIFTY_INDEX_META.NIFTY_500.label,
    sectors: cards.filter(Boolean),
  };
}

/**
 * Compute window returns for every sector (no sparklines).
 * Needed so Top/Bottom 20 and Above filters rank on real period returns,
 * not the lite board’s null sector_pct / today_pct fallback.
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
  const sectors = listRotationSectors();
  const years = rotationFetchYears();
  const metrics = loadMetricsMap();
  const nifty = await fetchNifty500DailyBars(years);
  const last = nifty[nifty.length - 1]?.date || "";
  const start = rotationWindowStart(last, range);
  const lookback = rotationMaxLookbackStart(last);
  const benchLong = rebaseCloses(nifty, lookback);
  const cards = await runConcurrent(sectors, 4, async (s) => {
    const card = await cardWithSeries(
      s,
      years,
      start,
      lookback,
      weight,
      metrics,
      benchLong,
      false,
    );
    // Rank payload is pct-only; keep *_full empty so clients don't drop charts.
    return {
      ...card,
      sector: [],
      bench: [],
      sector_full: undefined,
      bench_full: undefined,
    };
  });
  return {
    range: (range || "6M").toUpperCase(),
    as_of: nifty[nifty.length - 1]?.date ?? null,
    bench_label: NIFTY_INDEX_META.NIFTY_500.label,
    sectors: cards.filter(Boolean),
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
  // Fill missing mcap / price / today % before painting the member table
  await refreshRotationMemberMetrics(sector.members);
  const years = rotationFetchYears();
  const metrics = loadMetricsMap();
  const [nifty, packed, htCache] = await Promise.all([
    fetchNifty500DailyBars(years),
    memberBars(sector.members, years),
    ensureHtIvForMembers(sector.members),
  ]);
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
  const seriesLong = sectorIndex(packed, lookback, weight, metrics);
  const windowed = windowRebaseSeries(seriesLong, start);
  const sector_pct = seriesReturnPct(windowed);
  const members: RotationMemberRow[] = packed.map(({ member, bars }) => {
    const key = member.ticker.toUpperCase();
    const m = metrics.get(key);
    const sparkFull = rebaseCloses(bars, lookback);
    const spark = windowRebaseSeries(sparkFull, start);
    const lastClose = bars[bars.length - 1]?.close;
    const prevClose = bars[bars.length - 2]?.close;
    const barToday =
      prevClose != null &&
      lastClose != null &&
      prevClose > 0 &&
      Number.isFinite(lastClose)
        ? ((lastClose - prevClose) / prevClose) * 100
        : null;
    const ht = htCache.get(key);
    const htOk = htRankable(ht);
    return {
      ticker: member.ticker,
      name: member.name,
      market: member.market,
      mcap_cr: m?.market_cap_cr ?? ht?.market_cap_cr ?? null,
      price:
        m?.price ??
        ht?.price ??
        (lastClose != null && Number.isFinite(lastClose) ? lastClose : null),
      change_pct: m?.change_pct ?? barToday,
      window_pct: seriesReturnPct(spark),
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
  const day = dayStats(sector.members, metrics);
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
      // Long sector path for MA warm-up; bench is windowed for DualSpark plotFrom.
      sector: seriesLong,
      bench,
      sector_full: seriesLong,
      bench_full: benchLong,
    },
    members,
  };
}
