import { loadAllCompanies } from "./db";
import { isRightsOrPartlyPaid } from "./listing-name-match";
import { loadMetricsMap } from "./metrics";
import { fetchNifty500DailyBars, fetchNiftyDailyBars } from "./ohlc";
import {
  dayMetrics,
  idxOnOrBefore,
  PA_2WK_DAYS,
  PA_MAX_DAYS,
  PA_ROCKETS,
  PA_RULES,
  priceHighRocket,
  rpiRocket,
  screenBits,
  type PaDay,
  type PaMetrics,
  type PaResult,
  type PaRow,
} from "./price-action-rules";
import { rotationBarsRefreshing, rotationCloses, type Close } from "./rotation-bars";
import { runConcurrent } from "./scrape-pool";
import { listRotationSectors, type SectorMember } from "./sector-rotation";
import { rotationFetchYears } from "./sector-rotation-series";
import { masterLabels } from "./stock-master";

export { PA_2WK_DAYS, PA_RULES };
export type { PaResult, PaRow };

function uniqueMembers(): SectorMember[] {
  const seen = new Map<string, SectorMember>();
  for (const sec of listRotationSectors())
    for (const m of sec.members) {
      const t = m.ticker.toUpperCase();
      if (seen.has(t) || isRightsOrPartlyPaid(m.ticker, m.name)) continue;
      seen.set(t, m);
    }
  return [...seen.values()];
}

/** Trading days from the Nifty 500 calendar: the last `days` up to `to`, or every day in [from, to]. */
async function tradingDates(opts: { to?: string; from?: string; days: number }): Promise<string[]> {
  const nifty = await fetchNifty500DailyBars(2);
  const all = nifty.map((b) => b.date);
  if (!all.length) throw new Error("Nifty 500 calendar unavailable right now (Yahoo). Try again in a minute.");
  const to = opts.to && opts.to < all[all.length - 1]! ? opts.to : all[all.length - 1]!;
  const upTo = all.filter((d) => d <= to);
  if (opts.from) return upTo.filter((d) => d >= opts.from!).slice(-PA_MAX_DAYS);
  return upTo.slice(-opts.days);
}

let cache: { key: string; at: number; result: PaResult } | null = null;
/** Top-bar Refresh: rebuild the screen from the price cache. */
export function clearPriceActionCache(): void {
  cache = null;
}
const CACHE_MS = 60_000;

export async function buildPriceAction(opts: { to?: string; from?: string; days?: number } = {}): Promise<PaResult> {
  const days = Math.max(1, Math.min(PA_MAX_DAYS, opts.days ?? PA_2WK_DAYS));
  const key = `${opts.from ?? ""}|${opts.to ?? ""}|${days}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.result;

  const dates = await tradingDates({ to: opts.to, from: opts.from, days });
  if (!dates.length) throw new Error("No trading days in that range.");
  const members = uniqueMembers();
  const years = rotationFetchYears();
  const bars = await runConcurrent(members, 8, async (m) => {
    try {
      return await rotationCloses(m.ticker, m.market, years);
    } catch {
      return [] as Close[];
    }
  });
  const metrics = loadMetricsMap();
  const labels = masterLabels();
  const sites = new Map<string, string | null>();
  try {
    for (const c of loadAllCompanies()) sites.set(c.ticker.toUpperCase(), c.website ?? null);
  } catch {
    /* websites optional */
  }

  // Cap class by market-cap rank across the whole universe.
  const capRank = new Map<string, number>();
  members
    .map((m) => ({ t: m.ticker.toUpperCase(), mc: metrics.get(m.ticker.toUpperCase())?.market_cap_cr ?? null }))
    .filter((x) => x.mc != null && x.mc > 0)
    .sort((a, b) => b.mc! - a.mc!)
    .forEach((x, i) => capRank.set(x.t, i + 1));

  // Nifty 50 for Weighted RPI (the export's benchmark column). Missing: no RPI rocket.
  const nifty50 = new Map<string, number>();
  try {
    for (const b of await fetchNiftyDailyBars(3)) nifty50.set(b.date, b.close);
  } catch {
    /* rockets degrade to price only */
  }
  const indexAt = (d: string) => nifty50.get(d) ?? null;

  const lastDate = dates[dates.length - 1]!;
  let noVolume = 0;
  const rows: PaRow[] = [];
  members.forEach((m, mi) => {
    const series = bars[mi] ?? [];
    if (series.length < 2) return;
    const hasVolume = series[series.length - 1]!.volume !== undefined;
    if (!hasVolume) noVolume++;
    const byDate = new Map<string, number>();
    const firstIdx = Math.max(0, idxOnOrBefore(series, dates[0]!) - 1);
    for (let i = firstIdx; i < series.length; i++) byDate.set(series[i]!.date, i);
    const dayBits: PaDay[] = [];
    let lastMetrics: PaMetrics = { day_pct: null, vol_x: null, ret_1m: null, ret_3m: null };
    for (const d of dates) {
      const i = byDate.get(d);
      if (i == null || i < 1) {
        dayBits.push(-1);
        continue;
      }
      const mt = dayMetrics(series, i);
      dayBits.push(screenBits(mt));
      if (d === lastDate) lastMetrics = mt;
    }
    const trending = dayBits.filter((b) => b > 0).length;
    if (!trending) return;
    // Consecutive green days up to the latest; a day with no trade (or no bar yet) is skipped, not a break.
    let streak = 0;
    for (let k = dayBits.length - 1; k >= 0; k--) {
      if (dayBits[k]! < 0) continue;
      if (dayBits[k] === 0) break;
      streak++;
    }
    const t = m.ticker.toUpperCase();
    const lab = labels.get(t);
    const rank = capRank.get(t);
    const lastIdx = idxOnOrBefore(series, lastDate);
    const rpi = lastIdx >= 0 && nifty50.size ? rpiRocket(series, lastIdx, indexAt) : { wrpi: null, rocket: false };
    rows.push({
      ticker: t,
      name: m.name,
      market: m.market,
      sector: lab?.sector ?? null,
      industry: lab?.industry ?? null,
      website: sites.get(t) ?? null,
      mcap_cr: metrics.get(t)?.market_cap_cr ?? null,
      cap_class: rank == null ? null : rank <= 100 ? "Large" : rank <= 250 ? "Mid" : "Small",
      price: lastIdx >= 0 ? series[lastIdx]!.close : null,
      days: dayBits,
      trending,
      streak,
      last: lastMetrics,
      has_volume: hasVolume,
      rocket_price: lastIdx >= 0 && priceHighRocket(series, lastIdx),
      rocket_rpi: rpi.rocket,
      wrpi: rpi.wrpi,
    });
  });
  rows.sort(
    (a, b) =>
      b.trending - a.trending ||
      b.streak - a.streak ||
      (b.last.day_pct ?? -Infinity) - (a.last.day_pct ?? -Infinity) ||
      a.name.localeCompare(b.name),
  );
  const result: PaResult = {
    dates,
    rows,
    universe: members.length,
    no_volume: noVolume,
    refreshing: rotationBarsRefreshing(),
    rules: PA_RULES,
    rockets: PA_ROCKETS,
  };
  cache = { key, at: Date.now(), result };
  return result;
}
