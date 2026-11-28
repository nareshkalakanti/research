import { loadAllCompanies } from "./db";
import { isRightsOrPartlyPaid } from "./listing-name-match";
import { currentLockout } from "./lockout";
import { loadMetricsMap } from "./metrics";
import { rotationBarsRefreshing, rotationCloses, type Close } from "./rotation-bars";
import { runConcurrent } from "./scrape-pool";
import { listRotationSectors, type SectorMember } from "./sector-rotation";
import { rotationFetchYears } from "./sector-rotation-series";
import { openSqliteNamed } from "./sqlite-utils";
import { masterLabels } from "./stock-master";

/** NSE listing dates saved in strategy.db (read only), for the IPO base screen. */
function listingDates(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const db = openSqliteNamed("strategy.db", { readonly: true });
    try {
      for (const r of db.prepare("SELECT ticker, listing_date FROM ipo_listing_dates").all() as Array<{ ticker: string; listing_date: string }>)
        out.set(r.ticker.toUpperCase(), r.listing_date);
    } finally {
      db.close();
    }
  } catch {
    /* none saved: no IPO base tags */
  }
  return out;
}

/**
 * Breakouts: stocks closing today at (−1%) or just above (up to +5%) the
 * highest close of a base, from the cached daily closes (rotation_bars.db).
 *
 * Anatomy funnel (“How we narrow the market down”) then screen tags:
 *   Multi-year   52+ week base, above 200-day, RS 60+ (universe already RS 70+)
 *   IPO base     listed &lt; 50 weeks, any qualifying base, holding 50-day (RS/200-day waived)
 *   VCP          3+ weeks, shallower pullbacks, ATR% + volume ≤ 0.9× first half
 *   Blue sky     all-time high pivot, 2+ years of history
 *   No named     any other qualifying base breakout
 * Plus Lockout rallies (liquidity only — see lockout.ts).
 */
export const BO_RULES = {
  /** Today within this much below the pivot still counts as "at its pivot". */
  belowPct: 1,
  /** Further above than this is extended, not a breakout. */
  abovePct: 5,
  /** Real base: 3+ weeks. */
  minBaseDays: 15,
  /** The base must have pulled back at least this far from the pivot. */
  minDepthPct: 5,
  /** Never deeper than this (anatomy). */
  maxDepthPct: 35,
  /** Coiling within this % of the pivot before/at breakout. */
  nearPivotPct: 20,
  multiYearDays: 252,
  multiYearRs: 60,
  /** VCP: base of 3+ weeks with 2+ pullbacks, each shallower than the one before, the last ≤ 10%. */
  vcpMinDays: 15,
  vcpLastDepthPct: 10,
  /** A pullback counts once price turns back up this much from its low (smaller wiggles are noise). */
  vcpSwingPct: 3,
  /** 2nd-half ATR% (close-to-close) and volume ≤ this × 1st half. */
  coilRatio: 0.9,
  /** IPO base: under 50 weeks on the market (calendar days). */
  ipoMaxDays: 50 * 7,
  /** Blue sky needs this much history to mean "all-time". */
  blueSkyMinBars: 500,
  blueSkyRs: 70,
  relVolDays: 50,
  /** Universe liquidity / leadership. Mcap floor is UI-only (no hard gate). */
  minMcapCr: 0,
  minDailyValueCr: 1,
  universeRs: 70,
  /** Within this % of the 52-week high. */
  withinHighPct: 30,
  sma50: 50,
  sma200: 200,
  /** Keep a breakout on the board this many sessions (today inclusive), like StockScans “All 3 days”. */
  freshSessions: 3,
} as const;

export type BoScreen = "multi" | "ipo" | "vcp" | "blue" | "none";

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
  /** Close vs pivot on the breakout session, % (−1 … +5). */
  above_pct: number | null;
  base_weeks: number | null;
  rs: number | null;
  /** Breakout screen; null = not breaking out (lockout rally only). */
  screen: BoScreen | null;
  also: BoScreen[];
  /** Session the breakout printed (may be 1–2 days before as-of when still “fresh”). */
  breakout_date: string | null;
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

/** Mean |day % move| over [from, to) — close-only ATR% proxy. */
function avgAbsRetPct(s: Close[], from: number, to: number): number | null {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(from + 1, 1); i < to; i++) {
    const a = s[i - 1]!.close;
    const b = s[i]!.close;
    if (a > 0) {
      sum += Math.abs(b / a - 1) * 100;
      n++;
    }
  }
  return n ? sum / n : null;
}

