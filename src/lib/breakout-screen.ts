import { loadAllCompanies } from "./db";
import { isRightsOrPartlyPaid } from "./listing-name-match";
import { currentLockout } from "./lockout";
import { loadMetricsMap } from "./metrics";
import { rotationBarsRefreshing, rotationCloses, type Close } from "./rotation-bars";
import { runConcurrent } from "./scrape-pool";
import { listRotationSectors, type SectorMember } from "./sector-rotation";
import { rotationFetchYears } from "./sector-rotation-series";
import { masterLabels } from "./stock-master";

/**
 * Breakouts: stocks closing today at (−1%) or just above (up to +5%) the
 * highest close of a base, from the cached daily closes (rotation_bars.db).
 *
 * Pivot = the highest close before today that today has reached; base = the
 * trading days since that close was made (all closes in between lower).
 * Screens (a stock sits in the first that fits, the rest show as tags):
 *   Multi-year breakout  base of 52 weeks or more
 *   VCP                  base 5+ weeks, three pullbacks each shallower than the
 *                        last (last one ≤ 10%), volume drying up
 *   Blue sky             no higher close in the whole history (2+ years)
 *   No named screen      any other breakout from a 2+ week base
 * Plus Lockout rallies (any stock, breaking out today or not): 6 of the last 8
 * weekly bars green at the end of stage 1 / start of stage 2 (see lockout.ts).
 */
export const BO_RULES = {
  /** Today within this much below the pivot still counts as "at its pivot". */
  belowPct: 1,
  /** Further above than this is extended, not a breakout. */
  abovePct: 5,
  minBaseDays: 10,
  /** The base must have pulled back at least this far from the pivot. */
  minDepthPct: 5,
  multiYearDays: 252,
  vcpMinDays: 25,
  vcpLastDepthPct: 10,
  /** Blue sky needs this much history to mean "all-time". */
  blueSkyMinBars: 500,
  relVolDays: 50,
} as const;

export type BoScreen = "multi" | "vcp" | "blue" | "none";

export type BoRow = {
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
  /** Breakout pivot; null when the stock is only in the list for a lockout rally. */
  pivot: number | null;
  /** today vs pivot, % (−1 … +5). */
  above_pct: number | null;
  base_weeks: number | null;
  rs: number | null;
  /** Breakout screen; null = not breaking out today (lockout rally only). */
  screen: BoScreen | null;
  also: BoScreen[];
  /** Lockout rally running now. */
  lockout: { green: number; gain_pct: number; start: string; from_price: number; weeks: number; base_weeks: number } | null;
  /** Closes for the sparkline (≤ 120 points) and where the base starts in it. */
  chart: number[];
  base_from: number;
};

export type BoResult = {
  date: string | null;
  rows: BoRow[];
  universe: number;
  refreshing: number;
  rules: typeof BO_RULES;
};

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

/** IBD-style weighted return: 40% last 3 months, 20% each of the three before. */
function rsRaw(s: Close[]): number | null {
  const t = s.length - 1;
  if (t < 252) return null;
  const r = (back: number) => s[t]!.close / s[t - back]!.close - 1;
  return 0.4 * r(63) + 0.2 * r(126) + 0.2 * r(189) + 0.2 * r(252);
}

function avgVol(s: Close[], from: number, to: number): number | null {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < to; i++) {
    const v = s[i]!.volume;
    if (v != null && v > 0) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : null;
}

function depth(s: Close[], from: number, to: number): number {
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = from; i < to; i++) {
    hi = Math.max(hi, s[i]!.close);
    lo = Math.min(lo, s[i]!.close);
  }
  return hi > 0 ? (hi - lo) / hi : 0;
}

/** Three equal slices of the base, each pullback shallower than the last, volume lower at the end. */
function isVcp(s: Close[], pivotIdx: number, t: number): boolean {
  const len = t - pivotIdx;
  if (len < BO_RULES.vcpMinDays) return false;
  const k = Math.floor(len / 3);
  const a = pivotIdx;
  const d1 = depth(s, a, a + k);
  const d2 = depth(s, a + k, a + 2 * k);
  const d3 = depth(s, a + 2 * k, t);
  if (!(d1 > d2 && d2 > d3 && d3 * 100 <= BO_RULES.vcpLastDepthPct)) return false;
  const v1 = avgVol(s, a, a + k);
  const v3 = avgVol(s, a + 2 * k, t);
  return v1 == null || v3 == null || v3 < v1;
}

function sparkline(s: Close[], from: number, baseIdx: number): { chart: number[]; base_from: number } {
  const slice = s.slice(from).map((b) => b.close);
  const step = Math.max(1, Math.ceil(slice.length / 120));
  const chart: number[] = [];
  for (let i = 0; i < slice.length; i += step) chart.push(slice[i]!);
  if ((slice.length - 1) % step) chart.push(slice[slice.length - 1]!);
  return { chart, base_from: Math.min(chart.length - 1, Math.round((baseIdx - from) / step)) };
}

type Hit = Omit<BoRow, "ticker" | "name" | "market" | "industry" | "sector" | "website" | "mcap_cr" | "rs" | "lockout">;

