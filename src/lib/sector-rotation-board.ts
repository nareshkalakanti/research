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
  equalWeightIndex,
  rebaseCloses,
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
  sector_pct: number | null;
  bench_pct: number | null;
  sector: SeriesPoint[];
  bench: SeriesPoint[];
};

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

export async function buildRotationBoard(range: string): Promise<{
  range: string;
  as_of: string | null;
  bench_label: string;
  sectors: RotationSectorCard[];
}> {
  const years = rotationYearsBack(range);
  const sectors = listRotationSectors();
  const nifty = await fetchNifty500DailyBars(years);
  const last = nifty[nifty.length - 1]?.date || "";
  const start = rotationWindowStart(last, range);
  const bench = rebaseCloses(nifty, start);
  const bench_pct = seriesReturnPct(bench);
  const cards: RotationSectorCard[] = [];
  for (const s of sectors) {
    const packed = await memberBars(s.members, years);
    const series = equalWeightIndex(
      packed.map((p) => p.bars),
      start,
    );
    cards.push({
      id: s.id,
      label: s.label,
      n: s.members.length,
      sector_pct: seriesReturnPct(series),
      bench_pct,
      sector: series,
      bench,
    });
  }
  return {
    range: (range || "6M").toUpperCase(),
    as_of: nifty[nifty.length - 1]?.date ?? null,
    bench_label: NIFTY_INDEX_META.NIFTY_500.label,
    sectors: cards,
  };
}

export async function buildRotationDetail(
  sector: RotationSector,
  range: string,
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
  const bench = rebaseCloses(nifty, start);
  const packed = await memberBars(sector.members, years);
  const series = equalWeightIndex(
    packed.map((p) => p.bars),
    start,
  );
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
  return {
    range: (range || "6M").toUpperCase(),
    as_of: nifty[nifty.length - 1]?.date ?? null,
    bench_label: NIFTY_INDEX_META.NIFTY_500.label,
    card: {
      id: sector.id,
      label: sector.label,
      n: sector.members.length,
      sector_pct: seriesReturnPct(series),
      bench_pct: seriesReturnPct(bench),
      sector: series,
      bench,
    },
    members,
  };
}