/** SMA of closes ending at index `at` (inclusive), or null. */
function smaAt(s: Close[], at: number, period: number): number | null {
  if (at + 1 < period) return null;
  let sum = 0;
  for (let i = at - period + 1; i <= at; i++) sum += s[i]!.close;
  return sum / period;
}

/** Average ₹ Cr traded per day over the last `days` sessions (close × volume / 1e7). */
function avgDailyValueCr(s: Close[], days = 20): number | null {
  const t = s.length;
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, t - days); i < t; i++) {
    const v = s[i]!.volume;
    if (v != null && v > 0 && s[i]!.close > 0) {
      sum += (s[i]!.close * v) / 1e7;
      n++;
    }
  }
  return n ? sum / n : null;
}

/** Highest close in the last `lookback` bars (default ~52 weeks). */
function recentHigh(s: Close[], lookback = 252): number {
  const t = s.length - 1;
  let hi = -Infinity;
  for (let i = Math.max(0, t - lookback + 1); i <= t; i++) hi = Math.max(hi, s[i]!.close);
  return hi;
}

/**
 * Coiling quietly: 2nd half of the base has ATR% and volume ≤ coilRatio × 1st half.
 * Missing volume → ATR-only; missing both halves → false.
 */
export function isCoiling(s: Close[], from: number, to: number): boolean {
  const len = to - from;
  if (len < 6) return false;
  const mid = from + Math.floor(len / 2);
  const a1 = avgAbsRetPct(s, from, mid);
  const a2 = avgAbsRetPct(s, mid, to);
  if (a1 == null || a2 == null || a1 <= 0) return false;
  if (a2 > a1 * BO_RULES.coilRatio) return false;
  const v1 = avgVol(s, from, mid);
  const v2 = avgVol(s, mid, to);
  if (v1 != null && v1 > 0 && v2 != null && v2 > v1 * BO_RULES.coilRatio) return false;
  return true;
}

/**
 * Pullbacks inside the base, oldest first, as % depth: from each swing high to the lowest close
 * before price turns back up by vcpSwingPct (closes only).
 */
export function basePullbacks(s: Close[], from: number, to: number): number[] {
  const rev = BO_RULES.vcpSwingPct / 100;
  const out: number[] = [];
  let peak = s[from]!.close;
  let trough = peak;
  let down = true;
  for (let i = from + 1; i < to; i++) {
    const c = s[i]!.close;
    if (down) {
      if (c < trough) trough = c;
      else if (c >= trough * (1 + rev)) {
        out.push((1 - trough / peak) * 100);
        down = false;
        peak = c;
      }
    } else if (c > peak) peak = c;
    else if (c <= peak * (1 - rev)) {
      down = true;
      trough = c;
    }
  }
  if (down && trough < peak) out.push((1 - trough / peak) * 100);
  return out;
}

