import { fetchDailyBars, fetchNifty500DailyBars } from "./ohlc";
import { loadMetricsMap } from "./metrics";
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
  equalWeightIndex,
  rebaseCloses,
  rotationMaLookbackStart,
  rotationWindowStart,
  rotationYearsBack,
  seriesReturnPct,
  type SeriesPoint,
} from "./sector-rotation-series";

export type RotationMemberRow = {
  ticker: string;
  name: string;
  market: string;
  mcap_cr: number | null;
  price: number | null;
  change_pct: number | null;
  window_pct: number | null;
  spark: SeriesPoint[];
  tv_url: string;
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
  if (weight === "cap") {
    return capWeightIndex(
      packed.map((p) => ({
        bars: p.bars,
        mcap: metrics.get(p.member.ticker.toUpperCase())?.market_cap_cr ?? null,
      })),
      start,
    );
  }
  return equalWeightIndex(
    packed.map((p) => p.bars),
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

function downsamplePoints(pts: SeriesPoint[], max = 72): SeriesPoint[] {
  if (pts.length <= max) return pts;
  const step = (pts.length - 1) / (max - 1);
  const out: SeriesPoint[] = [];
  for (let i = 0; i < max; i++) {
    out.push(pts[Math.round(i * step)]!);
  }
  return out;
}

async function cardWithSeries(
  s: RotationSector,
  years: number,
  start: string,
  lookback: string,
  weight: RotationWeight,
  metrics: ReturnType<typeof loadMetricsMap>,
  bench: SeriesPoint[],
  bench_pct: number | null,
  spark = true,
): Promise<RotationSectorCard> {
  const packed = await memberBars(s.members, years);
  const seriesLong = sectorIndex(packed, lookback, weight, metrics);
  const first = seriesLong.find((p) => p.date >= start);
  const lastPt = seriesLong[seriesLong.length - 1];
  const sector_pct =
    first && lastPt && first.value > 0
      ? ((lastPt.value - first.value) / first.value) * 100
      : null;
  const day = dayStats(s.members, metrics);
  const windowed = seriesLong.filter((p) => p.date >= start);
  return {
    id: s.id,
    label: s.label,
    n: s.members.length,
    up: day.up,
    down: day.down,
    starred: s.starred,
    sector_pct,
    bench_pct,
    today_pct: day.today_pct,
    search: [s.label, ...s.members.map((m) => `${m.ticker} ${m.name}`)]
      .join(" ")
      .toLowerCase(),
    sector: spark ? downsamplePoints(windowed) : seriesLong,
    bench: spark ? downsamplePoints(bench) : bench,
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
  const years = rotationYearsBack(range);
  const metrics = loadMetricsMap();
  const nifty = await fetchNifty500DailyBars(years);
  const last = nifty[nifty.length - 1]?.date || "";
  const start = rotationWindowStart(last, range);
  const lookback = rotationMaLookbackStart(start);
  const bench = rebaseCloses(nifty, start);
  const bench_pct = seriesReturnPct(bench);
  const cards = await runConcurrent(sectors, 3, (s) =>
    cardWithSeries(s, years, start, lookback, weight, metrics, bench, bench_pct, true),
  );
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
  const years = rotationYearsBack(range);
  const metrics = loadMetricsMap();
  const nifty = await fetchNifty500DailyBars(years);
  const last = nifty[nifty.length - 1]?.date || "";
  const start = rotationWindowStart(last, range);
  const lookback = rotationMaLookbackStart(start);
  const bench = rebaseCloses(nifty, start);
  const packed = await memberBars(sector.members, years);
  const seriesLong = sectorIndex(packed, lookback, weight, metrics);
  const first = seriesLong.find((p) => p.date >= start);
  const lastPt = seriesLong[seriesLong.length - 1];
  const sector_pct =
    first && lastPt && first.value > 0
      ? ((lastPt.value - first.value) / first.value) * 100
      : null;
  const members: RotationMemberRow[] = packed.map(({ member, bars }) => {
    const m = metrics.get(member.ticker.toUpperCase());
    const spark = rebaseCloses(bars, start);
    return {
      ticker: member.ticker,
      name: member.name,
      market: member.market,
      mcap_cr: m?.market_cap_cr ?? null,
      price: m?.price ?? null,
      change_pct: m?.change_pct ?? null,
      window_pct: seriesReturnPct(spark),
      spark,
      tv_url: tradingviewUrl(member.ticker, member.market),
    };
  });
  members.sort((a, b) => (b.mcap_cr ?? -1) - (a.mcap_cr ?? -1));
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
      sector: seriesLong,
      bench,
    },
    members,
  };
}
