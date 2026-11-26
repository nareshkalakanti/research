import { isRightsOrPartlyPaid } from "./listing-name-match";
import { weekKey } from "./lockout";
import { loadMetricsMap } from "./metrics";
import { fetchNiftyDailyBars } from "./ohlc";
import { cachedRotationCloses, type Close } from "./rotation-bars";
import { listRotationSectors, type SectorMember } from "./sector-rotation";
import { rotationFetchYears } from "./sector-rotation-series";
import { openSqliteNamed } from "./sqlite-utils";
import { masterLabels } from "./stock-master";

/**
 * Momentum and Money: yearly winners (200%+ from the 52-week low) and, for each, the
 * measures from the user's "Winners" study — stage 4 decline, lockout rally, bases —
 * read from saved daily closes (rotation_bars.db; no fetching).
 *
 * Definitions (closes only; a week = Mon–Sun, its last close):
 *   Gains from 52wk low   best day of the year: close ÷ lowest close of the 52 weeks before it − 1
 *   YoY change            that day's close ÷ the close a year earlier − 1
 *   Lockout rally         after the 52-week low, the first 8-week stretch with 6+ green weeks whose run makes a 50%+
 *                         up move (notes: "6/8 green weeks, min 50% up move"); starts at the lowest weekly close
 *                         before the stretch, ends at the high before the first pause of 4+ weeks
 *                         (notes: "pause for 4–12 weeks")
 *   Stage 4 decline       within the 2 years before the rally: highest close → the lowest close after it
 *   Base 1 / Base 2       pause of 4+ weeks from a high until a weekly close above it: depth (high → lowest close) / weeks
 */
export const MM_RULES = {
  lockoutWeeks: 8,
  lockoutGreen: 6,
  urgency12: 9,
  minUpPct: 50,
  /** A pause this long (no close above the swing high) is a base and ends the rally. */
  baseWeeks: 4,
  priorHighWeeks: 104,
  bigWeekPct: 20,
  ipoYears: 3,
} as const;

type Week = { close: number; first: number; last: number };

export type MmBase = { depth_pct: number; weeks: number; open: boolean; nifty_pct: number | null; start: string; end: string | null };

export type MmStudy = {
  rally_from: string;
  rally_to: string;
  rally_weeks: number;
  rally_pct: number;
  green8: number;
  green12: number | null;
  big_weeks: number;
  first_big_week: string | null;
  stage4_pct: number | null;
  /** Nifty's fall over the same dates, %. */
  stage4_nifty_pct: number | null;
  /** Stock decline ÷ Nifty decline. */
  stage4_x: number | null;
  /** Fewer than 2 years of saved prices before the rally. */
  short_history: boolean;
  base1: MmBase | null;
  base2: MmBase | null;
};

export type MmRow = {
  ticker: string;
  name: string;
  market: string;
  listing_date: string | null;
  yoy_pct: number | null;
  gain_pct: number;
  industry: string | null;
  mcap_cr: number | null;
  /** Listed within 3 years before the rally started. */
  ipo: boolean;
  study: MmStudy | null;
};

export type MmResult = {
  year: number;
  years: number[];
  as_of: string | null;
  rows: MmRow[];
  universe: number;
  nifty: boolean;
  rules: typeof MM_RULES;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

function weekly(s: Close[]): Week[] {
  const out: Week[] = [];
  let wk = "";
  for (let i = 0; i < s.length; i++) {
    const k = weekKey(s[i]!.date);
    if (k !== wk) {
      out.push({ close: s[i]!.close, first: i, last: i });
      wk = k;
    } else {
      const w = out[out.length - 1]!;
      w.close = s[i]!.close;
      w.last = i;
    }
  }
  return out;
}

/** Index of the last bar on or before an ISO date (−1 when none). */
function idxOnOrBefore(s: { date: string }[], iso: string): number {
  let lo = 0;
  let hi = s.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid]!.date <= iso) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function isoMinusDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Nifty fall between two dates: highest close in the span → close at the end, %. */
function niftyFall(nifty: Close[] | null, from: string, to: string): number | null {
  if (!nifty?.length) return null;
  const a = idxOnOrBefore(nifty, from);
  const b = idxOnOrBefore(nifty, to);
  if (a < 0 || b < a || nifty[0]!.date > from) return null;
  let hi = 0;
  for (let i = a; i <= b; i++) hi = Math.max(hi, nifty[i]!.close);
  return hi > 0 ? r1((1 - nifty[b]!.close / hi) * 100) : null;
}