function dayStats(s: Close[]): { price: number; day_pct: number | null; rel_vol: number | null } {
  const t = s.length - 1;
  const c = s[t]!.close;
  const prev = s[t - 1]?.close ?? 0;
  const v50 = avgVol(s, t - BO_RULES.relVolDays, t);
  const vt = s[t]!.volume;
  return { price: c, day_pct: prev > 0 ? (c / prev - 1) * 100 : null, rel_vol: v50 && vt != null ? vt / v50 : null };
}

/** Breakout today from a base, or null. */
export function detectBreakout(s: Close[]): Hit | null {
  const t = s.length - 1;
  if (t < 60) return null;
  const c = s[t]!.close;
  const prev = s[t - 1]!.close;
  if (!(c > prev)) return null;
  // Walk back while every close stays within reach of today: the furthest high reached is the pivot.
  const reach = c * (1 + BO_RULES.belowPct / 100);
  let pivot = -Infinity;
  let pivotIdx = -1;
  let k = t - 1;
  for (; k >= 0; k--) {
    const v = s[k]!.close;
    if (v > reach) break;
    if (v > pivot) {
      pivot = v;
      pivotIdx = k;
    }
  }
  const allTime = k < 0;
  const baseDays = t - pivotIdx;
  if (pivotIdx < 0 || baseDays < BO_RULES.minBaseDays) return null;
  const above = (c / pivot - 1) * 100;
  if (above < -BO_RULES.belowPct || above > BO_RULES.abovePct) return null;
  let low = Infinity;
  for (let i = pivotIdx; i < t; i++) low = Math.min(low, s[i]!.close);
  if ((1 - low / pivot) * 100 < BO_RULES.minDepthPct) return null;

  const tags: BoScreen[] = [];
  if (baseDays >= BO_RULES.multiYearDays) tags.push("multi");
  if (isVcp(s, pivotIdx, t)) tags.push("vcp");
  if (allTime && s.length >= BO_RULES.blueSkyMinBars) tags.push("blue");
  const screen: BoScreen = tags[0] ?? "none";

  const from = Math.max(0, pivotIdx - Math.max(15, Math.round(baseDays * 0.3)));
  return {
    ...dayStats(s),
    pivot,
    above_pct: above,
    base_weeks: Math.round(baseDays / 5),
    screen,
    also: tags.slice(1),
    ...sparkline(s, from, pivotIdx),
  };
}

let cache: { at: number; result: BoResult } | null = null;
const CACHE_MS = 60_000;
export function clearBreakoutCache(): void {
  cache = null;
}

export async function buildBreakouts(): Promise<BoResult> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.result;
  const members = uniqueMembers();
  const years = rotationFetchYears();
  const bars = await runConcurrent(members, 8, async (m) => {
    try {
      return await rotationCloses(m.ticker, m.market, years);
    } catch {
      return [] as Close[];
    }
  });
  // Latest session across the universe: a stock without today's bar is not scanned.
  let date: string | null = null;
  for (const s of bars) {
    const d = s[s.length - 1]?.date;
    if (d && (!date || d > date)) date = d;
  }
  // RS 1–99: percentile of the weighted 12-month return across the universe.
  const raws = bars.map(rsRaw);
  const sorted = raws.filter((x): x is number => x != null).sort((a, b) => a - b);
  const rsOf = (x: number | null): number | null => {
    if (x == null || !sorted.length) return null;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(1, Math.min(99, Math.round((lo / sorted.length) * 98) + 1));
  };

  const metrics = loadMetricsMap();
  const labels = masterLabels();
  const sites = new Map<string, string | null>();
  try {
    for (const c of loadAllCompanies()) sites.set(c.ticker.toUpperCase(), c.website ?? null);
  } catch {
    /* websites optional */
  }

  const rows: BoRow[] = [];
  members.forEach((m, i) => {
    const s = bars[i] ?? [];
    if (!s.length || s[s.length - 1]!.date !== date) return;
    const hit = detectBreakout(s);
    const lo = currentLockout(s);
    if (!hit && !lo) return;
    const lockout = lo ? { green: lo.green, gain_pct: lo.gain_pct, start: lo.start, from_price: lo.from_price, weeks: lo.weeks, base_weeks: lo.base_weeks } : null;
    // Lockout only: chart from a little before the run, the run shaded.
    const body: Hit = hit ?? {
      ...dayStats(s),
      pivot: null,
      above_pct: null,
      base_weeks: null,
      screen: null,
      also: [],
      ...sparkline(s, Math.max(0, lo!.start_idx - 40), lo!.start_idx),
    };
    const t = m.ticker.toUpperCase();
    const lab = labels.get(t);
    rows.push({
      ticker: t,
      name: m.name,
      market: m.market || "NSE",
      industry: lab?.industry ?? lab?.sector ?? null,
      sector: lab?.sector ?? null,
      website: sites.get(t) ?? null,
      mcap_cr: metrics.get(t)?.market_cap_cr ?? null,
      rs: rsOf(raws[i] ?? null),
      lockout,
      ...body,
    });
  });
  rows.sort((a, b) => (b.rs ?? -1) - (a.rs ?? -1) || (b.base_weeks ?? 0) - (a.base_weeks ?? 0));
  const result: BoResult = { date, rows, universe: members.length, refreshing: rotationBarsRefreshing(), rules: BO_RULES };
  cache = { at: Date.now(), result };
  return result;
}