/** VCP: shallower pullbacks + last ≤ 10% + ATR/volume coil. */
function isVcp(s: Close[], pivotIdx: number, t: number): boolean {
  const len = t - pivotIdx;
  if (len < BO_RULES.vcpMinDays) return false;
  if (!isCoiling(s, pivotIdx, t)) return false;
  const all = basePullbacks(s, pivotIdx, t).filter((d) => d >= 1);
  if (!all.length) return false;
  const deepest = all.indexOf(Math.max(...all));
  const dips = all.slice(deepest);
  if (dips.length < 2) return false;
  for (let i = 1; i < dips.length; i++) if (dips[i]! > dips[i - 1]! * 1.1) return false;
  const last = dips[dips.length - 1]!;
  if (last > Math.min(...dips.slice(0, -1)) || last > BO_RULES.vcpLastDepthPct) return false;
  return true;
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

export type DetectOpts = {
  listing?: string | null;
  /** IBD-style RS 1–99 when known (universe / screen gates). */
  rs?: number | null;
};

/**
 * Breakout today from a base, or null. Applies anatomy base rules (3+ weeks, ≤35% deep,
 * within 20% of pivot) then tags screens. IPO (<50 weeks) waives RS / 200-day and
 * prefers the IPO tag over VCP/none for any qualifying base.
 */
export function detectBreakout(sIn: Close[], opts?: DetectOpts): Hit | null {
  const listing = opts?.listing ?? null;
  const lastIn = sIn[sIn.length - 1];
  const ageMs = listing && lastIn ? Date.parse(lastIn.date) - Date.parse(listing) : null;
  // Under 50 weeks listed. Yahoo often keeps earlier ticker history — trim to listing
  // so pre-IPO bars don't invent multi-year bases or block the IPO tag.
  const youngIpo =
    listing != null && ageMs != null && ageMs >= 0 && ageMs <= BO_RULES.ipoMaxDays * 86_400_000;
  let s = sIn;
  if (youngIpo && listing) {
    const listingMs = Date.parse(listing);
    const start = sIn.findIndex((b) => Date.parse(b.date) >= listingMs);
    if (start > 0) s = sIn.slice(start);
  }

  const t = s.length - 1;
  // Need a prior bar + room for a 3-week base (IPOs can be shorter than 60 sessions).
  if (t < BO_RULES.minBaseDays + 1) return null;
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
  // The first close through the pivot counts however strong the day (closes-only pivots sit below
  // the intraday high); after that, more than abovePct above it is extended, not a breakout.
  if (above < -BO_RULES.belowPct || (above > BO_RULES.abovePct && prev > pivot)) return null;
  // Currently coiling near the pivot (anatomy: within 20%).
  if (c < pivot * (1 - BO_RULES.nearPivotPct / 100)) return null;
  let low = Infinity;
  for (let i = pivotIdx; i < t; i++) low = Math.min(low, s[i]!.close);
  const depth = (1 - low / pivot) * 100;
  if (depth < BO_RULES.minDepthPct) return null;
  const longBase = baseDays >= BO_RULES.multiYearDays;
  // ≤35% depth for normal bases; multi-year coils are often deeper — don't kill them here.
  if (!longBase && depth > BO_RULES.maxDepthPct) return null;

  // Universe “coiling quietly” — waived for IPO and multi-year (anatomy doesn’t require it there).
  if (!youngIpo && !longBase && !isCoiling(s, pivotIdx, t)) return null;

  const sma50 = smaAt(s, t, BO_RULES.sma50);
  const sma200 = smaAt(s, t, BO_RULES.sma200);
  const rs = opts?.rs ?? null;

  // IPO: any qualifying base while listed <50 weeks. Hold 50-day once it exists; before that, waive.
  // (Second bases after the IPO high still count — requiring ATH left the tab empty most days.)
  const ipoSmaOk = sma50 == null ? t + 1 < BO_RULES.sma50 : c >= sma50;
  const ipoOk = youngIpo && ipoSmaOk;

  const tags: BoScreen[] = [];
  // Multi-year: 52+ week base, above 200-day, RS 60+.
  if (longBase && sma200 != null && c >= sma200 && (rs == null || rs >= BO_RULES.multiYearRs)) tags.push("multi");
  if (ipoOk) tags.push("ipo");
  // VCP: prior leadership RS 70+ when known (isVcp includes ATR/volume coil).
  if (isVcp(s, pivotIdx, t) && (rs == null || rs >= BO_RULES.universeRs)) tags.push("vcp");
  // Blue sky: all-time high with enough history, RS 70+.
  if (allTime && s.length >= BO_RULES.blueSkyMinBars && (rs == null || rs >= BO_RULES.blueSkyRs)) tags.push("blue");

  // Prefer IPO over generic tags for young listings.
  if (ipoOk) {
    const rest = tags.filter((x) => x !== "ipo");
    tags.length = 0;
    tags.push("ipo", ...rest);
  }
  const screen: BoScreen = tags[0] ?? "none";

  const from = Math.max(0, pivotIdx - Math.max(15, Math.round(baseDays * 0.3)));
  return {
    ...dayStats(s),
    pivot,
    above_pct: above,
    base_weeks: Math.round(baseDays / 5),
    screen,
    also: tags.slice(1),
    breakout_date: s[t]!.date,
    ...sparkline(s, from, pivotIdx),
  };
}

/**
 * Most recent qualifying breakout in the last `freshSessions` bars (today first).
 * Price / day % / rel vol are always from the latest bar so the card stays current.
 */
export function detectFreshBreakout(s: Close[], opts?: DetectOpts): Hit | null {
  const n = s.length;
  if (n < 2) return null;
  const look = Math.min(BO_RULES.freshSessions, n);
  for (let back = 0; back < look; back++) {
    const end = n - 1 - back;
    const hit = detectBreakout(s.slice(0, end + 1), opts);
    if (!hit || hit.pivot == null) continue;
    if (back === 0) return hit;
    // Rebuild sparkline through today so the card shows the move after the breakout day.
    let pivotIdx = -1;
    for (let i = 0; i <= end; i++) {
      if (Math.abs(s[i]!.close - hit.pivot) < 1e-6) pivotIdx = i;
    }
    if (pivotIdx < 0) pivotIdx = Math.max(0, end - (hit.base_weeks ?? 3) * 5);
    const from = Math.max(0, pivotIdx - Math.max(15, Math.round((end - pivotIdx) * 0.3)));
    return {
      ...hit,
      ...dayStats(s),
      breakout_date: s[end]!.date,
      ...sparkline(s, from, pivotIdx),
    };
  }
  return null;
}

/**
 * Anatomy universe gate. IPO breakouts skip RS 70+ and 200-day (too young);
 * lockout-only rows only need liquidity.
 */
export function passesUniverse(
  s: Close[],
  opts: {
    mcapCr: number | null;
    rs: number | null;
    screen: BoScreen | null;
    /** true = lockout-only (no breakout today). */
    lockoutOnly?: boolean;
  },
): boolean {
  const t = s.length - 1;
  const c = s[t]!.close;
  if ((opts.mcapCr ?? 0) < BO_RULES.minMcapCr) return false;
  const turn = avgDailyValueCr(s);
  if (turn == null || turn < BO_RULES.minDailyValueCr) return false;
  if (opts.lockoutOnly) return true;

  const ipo = opts.screen === "ipo";
  const multi = opts.screen === "multi";
  const sma50 = smaAt(s, t, BO_RULES.sma50);
  if (ipo) {
    // 50-day only once the average exists; RS / 200-day waived for young listings.
    if (sma50 != null && c < sma50) return false;
  } else {
    if (sma50 == null || c < sma50) return false;
    const sma200 = smaAt(s, t, BO_RULES.sma200);
    if (sma200 == null || c < sma200) return false;
    // Multi-year anatomy is RS 60+; other screens use the 70+ leadership floor.
    const needRs = multi ? BO_RULES.multiYearRs : BO_RULES.universeRs;
    if (opts.rs != null && opts.rs < needRs) return false;
  }
  const hi = recentHigh(s);
  if (hi > 0 && c < hi * (1 - BO_RULES.withinHighPct / 100)) return false;
  return true;
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
  const listed = listingDates();
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
    const t = m.ticker.toUpperCase();
    const rs = rsOf(raws[i] ?? null);
    const mcap = metrics.get(t)?.market_cap_cr ?? null;
    const hit = detectFreshBreakout(s, { listing: listed.get(t) ?? null, rs });
    const lo = currentLockout(s);
    if (!hit && !lo) return;
    const lockoutOnly = !hit && !!lo;
    if (
      !passesUniverse(s, {
        mcapCr: mcap,
        rs,
        screen: hit?.screen ?? null,
        lockoutOnly,
      })
    )
      return;
    const lockout = lo ? { green: lo.green, gain_pct: lo.gain_pct, start: lo.start, from_price: lo.from_price, weeks: lo.weeks, base_weeks: lo.base_weeks } : null;
    const body: Hit = hit ?? {
      ...dayStats(s),
      pivot: null,
      above_pct: null,
      base_weeks: null,
      screen: null,
      also: [],
      breakout_date: null,
      ...sparkline(s, Math.max(0, lo!.start_idx - 40), lo!.start_idx),
    };
    const lab = labels.get(t);
    rows.push({
      ticker: t,
      name: m.name,
      market: m.market || "NSE",
      industry: lab?.industry ?? lab?.sector ?? null,
      sector: lab?.sector ?? null,
      website: sites.get(t) ?? null,
      mcap_cr: mcap,
      rs,
      lockout,
      ...body,
    });
  });
  rows.sort((a, b) => (b.rs ?? -1) - (a.rs ?? -1) || (b.base_weeks ?? 0) - (a.base_weeks ?? 0));
  const result: BoResult = { date, rows, universe: members.length, refreshing: rotationBarsRefreshing(), rules: BO_RULES };
  cache = { at: Date.now(), result };
  return result;
}