/** Pause from week h (a high) until a weekly close above it. */
function baseFrom(s: Close[], w: Week[], h: number, nifty: Close[] | null): { base: MmBase; breakout: number | null } {
  const H = w[h]!.close;
  let low = Infinity;
  let k = h + 1;
  for (; k < w.length; k++) {
    if (w[k]!.close > H) break;
    low = Math.min(low, w[k]!.close);
  }
  const open = k >= w.length;
  const endW = open ? w.length - 1 : k;
  const start = s[w[h]!.last]!.date;
  const end = open ? null : s[w[k]!.last]!.date;
  const nf = niftyFall(nifty, start, s[w[open ? w.length - 1 : k - 1]!.last]!.date);
  return {
    base: {
      depth_pct: Number.isFinite(low) ? r1((1 - low / H) * 100) : 0,
      weeks: endW - h,
      open,
      nifty_pct: nf,
      start,
      end,
    },
    breakout: open ? null : k,
  };
}

/** The winner's lockout rally, the stage 4 decline before it, and the two bases after it. */
export function studyWinner(s: Close[], lowIdx: number, nifty: Close[] | null, R = MM_RULES): MmStudy | null {
  const w = weekly(s);
  const lowW = w.findIndex((x) => x.first <= lowIdx && lowIdx <= x.last);
  if (lowW < 0) return null;
  // Runs after the low: an 8-week stretch with 6+ green weeks, carried to the first 4+ week pause; the
  // first such run that makes a 50%+ move is the lockout rally.
  const runEnd = (from: number) => {
    let h = from;
    for (let k = from + 1; k < w.length; k++) {
      if (w[k]!.close > w[h]!.close) h = k;
      else if (k - h >= R.baseWeeks) break;
    }
    return h;
  };
  let searchFrom = lowW;
  let s0 = -1;
  let hW = -1;
  for (let a = lowW + 1; a + R.lockoutWeeks - 1 < w.length; a++) {
    let g = 0;
    for (let k = a; k < a + R.lockoutWeeks; k++) if (w[k]!.close > w[k - 1]!.close) g++;
    if (g < R.lockoutGreen) continue;
    let st = searchFrom;
    for (let k = searchFrom; k < a; k++) if (w[k]!.close < w[st]!.close) st = k;
    const end = runEnd(st);
    if ((w[end]!.close / w[st]!.close - 1) * 100 >= R.minUpPct) {
      s0 = st;
      hW = end;
      break;
    }
    // Too small: look again after this run.
    searchFrom = Math.max(end, a);
    a = searchFrom;
  }
  if (s0 < 0) return null;
  const startPrice = w[s0]!.close;
  const green = (from: number, len: number) => {
    let g = 0;
    for (let k = from; k < Math.min(w.length, from + len); k++) if (w[k]!.close > w[k - 1]!.close) g++;
    return g;
  };
  let big = 0;
  let firstBig: string | null = null;
  for (let k = s0 + 1; k <= hW; k++)
    if ((w[k]!.close / w[k - 1]!.close - 1) * 100 >= R.bigWeekPct) {
      big++;
      firstBig ??= s[w[k]!.last]!.date;
    }
  // Stage 4: within the 2 years before the start, the highest close and the lowest close after it.
  const from = Math.max(0, s0 - R.priorHighWeeks);
  let ph = from;
  for (let k = from; k <= s0; k++) if (w[k]!.close > w[ph]!.close) ph = k;
  let pl = ph;
  for (let k = ph; k <= s0; k++) if (w[k]!.close < w[pl]!.close) pl = k;
  const decline = pl > ph ? (1 - w[pl]!.close / w[ph]!.close) * 100 : 0;
  const nf = pl > ph ? niftyFall(nifty, s[w[ph]!.last]!.date, s[w[pl]!.last]!.date) : null;
  const b1 = hW < w.length - 1 ? baseFrom(s, w, hW, nifty) : null;
  let b2: MmBase | null = null;
  if (b1?.breakout != null) {
    // Next pause of 4+ weeks after the base 1 breakout.
    const h = runEnd(b1.breakout);
    if (h < w.length - 1) b2 = baseFrom(s, w, h, nifty).base;
  }
  return {
    rally_from: s[w[s0]!.last]!.date,
    rally_to: s[w[hW]!.last]!.date,
    rally_weeks: hW - s0,
    rally_pct: r1((w[hW]!.close / startPrice - 1) * 100),
    green8: green(s0 + 1, R.lockoutWeeks),
    green12: s0 + 12 < w.length ? green(s0 + 1, 12) : null,
    big_weeks: big,
    first_big_week: firstBig,
    stage4_pct: r1(decline),
    stage4_nifty_pct: nf,
    stage4_x: nf != null && nf >= 3 ? r1(decline / nf) : null,
    short_history: s0 - R.priorHighWeeks < 0,
    base1: b1?.base ?? null,
    base2: b2,
  };
}

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

/** NSE listing dates saved earlier in strategy.db (read only); empty when missing. */
function listingDates(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const db = openSqliteNamed("strategy.db", { readonly: true });
    try {
      const rows = db.prepare("SELECT ticker, listing_date FROM ipo_listing_dates").all() as Array<{ ticker: string; listing_date: string }>;
      for (const r of rows) out.set(r.ticker.toUpperCase(), r.listing_date);
    } finally {
      db.close();
    }
  } catch {
    /* no saved listing dates */
  }
  return out;
}

async function niftyCloses(years: number): Promise<Close[] | null> {
  try {
    const bars = await fetchNiftyDailyBars(years);
    return bars.length ? bars.map((b) => ({ date: b.date, close: b.close })) : null;
  } catch {
    return null;
  }
}

const cache = new Map<number, { at: number; result: MmResult }>();
const CACHE_MS = 10 * 60_000;

/** All stocks with saved prices: winners of `year` (gain from the 52-week low ≥ 100% kept; the page filters). */
export async function buildMomentumMoney(year?: number): Promise<MmResult> {
  const nowYear = new Date().getUTCFullYear();
  const y = year && year >= 2000 && year <= nowYear ? year : nowYear - 1;
  const hit = cache.get(y);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const members = uniqueMembers();
  const yearsBack = rotationFetchYears();
  const nifty = await niftyCloses(yearsBack + 1);
  const metrics = loadMetricsMap();
  const labels = masterLabels();
  const listed = listingDates();
  const yearEnd = `${y}-12-31`;
  let asOf: string | null = null;
  let firstYear = nowYear;

  const rows: MmRow[] = [];
  for (const m of members) {
    const s = cachedRotationCloses(m.ticker, m.market, yearsBack);
    if (s.length < 60) continue;
    firstYear = Math.min(firstYear, Number(s[0]!.date.slice(0, 4)));
    const end = idxOnOrBefore(s, yearEnd);
    if (end < 0 || s[end]!.date < `${y}-01-01`) continue;
    if (!asOf || s[end]!.date > asOf) asOf = s[end]!.date;
    const start = idxOnOrBefore(s, `${y - 1}-12-31`) + 1;
    // Best day of the year: close vs the lowest close of the 52 weeks before it (sliding minimum).
    let best = -1;
    let bestGain = -Infinity;
    let bestLow = -1;
    const dq: number[] = [];
    let from = 0;
    for (let i = 0; i <= end; i++) {
      while (dq.length && s[dq[dq.length - 1]!]!.close >= s[i]!.close) dq.pop();
      dq.push(i);
      const cut = isoMinusDays(s[i]!.date, 365);
      while (s[from]!.date <= cut) from++;
      while (dq[0]! < from) dq.shift();
      if (i < start) continue;
      const g = s[i]!.close / s[dq[0]!]!.close - 1;
      if (g > bestGain) {
        bestGain = g;
        best = i;
        bestLow = dq[0]!;
      }
    }
    if (best < 0) continue;
    const gain = bestGain * 100;
    if (gain < 100) continue;
    const lowIdx = bestLow;
    const yearAgo = idxOnOrBefore(s, isoMinusDays(s[best]!.date, 365));
    const t = m.ticker.toUpperCase();
    const lab = labels.get(t);
    const study = studyWinner(s, lowIdx, nifty);
    const ld = listed.get(t) ?? null;
    const ipo =
      ld != null && study != null && Date.parse(study.rally_from) - Date.parse(ld) <= MM_RULES.ipoYears * 365.25 * 86_400_000;
    rows.push({
      ticker: t,
      name: m.name,
      market: m.market || "NSE",
      listing_date: ld,
      yoy_pct: yearAgo >= 0 && Date.parse(s[best]!.date) - Date.parse(s[yearAgo]!.date) >= 350 * 86_400_000 ? r1((s[best]!.close / s[yearAgo]!.close - 1) * 100) : null,
      gain_pct: r1(gain),
      industry: lab?.industry ?? lab?.sector ?? null,
      mcap_cr: metrics.get(t)?.market_cap_cr ?? null,
      ipo,
      study,
    });
  }
  rows.sort((a, b) => b.gain_pct - a.gain_pct);
  const years: number[] = [];
  for (let k = nowYear; k >= Math.max(firstYear, nowYear - 6); k--) years.push(k);
  const result: MmResult = { year: y, years, as_of: asOf, rows, universe: members.length, nifty: nifty != null, rules: MM_RULES };
  cache.set(y, { at: Date.now(), result });
  return result;
}
