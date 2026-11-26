import { loadAllCompanies } from "./db";
import { isRightsOrPartlyPaid } from "./listing-name-match";
import { currentLockout, lockoutRallies, weekKey, type Lockout } from "./lockout";
import { loadMetricsMap } from "./metrics";
import { fetchNseMainEquityList, fetchNseSmeEquityList, isNseRightsEntitlement } from "./nse-equity-lists";
import { cachedRotationCloses, onRotationBarsRefreshed, rotationBarsRefreshing, rotationCloses, type Close } from "./rotation-bars";
import { rotationFetchYears } from "./sector-rotation-series";
import { openSqliteNamed } from "./sqlite-utils";
import { masterLabels } from "./stock-master";

/**
 * IPO2: stocks listed in the last 4 years, their bases since listing, and the
 * entry points (low cheat, cheat, pivot breakout, E1B / E2B adds) with stops.
 *
 * Works on saved daily closes and volume only (rotation_bars.db) — never fetches
 * prices. Closes only (no saved high / low / open), so:
 *   - "listing price" is the first close, not the issue price;
 *   - the day-1 ignite bar and QIB subscription are not checked (no data).
 */

export const IPO2_RULES = {
  /** Listed within this many years. */
  maxAgeYears: 4,
  /**
   * Urgency (IPO V2.0 notes): 6 of the first 8 weekly bars green after listing,
   * or 6 of the first 9 sessions green on the daily chart ("5-6 green days / 8-9").
   * Green = closed above the previous close (closes only, no opens saved).
   */
  urgencyWeeks: 8,
  urgencyGreenWeeks: 6,
  urgencyDays: 9,
  urgencyGreenDays: 6,
  /** The 8-week move is still shown (info only, not a rule). */
  runDays: 40,
  /**
   * Listing-range breakout (IREDA "urgency in the base, buy here", Jyoti CNC 473,
   * Waaree 2450): in the first sessions after listing, the first close above the
   * highest close since listing, after at least 2 sessions of pause, with all
   * closes since listing within a tight range. Stop under the post-listing low.
   */
  ipoRangeMinPause: 2,
  ipoRangeMaxDays: 15,
  ipoRangePct: 15,
  /**
   * Sell signals while holding (IPO V2.0 charts: Kaynes "first daily extension, close 2/3 …
   * 2nd daily extension, close 1/3", Jyoti CNC "sold 1/3rd" twice at the orange 10% marks,
   * HIL "56% up move, 12 green days in a row, highest vols"):
   *   1st / 2nd extension  close ≥ 10% above its 10-day average; the 2nd after cooling back
   *                        under 5%, or straight on once 5%+ above the 1st extension's close
   *   Climax run           ≥ 25% in 10 sessions with 8+ green days (on the highest volume
   *                        since the entry when volume is saved)
   * No position sizes: a sell signal after an entry is enough (the user's call — the notes
   * sell 1/3, 2/3 or halves depending on the chart).
   * Counted per position: the first entry from a new base starts the count again
   * (adds, and a second entry from the same base, don't).
   */
  extMaDays: 10,
  extPct: 10,
  extResetPct: 5,
  climaxDays: 10,
  climaxRisePct: 25,
  climaxGreenDays: 8,
  /** A sell signal is "now" for this many sessions. */
  sellFreshDays: 5,
  /** A rest of this many trading days below the high is a base (IPO base / later bases). */
  ipoBaseMinDays: 15,
  baseMinDays: 25,
  /** Shallower than this is a pause, not a base. */
  baseMinDepthPct: 8,
  /** The IPO base may be tighter (Cyient DLM: 7.5% deep, first long on its breakout). */
  ipoBaseMinDepthPct: 5,
  /** Outside the IPO base, a base needs this much rise into its high (from the low of the prior ~6 months). */
  priorRisePct: 25,
  priorRiseDays: 126,
  /** Ideal and maximum depth (IPO base may go deeper). */
  idealDepth: [18, 26] as [number, number],
  maxDepthIpoPct: 40,
  maxDepthPct: 35,
  /** Base volume shape: length of the quiet "bottom" week, searched within 2× this either side of the low. */
  bottomDays: 5,
  /** Quietest bottom week at or under this × the left-side average = dried up (median base is ~0.4). */
  volCoolX: 0.6,
  /** Right side needs this many sessions before it's judged. */
  rightMinDays: 5,
  /** Right-side up-day volume this many × down-day volume counts as returning even if the side is quiet overall. */
  rightUpDownX: 1.5,
  /** Tight pause: 5 closes within this range (moving sideways), volume below average. */
  pauseDays: 5,
  pauseRangePct: 6,
  pauseVolX: 0.8,
  /** Pivot area: within this % of the base high. */
  pivotNearPct: 10,
  /** Breakout volume confirmation (× 50-day average). */
  breakoutVolX: 1.5,
  /** Small base on top of a leg (E1B / E2B): pause length and depth. */
  addMinDays: 5,
  addMinDepthPct: 3,
  addMaxDepthPct: 12,
  /** An entry is still buyable this many trading days later, up to this % above its level. */
  freshDays: 10,
  chaseMaxPct: 5,
  /** Stop more than this % under the buy level: too wide to count as an entry. */
  maxRiskPct: 10,
  /** Stops sit under the pause / pivot low, capped at this % below the buy level. */
  maxStopPct: 8,
  /** Latest-quarter growth (YoY) needed for the growth check. */
  growthPct: 20,
  /** NSE date shared by this many listings = a batch of older BSE companies admitted to NSE. */
  bulkListingDay: 20,
  /** BSE scrip codes below this were issued before ~2021: an older company, not an IPO. */
  newBseCodeMin: 543000,
  /** Saved prices of this many stocks starting the same day = a data gap, not listings. */
  bulkFirstTrade: 10,
  /** Growth check uses a quarter ending within this many months. */
  growthMaxAgeMonths: 9,
  /** One-day close ratio beyond these (past any exchange circuit) = split / bonus. */
  splitDrop: 0.65,
  splitJump: 1.55,
  /** Day-1 close outside this × the issue price: history is on another share basis (split / bonus since). */
  issueBasisMin: 0.6,
  issueBasisMax: 4,
  /** Trendline break (Syrma, Cyient DLM first entries): base this many sessions old, line's 2nd touch this far after the high. */
  tlMinDays: 20,
  tlMinGap: 10,
  /** Closes may poke this % over the line without breaking it. */
  tlTolPct: 0.5,
  /** A line needs this many peaks touching it (within tlTouchPct) after the high. */
  tlTouches: 2,
  tlTouchPct: 1.5,
  /**
   * Add on the 10/20-day band (Jyoti CNC "E/D" bounce, then "Pyramid – 2nd long"): after a breakout,
   * on E1 / E2, a pullback that closes into the 10/20-day averages (not more than 3% under the 20-day)
   * and bounces: a green close back above the 10-day while the 10-day is above the 20-day.
   */
  bandLookback: 5,
  bandTolPct: 1,
  bandBelowPct: 3,
  /** Follow-through (Kaynes "buying comes with follow-through days"): the sessions after an entry. */
  followDays: 3,
  followGreen: 2,
  /** Their average volume at least this × the 50-day average. */
  followVolX: 1,
};

export type EntryKind = "ipo_range" | "trendline" | "low_cheat" | "cheat" | "pivot" | "add" | "band";

/** What happened in the sessions after an entry. */
export type FollowThrough = {
  /** Sessions seen so far (out of followDays). */
  days: number;
  green: number;
  /** Their average volume ÷ the 50-day average before the entry. */
  vol_x: number | null;
  /** Close at the end still above the buy level. */
  held: boolean;
  /** null while still in progress. */
  ok: boolean | null;
};

export type Ipo2Entry = {
  kind: EntryKind;
  label: string;
  idx: number;
  date: string;
  /** Buy level (the price that had to be crossed). */
  level: number;
  stop: number;
  risk_pct: number;
  base: number;
  /** Breakout volume ÷ 50-day average (pivot / add); null when no volume saved. */
  vol_x: number | null;
  /** Follow-through days after the entry. */
  follow: FollowThrough | null;
  /** Trendline entries: where the falling line starts (the base high) — drawn to (idx, level). */
  tl?: { from_idx: number; from_price: number };
};

export type SellKind = "ext1" | "ext2" | "climax";

export type Ipo2Sell = {
  kind: SellKind;
  label: string;
  /** What to do: "Sell", "Sell again", "Sell into strength" (no sizes). */
  action: string;
  idx: number;
  date: string;
  price: number;
  /** Close vs its 10-day average, %. */
  ext_pct: number;
  /** Gain over the last 10 sessions, % (climax). */
  run_pct: number | null;
};

export type Ipo2Base = {
  n: number;
  start_idx: number;
  start: string;
  end_idx: number | null;
  end: string | null;
  high: number;
  low: number;
  depth_pct: number;
  days: number;
  ipo_base: boolean;
  status: "open" | "breakout" | "failed";
  /** A setup: IPO base, or a base after a 25%+ rise. Others are rests in a downtrend — no entries. */
  valid: boolean;
  /** Rise into the base high from the prior ~6-month low (null for the IPO base). */
  prior_rise_pct: number | null;
  /** Volume shape: heavy on the left, drying up at the bottom, returning on the right. Null without volume. */
  vol: BaseVolume | null;
};

/** Volume across a base, each side as × the base's own average daily volume. */
export type BaseVolume = {
  /** Lowest close of the base (splits left side from right side). */
  low_idx: number;
  /** Left side: from the base high down to the low. */
  left_x: number;
  /** Bottom: the quietest week near the low. */
  bottom_x: number;
  /** Right side: from the low back up toward the pivot. */
  right_x: number;
  /** Right side: average volume on up days ÷ down days (above 1 = buying). */
  right_updown: number | null;
  /** Selling heavier on the left than at the bottom. */
  cooled: boolean;
  /** Volume coming back on the right: right side above the bottom and up days outweigh down days. */
  returning: boolean | null;
};

export type Ipo2Stage =
  | "new"
  | "running"
  | "pullback"
  | "in_base"
  | "near_pivot"
  | "buy_zone"
  | "extended"
  | "late"
  | "broken"
  | "no_rise";

export type Ipo2Analysis = {
  bars: number;
  first_close: number;
  last_close: number;
  last_date: string;
  run_pct: number | null;
  /** What the first run is measured from: the IPO issue price, or the listing-day close when no issue price is known. */
  run_base: "issue" | "first_close" | null;
  /** Issue price (as issued, before any later split adjustment) and the day-1 close vs it. */
  issue_price: number | null;
  /** Issue price known but the price history is on another share basis: not used. */
  issue_mismatch: boolean;
  listing_gain_pct: number | null;
  urgency: boolean | null;
  /** Green weekly bars in the first 8 weeks after listing (weeks so far when younger). */
  green_weeks: number | null;
  weeks_seen: number;
  /** Green days in the first 9 sessions after listing day. */
  green_days: number | null;
  days_seen: number;
  bases: Ipo2Base[];
  entries: Ipo2Entry[];
  /** Sell signals while holding: 1st / 2nd daily extension, climax run. */
  sells: Ipo2Sell[];
  /** Latest sell signal when it's within the last few sessions. */
  sell_now: Ipo2Sell | null;
  /** Lockout rallies: 6/8 green weekly bars at the end of stage 1 / start of stage 2. */
  lockouts: Lockout[];
  /** Lockout rally still running (this week or last). */
  lockout: Lockout | null;
  /** Expansion legs since the last breakout (1 = E1, 2 = E2, 3+ = E3 / late). */
  legs: number;
  stage: Ipo2Stage;
  stage_note: string;
  /** Latest entry still buyable (fresh, not chased, above its stop). */
  live_entry: Ipo2Entry | null;
  /** Listed-in-window rules (IPO base, urgency) were applied. */
  listed: boolean;
  /** One-day jumps treated as splits / bonuses (earlier prices adjusted). */
  corp_actions: CorpAction[];
  /** Current or last base high (pivot level) and the distance to it. */
  pivot: number | null;
  to_pivot_pct: number | null;
  vol_dry: boolean | null;
  verdict: Verdict;
};

/** Final call for the stock from its stage, entry and base quality. */
export type Verdict = {
  call: "buy" | "watch" | "wait" | "avoid";
  /** One line: what to do now. */
  action: string;
  /** Why: good points (+) and cautions (−). */
  reasons: Array<{ good: boolean; text: string }>;
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

function avgVol(v: number[], end: number, len: number, floor = 0): number | null {
  let s = 0;
  let k = 0;
  for (let j = Math.max(floor, end - len); j < end; j++) {
    if (v[j]! > 0) {
      s += v[j]!;
      k++;
    }
  }
  return k >= Math.min(len, 10) ? s / k : null;
}

export type CorpAction = { date: string; ratio: number };

/**
 * Splits / bonuses the saved prices don't reflect: a one-day move past any
 * exchange circuit. Back-adjusts earlier closes (and volume) by that ratio.
 */
export function adjustCorporateActions(series: Close[], R = IPO2_RULES): { series: Close[]; actions: CorpAction[] } {
  const actions: CorpAction[] = [];
  let out: Close[] | null = null;
  for (let i = series.length - 1; i >= 1; i--) {
    const src = out ?? series;
    const prev = src[i - 1]!.close;
    const cur = src[i]!.close;
    if (!(prev > 0) || !(cur > 0)) continue;
    const ratio = cur / prev;
    if (ratio >= R.splitDrop && ratio <= R.splitJump) continue;
    out = out ?? series.map((b) => ({ ...b }));
    for (let j = 0; j < i; j++) {
      const b = out[j]!;
      b.close *= ratio;
      if (b.volume != null) b.volume /= ratio;
    }
    actions.push({ date: series[i]!.date, ratio: r2(ratio) });
  }
  return { series: out ?? series, actions: actions.reverse() };
}

const ENTRY_LABEL: Record<EntryKind, string> = {
  ipo_range: "Listing-range breakout",
  trendline: "Trendline break",
  low_cheat: "Low cheat",
  cheat: "Cheat",
  pivot: "Pivot breakout",
  add: "Add",
  band: "Band add",
};

/** Bases, entries and stage for a stock listed in the last 4 years (series starts at listing). */
export function analyzeIpo2(series: Close[], R = IPO2_RULES): Ipo2Analysis | null {
  return analyzeBases(series, { listed: true }, R);
}

/**
 * Bases, entries and current stage from daily closes.
 *   listed: true  — series starts on the listing day: first base is the IPO base
 *                   (no prior rise needed, may be deeper), urgency run checked.
 *   listed: false — any older stock: every base needs a 25%+ rise into it.
 * A base that fails (too deep) resets the count: the old high stops mattering and
 * the next setup needs a fresh 25% rise.
 */
export function analyzeBases(
  raw: Close[],
  opts: { listed: boolean; issuePrice?: number | null },
  R = IPO2_RULES,
): Ipo2Analysis | null {
  const listed = opts.listed;
  const { series, actions } = adjustCorporateActions(raw, R);
  const n = series.length;
  if (n < 2) return null;
  const c = series.map((b) => b.close);
  const v = series.map((b) => b.volume ?? 0);
  const hasVol = v.some((x) => x > 0);
  const d = (i: number) => series[i]!.date;

  const runEnd = Math.min(n, R.runDays + 1);
  const runMax = Math.max(...c.slice(0, runEnd));
  // Issue price on today's share basis (splits / bonuses since listing scale it too).
  const issue = listed && opts.issuePrice != null && opts.issuePrice > 0 ? opts.issuePrice : null;
  const issueScaled = issue != null ? actions.reduce((x, a) => x * a.ratio, issue) : null;
  // Prices already adjusted for a later split / bonus while the issue price isn't: not comparable.
  const issueMismatch =
    issueScaled != null && (c[0]! / issueScaled < R.issueBasisMin || c[0]! / issueScaled > R.issueBasisMax);
  const issueAdj = issueMismatch ? null : issueScaled;
  const runFrom = issueAdj ?? (listed ? c[0]! : null);
  const runPct = runFrom != null && runFrom > 0 ? (runMax / runFrom - 1) * 100 : null;
  const listingGain = issueAdj != null ? r1((c[0]! / issueAdj - 1) * 100) : null;
  // Urgency: count green weekly bars (first 8 weeks) and green days (first 9 sessions after listing day).
  // Week 1 is green when its close beats the issue price (or the day-1 close when no issue price is known).
  let greenWeeks: number | null = null;
  let weeksSeen = 0;
  let greenDays: number | null = null;
  let daysSeen = 0;
  if (listed) {
    const weekCloses: number[] = [];
    let wk = "";
    for (let i = 0; i < n && weekCloses.length <= R.urgencyWeeks; i++) {
      const k = weekKey(d(i));
      if (k !== wk) {
        weekCloses.push(c[i]!);
        wk = k;
      } else weekCloses[weekCloses.length - 1] = c[i]!;
    }
    // The last collected week may still be in progress only when it's the latest bar.
    const weeks = weekCloses.slice(0, R.urgencyWeeks);
    weeksSeen = weeks.length;
    let prev = issueAdj ?? c[0]!;
    greenWeeks = 0;
    for (const w of weeks) {
      if (w > prev) greenWeeks++;
      prev = w;
    }
    const dEnd = Math.min(n - 1, R.urgencyDays);
    daysSeen = Math.max(0, dEnd);
    greenDays = 0;
    for (let i = 1; i <= dEnd; i++) if (c[i]! > c[i - 1]!) greenDays++;
  }
  const weeksOk = greenWeeks != null && greenWeeks >= R.urgencyGreenWeeks;
  const daysOk = greenDays != null && greenDays >= R.urgencyGreenDays;
  // Can't reach 6 any more: no. Still possible and not all weeks seen: undecided.
  const weeksLeft = R.urgencyWeeks - weeksSeen;
  const daysLeft = R.urgencyDays - daysSeen;
  const urgency = !listed
    ? null
    : weeksOk || daysOk
      ? true
      : (greenWeeks ?? 0) + weeksLeft >= R.urgencyGreenWeeks || (greenDays ?? 0) + daysLeft >= R.urgencyGreenDays
        ? null
        : false;

  const bases: Ipo2Base[] = [];
  const entries: Ipo2Entry[] = [];
  let H = c[0]!;
  let hIdx = 0;
  let minSinceH = c[0]!;
  let base: Ipo2Base | null = null;
  let pause: { hi: number; lo: number; zone: "low" | "mid" } | null = null;
  let tookLow = false;
  let tookMid = false;
  let tookTrend = false;
  /** One band add per pullback (resets on a new high). */
  let tookBand = false;
  const ma = (len: number) => {
    const out: number[] = new Array(n).fill(NaN);
    let sum = 0;
    for (let k = 0; k < n; k++) {
      sum += c[k]!;
      if (k >= len) sum -= c[k - len]!;
      if (k >= len - 1) out[k] = sum / len;
    }
    return out;
  };
  const ma10 = ma(10);
  const ma20 = ma(20);
  /** Stop of this base's trendline entry: a close under it re-arms the trendline (a new line can form). */
  let trendStop = 0;
  let lastBreakout: number | null = null;
  let legs = 0;
  /** Valid bases since the last reset (a failed base). */
  let seq = 0;
  let resetIdx = 0;
  let lastFail: { idx: number; depth: number; label: string } | null = null;

  // Listing-day volume dwarfs everything after it: leave the first two sessions out of volume averages.
  const volFloor = listed ? 2 : 0;
  const push = (kind: EntryKind, i: number, level: number, structStop: number, label?: string) => {
    const a = avgVol(v, i, 50, volFloor);
    // Stop under the pause / pivot low, but never more than maxStopPct below the buy level.
    const stop = Math.max(structStop, level * (1 - R.maxStopPct / 100));
    entries.push({
      kind,
      label: label ?? ENTRY_LABEL[kind],
      idx: i,
      date: d(i),
      level: r2(level),
      stop: r2(stop),
      risk_pct: r1(((level - stop) / level) * 100),
      base: base?.n ?? bases.length,
      vol_x: hasVol && a ? r2(v[i]! / a) : null,
      follow: null,
    });
  };

  for (let i = 1; i < n; i++) {
    const p = c[i]!;
    if (p > H) {
      if (base && base.status === "open" && base.valid) {
        // Breakout from a live base: the pivot entry, stop under the pivot area.
        base.status = "breakout";
        base.end_idx = i;
        base.end = d(i);
        const stop = Math.min(...c.slice(Math.max(base.start_idx, i - 10), i));
        push("pivot", i, H, stop);
        lastBreakout = i;
        legs = 1;
      } else if (base) {
        // Above a rest that wasn't a setup: a new high, but no entry.
        base.status = "breakout";
        base.end_idx = i;
        base.end = d(i);
        lastBreakout = null;
        legs = 0;
      } else if (
        listed &&
        bases.length === 0 &&
        lastBreakout == null &&
        !entries.length &&
        i > R.ipoRangeMinPause &&
        i <= R.ipoRangeMaxDays &&
        (H / Math.min(...c.slice(0, i)) - 1) * 100 <= R.ipoRangePct
      ) {
        // Listing-range breakout: first close above the post-listing range; starts E1.
        push("ipo_range", i, H, Math.min(...c.slice(0, i)));
        lastBreakout = i;
        legs = 1;
      } else if (lastBreakout != null) {
        const depth = (1 - minSinceH / H) * 100;
        // Adds only on E1 and E2 (E1B, E2B); E3 is the leg to sell into.
        if (legs <= 2 && i - hIdx >= R.addMinDays && depth >= R.addMinDepthPct && depth <= R.addMaxDepthPct) {
          // Small base on top of a leg: E1B, E2B…
          push("add", i, H, minSinceH, `E${legs}B add`);
          legs++;
        }
      }
      H = p;
      hIdx = i;
      minSinceH = p;
      base = null;
      pause = null;
      tookLow = false;
      tookMid = false;
      tookTrend = false;
      tookBand = false;
      continue;
    }
    minSinceH = Math.min(minSinceH, p);
    // Band add: pullback into the 10/20-day averages after a breakout, then a bounce (before it becomes a base).
    if (lastBreakout != null && legs <= 2 && !base && !tookBand && i >= 20 && i - hIdx < R.baseMinDays) {
      let touchLow = Infinity;
      let broke = false;
      for (let k = Math.max(hIdx + 1, i - R.bandLookback); k < i; k++) {
        const hiBand = Math.max(ma10[k]!, ma20[k]!) * (1 + R.bandTolPct / 100);
        if (c[k]! <= hiBand) touchLow = Math.min(touchLow, c[k]!);
        if (c[k]! < ma20[k]! * (1 - R.bandBelowPct / 100)) broke = true;
      }
      if (Number.isFinite(touchLow) && !broke && p > c[i - 1]! && p > ma10[i]! && ma10[i]! > ma20[i]!) {
        // Stop under the pullback low and at least 3% under the 20-day (capped at 8% like every entry).
        push("band", i, p, Math.min(touchLow, minSinceH, ma20[i]! * (1 - R.bandBelowPct / 100)), `E${legs} band add`);
        tookBand = true;
      }
    }
    const depth = (1 - minSinceH / H) * 100;
    const ipoBase = listed && bases.length === 0;
    if (!base && i - hIdx >= (ipoBase ? R.ipoBaseMinDays : R.baseMinDays) && depth >= (ipoBase ? R.ipoBaseMinDepthPct : R.baseMinDepthPct)) {
      const lo = Math.min(...c.slice(Math.max(resetIdx, hIdx - R.priorRiseDays), hIdx + 1));
      const rise = lo > 0 ? (H / lo - 1) * 100 : 0;
      const valid = ipoBase || rise >= R.priorRisePct;
      if (valid) seq++;
      base = {
        n: valid ? seq : 0,
        start_idx: hIdx,
        start: d(hIdx),
        end_idx: null,
        end: null,
        high: r2(H),
        low: r2(minSinceH),
        depth_pct: r1(depth),
        days: i - hIdx,
        ipo_base: ipoBase,
        status: "open",
        valid,
        prior_rise_pct: ipoBase ? null : r1(rise),
        vol: null,
      };
      bases.push(base);
    }
    if (!base) continue;
    base.low = r2(minSinceH);
    base.depth_pct = r1(depth);
    base.days = i - hIdx;
    if (base.status === "open" && depth > (base.ipo_base ? R.maxDepthIpoPct : R.maxDepthPct)) {
      // Failed: close it and reset — the old high no longer matters.
      base.status = "failed";
      base.end_idx = i;
      base.end = d(i);
      if (base.valid) lastFail = { idx: i, depth: base.depth_pct, label: base.ipo_base ? "IPO base" : `Base ${base.n}` };
      H = p;
      hIdx = i;
      minSinceH = p;
      resetIdx = i;
      seq = 0;
      lastBreakout = null;
      legs = 0;
      base = null;
      pause = null;
      tookLow = false;
      tookMid = false;
      tookTrend = false;
      continue;
    }
    if (base.status !== "open" || !base.valid) continue;

    // Trendline break: first close above a falling line across the base's highs, still under the pivot.
    if (tookTrend && p < trendStop) tookTrend = false;
    if (!tookTrend && i - hIdx >= R.tlMinDays && p < H) {
      const tl = fallingLine(c, hIdx, i, R);
      if (tl && p > tl.at(i) && c[i - 1]! <= tl.at(i - 1) && !(entries.length && entries[entries.length - 1]!.idx > i - 5)) {
        // Stop under the recent lows (since the last touch, at least the last 10 sessions).
        push("trendline", i, tl.at(i), Math.min(...c.slice(Math.min(tl.touch, i - 10), i)));
        const e = entries[entries.length - 1]!;
        e.tl = { from_idx: hIdx, from_price: r2(H) };
        trendStop = e.stop;
        tookTrend = true;
      }
    }

    // A pause triggers when today's close clears its high.
    const enteredToday = entries.length > 0 && entries[entries.length - 1]!.idx === i;
    if (pause && p > pause.hi && !enteredToday) {
      if (pause.zone === "low" && !tookLow) {
        push("low_cheat", i, pause.hi, pause.lo);
        tookLow = true;
      } else if (pause.zone === "mid" && !tookMid && !(tookLow && entries[entries.length - 1]!.idx > i - 5)) {
        push("cheat", i, pause.hi, pause.lo);
        tookMid = true;
      }
      pause = null;
    }
    // Look for a tight pause in the closes before today.
    if (i >= R.pauseDays) {
      const w = c.slice(i - R.pauseDays + 1, i + 1);
      if (i - R.pauseDays + 1 > hIdx) {
        const hi = Math.max(...w);
        const lo = Math.min(...w);
        // Sideways, not a steady climb: start to end moves at most half the allowed range.
        const tight = (hi / lo - 1) * 100 <= R.pauseRangePct && Math.abs(w[w.length - 1]! / w[0]! - 1) * 100 <= R.pauseRangePct / 2;
        const a10 = avgVol(v, i + 1, 10);
        const a50 = avgVol(v, i + 1, 50);
        const quiet = !hasVol || (a10 != null && a50 != null && a10 < a50 * R.pauseVolX);
        if (tight && quiet) {
          const span = H - minSinceH;
          const pos = span > 0 ? (hi - minSinceH) / span : 1;
          if (pos <= 1 / 3) pause = { hi, lo, zone: "low" };
          else if (pos <= 2 / 3) pause = { hi, lo, zone: "mid" };
          else pause = null; // upper third: wait for the pivot breakout
        }
      }
    }
  }

  // Follow-through: the sessions after each entry — mostly green, on volume, holding above the buy level.
  for (const e of entries) {
    const end = Math.min(n - 1, e.idx + R.followDays);
    const days = end - e.idx;
    if (days <= 0) continue;
    let green = 0;
    for (let k = e.idx + 1; k <= end; k++) if (c[k]! > c[k - 1]!) green++;
    const a = avgVol(v, e.idx, 50, volFloor);
    let vs = 0;
    for (let k = e.idx + 1; k <= end; k++) vs += v[k]!;
    const volX = hasVol && a ? r2(vs / days / a) : null;
    const held = c[end]! >= e.level;
    const ok =
      days < R.followDays
        ? green + (R.followDays - days) >= R.followGreen && held
          ? null
          : false
        : green >= R.followGreen && held && (volX == null || volX >= R.followVolX);
    e.follow = { days, green, vol_x: volX, held, ok };
  }

  // Failed bases broke down: their "right side" is the breakdown, so no volume read.
  if (hasVol) for (const b of bases) if (b.status !== "failed") b.vol = baseVolume(c, v, b, n, R);

  // Sell signals while holding, per position (a new entry from a base restarts the count).
  const sells: Ipo2Sell[] = [];
  {
    // A position starts at the first entry of each base (cheat and pivot of one base = one position).
    const starts = new Set<number>();
    const seenBase = new Set<number>();
    for (const e of entries)
      if (e.kind !== "add" && e.kind !== "band" && !seenBase.has(e.base)) {
        seenBase.add(e.base);
        starts.add(e.idx);
      }
    const first = entries.length ? entries[0]!.idx : n;
    let count = 0;
    let armed = true;
    let climaxDone = false;
    let posStart = first;
    let ext1Price = 0;
    for (let i = first; i < n; i++) {
      if (i > first && starts.has(i)) {
        count = 0;
        armed = true;
        climaxDone = false;
        posStart = i;
      }
      if (i < R.extMaDays - 1) continue;
      let sum = 0;
      for (let k = i - R.extMaDays + 1; k <= i; k++) sum += c[k]!;
      const ma = sum / R.extMaDays;
      const ext = (c[i]! / ma - 1) * 100;
      if (!armed && ext < R.extResetPct) armed = true;
      const base10 = i >= R.climaxDays ? c[i - R.climaxDays]! : null;
      const run = base10 ? (c[i]! / base10 - 1) * 100 : null;
      let green = 0;
      if (base10) for (let k = i - R.climaxDays + 1; k <= i; k++) if (c[k]! > c[k - 1]!) green++;
      const volTop = !hasVol || v[i]! >= Math.max(...v.slice(posStart, i + 1));
      if (!climaxDone && i > posStart && run != null && run >= R.climaxRisePct && green >= R.climaxGreenDays && volTop) {
        sells.push({ kind: "climax", label: "Climax run", action: "Sell into strength", idx: i, date: d(i), price: r2(c[i]!), ext_pct: r1(ext), run_pct: r1(run) });
        climaxDone = true;
        armed = false;
        continue;
      }
      // 2nd extension: re-armed after cooling off, or a further 5%+ leg straight on (Jyoti CNC 535 → 625).
      const nextLeg = count === 1 && c[i]! >= ext1Price * (1 + R.extResetPct / 100);
      if ((armed || nextLeg) && count < 2 && i > posStart && ext >= R.extPct) {
        count++;
        sells.push({
          kind: count === 1 ? "ext1" : "ext2",
          label: count === 1 ? "1st daily extension" : "2nd daily extension",
          action: count === 1 ? "Sell" : "Sell again",
          idx: i,
          date: d(i),
          price: r2(c[i]!),
          ext_pct: r1(ext),
          run_pct: run == null ? null : r1(run),
        });
        if (count === 1) ext1Price = c[i]!;
        armed = false;
      }
    }
  }
  const lockouts = lockoutRallies(series);
  const lockout = currentLockout(series, lockouts);

  const lastSell = sells[sells.length - 1] ?? null;
  const sellNow = lastSell && n - 1 - lastSell.idx < R.sellFreshDays ? lastSell : null;

  // Current stage.
  const last = n - 1;
  const p = c[last]!;
  const openBase = base;
  const lastValid = [...bases].reverse().find((b) => b.valid) ?? null;
  const pivot = openBase?.valid ? openBase.high : lastValid && lastValid.status !== "failed" ? lastValid.high : null;
  const toPivot = pivot ? r1((pivot / p - 1) * 100) : null;
  const a10 = avgVol(v, n, 10);
  const a50 = avgVol(v, n, 50);
  const volDry = hasVol && a10 != null && a50 != null ? a10 < a50 * 0.7 : null;

  let live: Ipo2Entry | null = null;
  const lastEntry = entries[entries.length - 1];
  if (
    lastEntry &&
    lastEntry.risk_pct <= R.maxRiskPct &&
    last - lastEntry.idx <= R.freshDays &&
    p <= lastEntry.level * (1 + R.chaseMaxPct / 100) &&
    p > lastEntry.stop
  )
    live = lastEntry;

  let stage: Ipo2Stage;
  let note: string;
  const failedLast = lastFail != null && (lastBreakout == null || lastBreakout < lastFail.idx);
  if (listed && n < R.ipoBaseMinDays && !live) {
    stage = "new";
    note = `${n} trading days since listing`;
  } else if (live) {
    stage = "buy_zone";
    const b = [...bases].reverse().find((x) => x.valid && x.n === live!.base && x.start_idx <= live!.idx);
    note =
      live.kind === "add" || live.kind === "band"
        ? `${live.label} after the base ${live.base} breakout`
        : b
          ? `${b.ipo_base ? "IPO base" : `Base ${b.n}`} · ${b.depth_pct}% deep · ${Math.round(b.days / 5)} wks`
          : live.label;
  } else if (openBase && !openBase.valid) {
    stage = failedLast ? "broken" : "no_rise";
    note = failedLast
      ? `${lastFail!.label} failed ${dateShort(d(lastFail!.idx))} (${lastFail!.depth}% deep); resting ${Math.round(openBase.days / 5)} wks without a 25% rise`
      : `Resting ${Math.round(openBase.days / 5)} wks, ${openBase.depth_pct}% deep, after only a ${openBase.prior_rise_pct}% rise: not a setup`;
  } else if (!openBase && failedLast && p <= c[lastFail!.idx]! * (1 + R.priorRisePct / 100)) {
    stage = "broken";
    note = `${lastFail!.label} failed ${dateShort(d(lastFail!.idx))} (over ${lastFail!.depth}% deep): wait for a 25% rise and a new base`;
  } else if (openBase) {
    const near = toPivot != null && toPivot <= R.pivotNearPct;
    stage = near ? "near_pivot" : "in_base";
    note = `${openBase.ipo_base ? "IPO base" : `Base ${openBase.n}`} · ${openBase.depth_pct}% deep · ${Math.round(openBase.days / 5)} wks${
      near ? ` · ${toPivot}% under pivot ₹${fmt(openBase.high)}` : ""
    }`;
  } else if (last - hIdx > 0 && (1 - p / H) * 100 >= R.addMinDepthPct) {
    stage = "pullback";
    note = `${r1((1 - p / H) * 100)}% off the high, ${last - hIdx} days`;
  } else if (legs >= 3) {
    stage = "late";
    note = `E${legs}: late stage, sell into strength`;
  } else if (lastBreakout != null) {
    stage = "extended";
    note = `E${legs} · ${r1((p / c[lastBreakout]! - 1) * 100)}% above the breakout`;
  } else {
    stage = "running";
    note = failedLast ? "Recovering after a failed base: no new base yet" : listed ? "No base yet since listing" : "No base yet";
  }

  return {
    bars: n,
    first_close: r2(c[0]!),
    last_close: r2(p),
    last_date: d(last),
    run_pct: runPct == null ? null : r1(runPct),
    run_base: runPct == null ? null : issueAdj != null ? "issue" : "first_close",
    issue_price: issue,
    issue_mismatch: issueMismatch,
    listing_gain_pct: listingGain,
    urgency,
    green_weeks: greenWeeks,
    weeks_seen: weeksSeen,
    green_days: greenDays,
    days_seen: daysSeen,
    listed,
    corp_actions: actions,
    bases,
    entries,
    sells,
    sell_now: sellNow,
    lockouts,
    lockout,
    legs,
    stage,
    stage_note: note,
    live_entry: live,
    pivot,
    to_pivot_pct: toPivot,
    vol_dry: volDry,
    verdict: withSell(makeVerdict({
      stage,
      note,
      live,
      openBase,
      pivot,
      toPivot,
      volDry,
      legs,
      listed,
      urgency,
      greenWeeks,
      weeksSeen,
      greenDays,
      daysSeen,
      lastBreakoutPct: lastBreakout != null ? r1((p / c[lastBreakout]! - 1) * 100) : null,
      lastFail,
      bases,
      lockout,
      R,
    }), sellNow, stage),
  };
}

/**
 * Falling line from the base high through the highest later peak (the flattest line resting
 * on the highs), when every close since the high stays under it.
 */
function fallingLine(
  c: number[],
  s: number,
  i: number,
  R: typeof IPO2_RULES,
): { at: (j: number) => number; touch: number } | null {
  let best: { m: number; k: number } | null = null;
  for (let k = s + R.tlMinGap; k <= i - 3; k++) {
    const pk = c[k]!;
    if (!(pk >= c[k - 1]! && pk >= c[k - 2]! && pk >= c[k + 1]! && pk >= c[k + 2]!)) continue;
    if (pk >= c[s]!) continue;
    const m = (pk - c[s]!) / (k - s);
    if (!best || m > best.m) best = { m, k };
  }
  if (!best) return null;
  const { m, k } = best;
  const at = (j: number) => c[s]! + m * (j - s);
  for (let j = s + 1; j < i; j++) if (c[j]! > at(j) * (1 + R.tlTolPct / 100)) return null;
  // At least two peaks on the line after the high: a real trendline, not one stray point.
  let touches = 0;
  for (let q = s + 3; q <= i - 3; q++) {
    const pk = c[q]!;
    if (pk >= c[q - 1]! && pk >= c[q - 2]! && pk >= c[q + 1]! && pk >= c[q + 2]! && pk >= at(q) * (1 - R.tlTouchPct / 100)) touches++;
  }
  if (touches < R.tlTouches) return null;
  return { at, touch: k };
}

/**
 * Left / right side volume of a base (IPO V2.0 base drawing): heavy selling on the way
 * down, quiet at the bottom, volume coming back as it climbs the right side.
 */
function baseVolume(c: number[], v: number[], b: Ipo2Base, n: number, R: typeof IPO2_RULES): BaseVolume | null {
  // Base sessions: after the high up to the breakout / failure day (excluded) or today.
  const from = b.start_idx + 1;
  const to = b.end_idx ?? n; // exclusive
  if (to - from < 6) return null;
  let lowIdx = from;
  for (let i = from; i < to; i++) if (c[i]! < c[lowIdx]!) lowIdx = i;
  const avg = (a: number, z: number, keep?: (i: number) => boolean) => {
    let s = 0;
    let k = 0;
    for (let i = Math.max(a, 0); i < Math.min(z, n); i++)
      if (v[i]! > 0 && (!keep || keep(i))) {
        s += v[i]!;
        k++;
      }
    return k ? s / k : null;
  };
  const all = avg(from, to);
  const left = avg(from, lowIdx + 1);
  // Bottom: the quietest week within ±bottomDays·2 sessions of the low (a shakeout spike on the low day is fine).
  let bottom: number | null = null;
  for (let a = Math.max(from, lowIdx - 2 * R.bottomDays); a + R.bottomDays <= Math.min(to, lowIdx + 2 * R.bottomDays + 1); a++) {
    const w = avg(a, a + R.bottomDays);
    if (w != null && (bottom == null || w < bottom)) bottom = w;
  }
  if (!all || left == null || bottom == null) return null;
  const rightDays = to - lowIdx - 1;
  const right = rightDays >= 1 ? avg(lowIdx + 1, to) : null;
  const up = rightDays >= 1 ? avg(lowIdx + 1, to, (i) => c[i]! > c[i - 1]!) : null;
  const dn = rightDays >= 1 ? avg(lowIdx + 1, to, (i) => c[i]! < c[i - 1]!) : null;
  const updown = up != null && dn ? r2(up / dn) : null;
  const judged = rightDays >= R.rightMinDays && right != null;
  return {
    low_idx: lowIdx,
    left_x: r2(left / all),
    bottom_x: r2(bottom / all),
    right_x: right == null ? 0 : r2(right / all),
    right_updown: updown,
    cooled: bottom <= left * R.volCoolX,
    // Buying on the right: up days outweigh down days, and either volume is back above the bottom or up days clearly lead.
    // No down days at all on the right counts as buying.
    returning: !judged
      ? null
      : updown == null
        ? up != null && right! > bottom
        : updown > 1 && (right! > bottom || updown >= R.rightUpDownX),
  };
}

/** One line on a base's volume shape for the verdict. */
function baseVolReason(b: Ipo2Base): { good: boolean; text: string } | null {
  const q = b.vol;
  if (!q) return null;
  const x = (k: number) => `${k}×`;
  const ud = q.right_updown != null ? `, up days ${x(q.right_updown)} down days` : "";
  if (q.cooled && q.returning)
    return {
      good: true,
      text: `Base volume: heavy on the left (${x(q.left_x)}), dried up at the bottom (${x(q.bottom_x)}), returning on the right (${x(q.right_x)}${ud})`,
    };
  if (!q.cooled) return { good: false, text: `Base volume didn't dry up at the bottom (${x(q.bottom_x)} vs ${x(q.left_x)} on the left side)` };
  if (q.returning === false)
    return { good: false, text: `Volume dried up at the bottom (${x(q.bottom_x)}) but isn't coming back on the right side (${x(q.right_x)}${ud})` };
  return { good: true, text: `Volume dried up at the bottom (${x(q.bottom_x)} vs ${x(q.left_x)} on the left); right side still early` };
}

/** A fresh sell signal leads the verdict for holders (buyers' advice stays after it). */
function withSell(v: Verdict, sell: Ipo2Sell | null, stage: Ipo2Stage): Verdict {
  if (!sell) return v;
  const why =
    sell.kind === "climax"
      ? `Climax run ${shortIso(sell.date)}: +${sell.run_pct}% in 10 sessions, mostly green days`
      : `${sell.label} ${shortIso(sell.date)}: close ${sell.ext_pct}% above its 10-day average`;
  const holders = `Holders: ${sell.action.toLowerCase()} (${sell.label.toLowerCase()})`;
  return {
    ...v,
    action: stage === "buy_zone" ? v.action : `${holders}. ${v.action}`,
    reasons: [{ good: false, text: why }, ...v.reasons],
  };
}

function shortIso(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

function makeVerdict(x: {
  stage: Ipo2Stage;
  note: string;
  live: Ipo2Entry | null;
  openBase: Ipo2Base | null;
  pivot: number | null;
  toPivot: number | null;
  volDry: boolean | null;
  legs: number;
  listed: boolean;
  urgency: boolean | null;
  greenWeeks: number | null;
  weeksSeen: number;
  greenDays: number | null;
  daysSeen: number;
  lastBreakoutPct: number | null;
  lastFail: { idx: number; depth: number; label: string } | null;
  bases: Ipo2Base[];
  lockout: Lockout | null;
  R: typeof IPO2_RULES;
}): Verdict {
  const { R } = x;
  const reasons: Verdict["reasons"] = [];
  const baseOf = (b: Ipo2Base | null | undefined) => {
    if (!b || !b.valid) return;
    const [lo, hi] = R.idealDepth;
    const max = b.ipo_base ? R.maxDepthIpoPct : R.maxDepthPct;
    if (b.depth_pct >= lo && b.depth_pct <= hi) reasons.push({ good: true, text: `Base ${b.depth_pct}% deep: in the ideal ${lo}–${hi}%` });
    else if (b.depth_pct < lo) reasons.push({ good: true, text: `Shallow base, ${b.depth_pct}% deep (tight is fine)` });
    else reasons.push({ good: false, text: `Base ${b.depth_pct}% deep: deeper than the ideal ${hi}% (max ${max}%)` });
    const wks = Math.round(b.days / 5);
    if (wks > 65) reasons.push({ good: false, text: `Long base: ${wks} weeks` });
    if (b.prior_rise_pct != null) reasons.push({ good: true, text: `${b.prior_rise_pct}% rise into the base` });
    const vr = baseVolReason(b);
    if (vr) reasons.push(vr);
  };
  const ipoReason = () => {
    if (!x.listed || x.urgency == null) return;
    const wk = `${x.greenWeeks ?? 0}/${x.weeksSeen} green weeks`;
    const dy = `${x.greenDays ?? 0}/${x.daysSeen} green days`;
    reasons.push(
      x.urgency
        ? { good: true, text: `Urgency after listing: ${wk}, ${dy}` }
        : {
            good: false,
            text: `No urgency after listing: ${wk}, ${dy} (needs ${R.urgencyGreenWeeks}/${R.urgencyWeeks} weeks or ${R.urgencyGreenDays}/${R.urgencyDays} days)`,
          },
    );
  };
  const volReason = () => {
    if (x.volDry === true) reasons.push({ good: true, text: "Volume drying up in the base" });
  };
  const inr = (n: number) => `₹${fmt(n)}`;
  if (x.lockout)
    reasons.push({
      good: true,
      text: `Lockout rally: ${x.lockout.green}/8 green weeks since ${shortIso(x.lockout.start)}, +${x.lockout.gain_pct}% from ${inr(
        x.lockout.from_price,
      )}, out of a ${x.lockout.base_weeks}-week base, bars ${x.lockout.expansion_x}× the base's weekly moves (end of stage 1 / start of stage 2)`,
    });

  switch (x.stage) {
    case "buy_zone": {
      const e = x.live!;
      const b = [...x.bases].reverse().find((bb) => bb.valid && bb.n === e.base && bb.start_idx <= e.idx);
      if (e.kind === "pivot" || e.kind === "add") {
        if (e.vol_x != null)
          reasons.push(
            e.vol_x >= R.breakoutVolX
              ? { good: true, text: `Breakout on ${e.vol_x}× average volume: confirmed` }
              : { good: false, text: `Breakout on only ${e.vol_x}× average volume (want ${R.breakoutVolX}×): unconfirmed, buy smaller` },
          );
      } else if (e.kind === "band")
        reasons.push({ good: true, text: "Band add: pulled back into the 10/20-day averages after the breakout and bounced, the uptrend intact" });
      else if (e.kind === "trendline")
        reasons.push({ good: true, text: "Trendline break: first close above the falling line across the base highs, before the pivot" });
      else if (e.kind === "ipo_range")
        reasons.push({ good: true, text: "Listing-range breakout: first close above the range held since listing, stop under the post-listing low" });
      else reasons.push({ good: true, text: `${e.label}: early entry inside the base, tight stop` });
      const f = e.follow;
      if (!f) reasons.push({ good: true, text: `Follow-through: watch the next ${R.followDays} sessions (want ${R.followGreen}+ green, holding above ${inr(e.level)}, on volume)` });
      else {
        const vol = f.vol_x != null ? `, volume ${f.vol_x}× average` : "";
        const what = `${f.green}/${f.days} green days${vol}${f.held ? "" : `, back under ${inr(e.level)}`}`;
        reasons.push(
          f.ok === true
            ? { good: true, text: `Follow-through: ${what}. Buying is coming in` }
            : f.ok === false
              ? { good: false, text: `Weak follow-through: ${what}. Buy smaller or wait` }
              : { good: true, text: `Follow-through so far: ${what} (${R.followDays - f.days} more session${R.followDays - f.days === 1 ? "" : "s"} to judge)` },
        );
      }
      if (e.kind !== "add" && e.kind !== "band") baseOf(b);
      ipoReason();
      return { call: "buy", action: `Buy above ${inr(e.level)}, stop ${inr(e.stop)} (risk ${e.risk_pct}%)`, reasons };
    }
    case "near_pivot": {
      baseOf(x.openBase);
      volReason();
      ipoReason();
      const stop = x.pivot! * (1 - R.maxStopPct / 100);
      return {
        call: "watch",
        action: `Watch: buy on a close above the pivot ${inr(x.pivot!)} (${x.toPivot}% away) on strong volume, stop about ${inr(stop)}`,
        reasons,
      };
    }
    case "in_base": {
      baseOf(x.openBase);
      volReason();
      ipoReason();
      return {
        call: "wait",
        action: `Wait: base still forming, ${x.toPivot}% under the pivot ${inr(x.pivot!)}. Watch for a tight pause (cheat) or the breakout`,
        reasons,
      };
    }
    case "pullback":
      ipoReason();
      return { call: "wait", action: `Wait: ${x.note}. No base yet (needs ${R.baseMinDays / 5}+ weeks)`, reasons };
    case "running":
      ipoReason();
      return { call: "wait", action: "Wait: no base to buy from. The next entry comes from the next base", reasons };
    case "extended":
      reasons.push({ good: false, text: `${x.lastBreakoutPct}% above the breakout: chasing raises the risk` });
      ipoReason();
      return { call: "wait", action: "Don't chase: wait for a small pause (E1B / E2B) or a new base", reasons };
    case "late":
      reasons.push({ good: false, text: `Leg E${x.legs} after the breakout: the late, stretched part of the run` });
      return { call: "avoid", action: "Avoid new buys: late stage. Holders sell into strength", reasons };
    case "broken":
      if (x.lastFail) reasons.push({ good: false, text: `${x.lastFail.label} failed (over ${x.lastFail.depth}% deep)` });
      return { call: "avoid", action: `Avoid: the base broke. Wait for a ${R.priorRisePct}% recovery and a new base`, reasons };
    case "no_rise":
      reasons.push({ good: false, text: `Resting without a ${R.priorRisePct}% rise into it: not a setup` });
      return { call: "avoid", action: "Avoid for now: no uptrend into this base", reasons };
    case "new":
      return { call: "wait", action: "Wait: too new. The first entry comes from the IPO base", reasons };
  }
}

function dateShort(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });
}

function fmt(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: n >= 100 ? 0 : 2 });
}


/* ------------------------------------------------------------------ */
/* Listing dates                                                       */
/* ------------------------------------------------------------------ */

const MON: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/** "06-OCT-2008" or "16-Nov-26" → "2008-10-06". */
export function parseNseListingDate(raw: string | null | undefined): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec((raw ?? "").trim());
  if (!m) return null;
  const mm = MON[m[2]!.toUpperCase()];
  if (!mm) return null;
  const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${mm}-${m[1]!.padStart(2, "0")}`;
}

const LIST_TTL_MS = 24 * 3_600_000;

function withStrategyDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS ipo_listing_dates (
      ticker TEXT PRIMARY KEY,
      board TEXT NOT NULL,
      listing_date TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )`);
    return fn(db);
  } finally {
    db.close();
  }
}

let listingMem: { at: number; map: Map<string, string> } | null = null;
let listingFetch: Promise<void> | null = null;

function readSavedListingDates(): { at: number; map: Map<string, string> } {
  return withStrategyDb((db) => {
    const rows = db.prepare(`SELECT ticker, listing_date, fetched_at FROM ipo_listing_dates`).all() as Array<{
      ticker: string;
      listing_date: string;
      fetched_at: number;
    }>;
    return {
      at: rows.reduce((a, r) => Math.max(a, r.fetched_at), 0),
      map: new Map(rows.map((r) => [r.ticker, r.listing_date])),
    };
  });
}

/** Refresh NSE main + SME listing dates (once a day, in the background). */
async function refreshListingDates(): Promise<void> {
  const [main, sme] = await Promise.all([
    fetchNseMainEquityList().catch(() => []),
    fetchNseSmeEquityList().catch(() => []),
  ]);
  if (main.length < 500 && sme.length < 100) return; // NSE refused: keep what's saved
  const at = Date.now();
  const rows: Array<[string, string, string]> = [];
  for (const [board, list] of [["NSE", main], ["NSE SME", sme]] as const)
    for (const r of list) {
      if (isNseRightsEntitlement(r)) continue;
      const iso = parseNseListingDate(r.listing_date);
      if (iso) rows.push([r.ticker.toUpperCase(), board, iso]);
    }
  withStrategyDb((db) => {
    const ins = db.prepare(
      `INSERT INTO ipo_listing_dates (ticker, board, listing_date, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET board = excluded.board, listing_date = excluded.listing_date, fetched_at = excluded.fetched_at`,
    );
    db.transaction(() => {
      for (const [t, b, dt] of rows) ins.run(t, b, dt, at);
    })();
  });
  listingMem = readSavedListingDates();
}

/** NSE listing dates (ticker → ISO). Stale or missing: returns what's saved and refreshes. */
export async function nseListingDates(opts?: { wait?: boolean }): Promise<{ map: Map<string, string>; at: number }> {
  if (!listingMem) {
    try {
      listingMem = readSavedListingDates();
    } catch {
      listingMem = { at: 0, map: new Map() };
    }
  }
  if (Date.now() - listingMem.at > LIST_TTL_MS && !listingFetch) {
    listingFetch = refreshListingDates()
      .catch(() => {})
      .finally(() => {
        listingFetch = null;
      });
  }
  if ((opts?.wait || listingMem.map.size === 0) && listingFetch) await listingFetch;
  return listingMem;
}

/* ------------------------------------------------------------------ */
/* Issue prices (NSE past issues: main board + SME)                    */
/* ------------------------------------------------------------------ */

const NSE_PAST_ISSUES = "https://www.nseindia.com/api/public-past-issues";

type IssueRec = { price: number; listing: string };
let issueMem: { at: number; map: Map<string, IssueRec> } | null = null;
let issueFetch: Promise<void> | null = null;

function withIssueDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  return withStrategyDb((db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS ipo_issue_prices (
      symbol TEXT PRIMARY KEY,
      issue_price REAL NOT NULL,
      listing_date TEXT NOT NULL,
      board TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )`);
    return fn(db);
  });
}

function readSavedIssues(): { at: number; map: Map<string, IssueRec> } {
  return withIssueDb((db) => {
    const rows = db.prepare(`SELECT symbol, issue_price, listing_date, fetched_at FROM ipo_issue_prices`).all() as Array<{
      symbol: string;
      issue_price: number;
      listing_date: string;
      fetched_at: number;
    }>;
    return {
      at: rows.reduce((a, r) => Math.max(a, r.fetched_at), 0),
      map: new Map(rows.map((r) => [r.symbol, { price: r.issue_price, listing: r.listing_date }])),
    };
  });
}

/** NSE's past-issues list → issue price + listing date per symbol (equity and SME only). */
async function refreshIssuePrices(): Promise<void> {
  const res = await fetch(NSE_PAST_ISSUES, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json",
      Referer: "https://www.nseindia.com/",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) return;
  const list = (await res.json()) as Array<{
    symbol?: string;
    issuePrice?: string | null;
    listingDate?: string | null;
    securityType?: string;
  }>;
  if (!Array.isArray(list) || list.length < 200) return; // refused / truncated: keep what's saved
  const at = Date.now();
  const rows: Array<[string, number, string, string]> = [];
  for (const x of list) {
    if (x.securityType !== "Equity" && x.securityType !== "SME") continue;
    const sym = (x.symbol ?? "").trim().toUpperCase();
    const price = Number((x.issuePrice ?? "").trim());
    const listing = parseNseListingDate(x.listingDate);
    if (sym && listing && Number.isFinite(price) && price > 0) rows.push([sym, price, listing, x.securityType]);
  }
  withIssueDb((db) => {
    const ins = db.prepare(
      `INSERT INTO ipo_issue_prices (symbol, issue_price, listing_date, board, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET issue_price = excluded.issue_price, listing_date = excluded.listing_date,
         board = excluded.board, fetched_at = excluded.fetched_at`,
    );
    db.transaction(() => {
      for (const [sym, pr, dt, b] of rows) ins.run(sym, pr, dt, b, at);
    })();
  });
  issueMem = readSavedIssues();
}

/** Issue prices by NSE symbol. Stale or missing: returns what's saved and refreshes once a day. */
export async function nseIssuePrices(opts?: { wait?: boolean }): Promise<Map<string, IssueRec>> {
  if (!issueMem) {
    try {
      issueMem = readSavedIssues();
    } catch {
      issueMem = { at: 0, map: new Map() };
    }
  }
  if (Date.now() - issueMem.at > LIST_TTL_MS && !issueFetch) {
    issueFetch = refreshIssuePrices()
      .catch(() => {})
      .finally(() => {
        issueFetch = null;
      });
  }
  if ((opts?.wait || issueMem.map.size === 0) && issueFetch) await issueFetch;
  return issueMem.map;
}

/** The issue price for this listing — only when NSE's record lists within 10 days of our listing date. */
function issuePriceFor(issues: Map<string, IssueRec>, ticker: string, listing: string): number | null {
  const rec = issues.get(ticker.toUpperCase());
  if (!rec) return null;
  return Math.abs(daysBetween(rec.listing, listing)) <= 10 ? rec.price : null;
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

/** Non-cyclical sectors and current themes from the IPO V2.0 checklist. */
const FAVOURED =
  /\b(IT\b|software|computer|internet|infotech|e[ -]?commerce|e[ -]?services|new age platform|data centre|fmcg|personal care|food|dairy|snacks|consumer electronics|domestic appliances|retail|pharma|biotech|hospital|diagnostic|medical|healthcare|ayurved|renewable|solar|wind|non conventional|green)/i;

/** Industry decides; the broad sector only when there's no industry ("Trading" under Pharma isn't pharma). */
export function favouredSector(industry: string | null | undefined, sector?: string | null): boolean {
  const ind = (industry ?? "").trim();
  return FAVOURED.test(ind || (sector ?? ""));
}

type Growth = { sales_yoy: number | null; np_yoy: number | null; quarter: string | null; stale: boolean };

/** Latest quarter vs the same quarter a year earlier (Screener quarters). */
function quarterGrowth(): Map<string, Growth> {
  const out = new Map<string, Growth>();
  const cut = new Date();
  cut.setUTCMonth(cut.getUTCMonth() - IPO2_RULES.growthMaxAgeMonths);
  const recentQ = cut.toISOString().slice(0, 7);
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    for (const r of db.prepare(`SELECT UPPER(ticker) AS t, quarters_json AS j FROM screener_quarters_cache`).all() as Array<{
      t: string;
      j: string;
    }>) {
      try {
        const qs = (JSON.parse(r.j) as Array<{ date: string; revenue: number | null; netIncome: number | null }>)
          .filter((q) => q.date)
          .sort((a, b) => a.date.localeCompare(b.date));
        const q = qs[qs.length - 1];
        if (!q) continue;
        const mi = (s: string) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7));
        const prev = qs.find((x) => Math.abs(mi(q.date) - mi(x.date) - 12) <= 1);
        const yoy = (a: number | null | undefined, b: number | null | undefined) =>
          a != null && b != null && b > 0 && a / b < 100 && a / b > 0.01 ? r1((a / b - 1) * 100) : null;
        const quarter = q.date.slice(0, 7);
        if (quarter < recentQ) {
          // Too old to say anything about growth now.
          out.set(r.t, { sales_yoy: null, np_yoy: null, quarter, stale: true });
          continue;
        }
        out.set(r.t, { sales_yoy: yoy(q.revenue, prev?.revenue), np_yoy: yoy(q.netIncome, prev?.netIncome), quarter, stale: false });
      } catch {
        /* bad row */
      }
    }
  } finally {
    db.close();
  }
  return out;
}

export type Ipo2Row = {
  ticker: string;
  name: string;
  market: string;
  industry: string | null;
  sector: string | null;
  website: string | null;
  mcap_cr: number | null;
  listing_date: string;
  /** nse = official NSE list; history = first day in the saved prices (BSE / no NSE date). */
  listing_source: "nse" | "history";
  /** Saved prices start more than 10 days after listing: urgency and IPO base not checked. */
  history_gap: boolean;
  age_months: number;
  first_close: number;
  price: number;
  ret_pct: number;
  run_pct: number | null;
  run_base: "issue" | "first_close" | null;
  issue_price: number | null;
  issue_mismatch: boolean;
  listing_gain_pct: number | null;
  urgency: boolean | null;
  green_weeks: number | null;
  weeks_seen: number;
  green_days: number | null;
  days_seen: number;
  growth: Growth | null;
  growth_ok: boolean | null;
  favoured: boolean;
  bases: number;
  base_depth_pct: number | null;
  /** Latest base's left / right side volume (shown, not scored). */
  base_vol: BaseVolume | null;
  stage: Ipo2Stage;
  stage_note: string;
  live_entry: Ipo2Entry | null;
  last_entry: Ipo2Entry | null;
  /** Sell signal in the last few sessions (1st / 2nd extension, climax). */
  sell_now: Ipo2Sell | null;
  /** Lockout rally running now (6/8 green weeks at the end of stage 1 / start of stage 2). */
  lockout: Lockout | null;
  pivot: number | null;
  to_pivot_pct: number | null;
  vol_dry: boolean | null;
  legs: number;
  /** One-day jumps treated as splits / bonuses (earlier prices adjusted). */
  corp_actions: CorpAction[];
  /** Checklist passes out of the checks we can run (urgency, growth, depth). Sector is shown, not scored for now. */
  score: number;
  last_date: string;
};

export type Ipo2Result = {
  rows: Ipo2Row[];
  universe: number;
  /** Skipped: older companies (old BSE code, or an NSE batch-listing day without a new BSE code). */
  skipped_old: number;
  no_prices: number;
  listing_dates: number;
  listing_dates_at: string | null;
  /** Rows whose first run is measured from the IPO issue price (else the listing-day close). */
  with_issue_price: number;
  /** Stocks whose prices are older than the latest trading day, now refreshing in the background. */
  stale_prices: number;
  refreshing: number;
  rules: typeof IPO2_RULES;
  built_at: string;
};

let screenCache: { at: number; result: Ipo2Result } | null = null;
let refreshHooked = false;
const SCREEN_TTL_MS = 10 * 60_000;

export function clearIpo2Cache(): void {
  screenCache = null;
}

/** Saved BSE scrip codes (ticker → numeric code). */
function bseCodes(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
    try {
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, scrip_code AS c FROM company_bse_scrip`).all() as Array<{
        t: string;
        c: string | null;
      }>) {
        const n = Number((r.c ?? "").trim());
        if (Number.isFinite(n) && n > 0) out.set(r.t, n);
      }
    } finally {
      db.close();
    }
  } catch {
    /* no codes saved */
  }
  return out;
}

/** Older company, not an IPO: old BSE code, or listed on an NSE batch day without a new BSE code. */
function olderCompany(t: string, nseDate: string | null, codes: Map<string, number>, bulkDays: Set<string>): boolean {
  const code = codes.get(t);
  if (code != null && code < IPO2_RULES.newBseCodeMin) return true;
  return nseDate != null && bulkDays.has(nseDate) && code == null;
}

/** NSE dates shared by many listings: batches of older BSE companies admitted to NSE. */
function bulkListingDays(nse: Map<string, string>): Set<string> {
  const dayCount = new Map<string, number>();
  for (const dt of nse.values()) dayCount.set(dt, (dayCount.get(dt) ?? 0) + 1);
  return new Set([...dayCount].filter(([, k]) => k >= IPO2_RULES.bulkListingDay).map(([dt]) => dt));
}

let bulkStartMemo: { at: number; set: Set<string> } | null = null;
/** First-trade dates (inside the saved window) shared by many stocks: data gaps, not listings. */
function bulkFirstTradeDays(years: number): Set<string> {
  if (bulkStartMemo && Date.now() - bulkStartMemo.at < SCREEN_TTL_MS) return bulkStartMemo.set;
  const windowStart = new Date(Date.now() - years * 365.25 * 86_400_000).toISOString().slice(0, 10);
  const count = new Map<string, number>();
  for (const co of loadAllCompanies()) {
    const s = cachedRotationCloses(co.ticker, (co.market || "NSE").trim(), years);
    const f = s[0]?.date;
    if (f && daysBetween(windowStart, f) > 30) count.set(f, (count.get(f) ?? 0) + 1);
  }
  const set = new Set([...count].filter(([, k]) => k >= IPO2_RULES.bulkFirstTrade).map(([dt]) => dt));
  bulkStartMemo = { at: Date.now(), set };
  return set;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** One stock's series since listing (saved prices only) and its listing date. */
function seriesSinceListing(
  ticker: string,
  market: string,
  nseDate: string | null,
  years: number,
  cutoff: string,
  bulkStarts: Set<string>,
): { series: Close[]; listing: string; source: "nse" | "history"; gap: boolean } | null {
  const all = cachedRotationCloses(ticker, market, years);
  if (all.length < 2) return null;
  const first = all[0]!.date;
  // Many stocks' saved prices starting the same day: a data gap (resumed trading), not a listing.
  const firstIsGap = bulkStarts.has(first);
  // History that reaches back to the start of the saved window: listed before it.
  const windowStart = new Date(Date.now() - years * 365.25 * 86_400_000).toISOString().slice(0, 10);
  const historyIsListing = daysBetween(windowStart, first) > 30;
  let listing: string;
  let source: "nse" | "history";
  if (nseDate && historyIsListing && !firstIsGap && daysBetween(first, nseDate) > 10) {
    // Traded before the NSE date (BSE / SME first, migrated later): count from the first trade.
    listing = first;
    source = "history";
  } else if (nseDate) {
    listing = nseDate;
    source = "nse";
  } else if (historyIsListing && !firstIsGap && !market.toUpperCase().startsWith("NSE")) {
    // BSE / BSE SME: no official date here, so the first trade. NSE stocks need NSE's date.
    listing = first;
    source = "history";
  } else return null;
  if (listing < cutoff) return null;
  const series = all.filter((b) => b.date >= listing);
  if (series.length < 2) return null;
  return { series, listing, source, gap: daysBetween(listing, series[0]!.date) > 10 };
}

export async function buildIpo2Screen(opts?: { refresh?: boolean }): Promise<Ipo2Result> {
  if (!opts?.refresh && screenCache && Date.now() - screenCache.at < SCREEN_TTL_MS) return screenCache.result;
  const R = IPO2_RULES;
  const [{ map: nse, at: nseAt }, issues] = await Promise.all([
    nseListingDates({ wait: opts?.refresh }),
    nseIssuePrices({ wait: opts?.refresh }),
  ]);
  const years = rotationFetchYears();
  const cutoff = new Date(Date.now() - R.maxAgeYears * 365.25 * 86_400_000).toISOString().slice(0, 10);
  const labels = masterLabels();
  const metrics = loadMetricsMap();
  const growth = quarterGrowth();
  const today = new Date().toISOString().slice(0, 10);

  const codes = bseCodes();
  const bulkDays = bulkListingDays(nse);
  const bulkStarts = bulkFirstTradeDays(years);
  const rows: Ipo2Row[] = [];
  let universe = 0;
  let noPrices = 0;
  let skippedOld = 0;
  const seen = new Set<string>();
  for (const co of loadAllCompanies()) {
    const t = co.ticker.toUpperCase();
    if (seen.has(t) || /^\d+$/.test(t) || isRightsOrPartlyPaid(co.ticker, co.name)) continue;
    seen.add(t);
    const market = (co.market || "NSE").trim();
    const nseDate = nse.get(t) ?? null;
    if (nseDate && nseDate < cutoff) continue; // official date says older
    const s = seriesSinceListing(co.ticker, market, nseDate, years, cutoff, bulkStarts);
    if (s && olderCompany(t, s.source === "nse" ? nseDate : null, codes, bulkDays)) {
      skippedOld++;
      continue;
    }
    if (!s) {
      if (nseDate) {
        universe++;
        noPrices++;
      }
      continue;
    }
    universe++;
    const a = analyzeBases(s.series, { listed: true, issuePrice: issuePriceFor(issues, t, s.listing) });
    if (!a) continue;
    const lab = labels.get(t);
    const g = growth.get(t) ?? null;
    const growthOk =
      g && g.sales_yoy != null && g.np_yoy != null ? g.sales_yoy >= R.growthPct && g.np_yoy >= R.growthPct : null;
    const urgency = s.gap ? null : a.urgency;
    const favoured = favouredSector(lab?.industry ?? co.sub_sector, lab?.sector ?? co.sector);
    const cur = a.bases[a.bases.length - 1] ?? null;
    const depthOk =
      cur && cur.status !== "failed" ? cur.depth_pct <= (cur.ipo_base ? R.maxDepthIpoPct : R.maxDepthPct) : null;
    const score = [urgency, growthOk, depthOk].filter((x) => x === true).length;
    rows.push({
      ticker: t,
      name: co.name,
      market,
      industry: lab?.industry ?? co.sub_sector ?? null,
      sector: lab?.sector ?? co.sector ?? null,
      website: co.website ?? null,
      mcap_cr: metrics.get(t)?.market_cap_cr ?? null,
      listing_date: s.listing,
      listing_source: s.source,
      history_gap: s.gap,
      age_months: Math.max(0, Math.round(daysBetween(s.listing, today) / 30.44)),
      first_close: a.first_close,
      price: a.last_close,
      ret_pct: r1((a.last_close / a.first_close - 1) * 100),
      run_pct: s.gap ? null : a.run_pct,
      run_base: s.gap ? null : a.run_base,
      issue_price: a.issue_price,
      issue_mismatch: a.issue_mismatch,
      listing_gain_pct: a.listing_gain_pct,
      urgency,
      green_weeks: s.gap ? null : a.green_weeks,
      weeks_seen: s.gap ? 0 : a.weeks_seen,
      green_days: s.gap ? null : a.green_days,
      days_seen: s.gap ? 0 : a.days_seen,
      growth: g,
      growth_ok: growthOk,
      favoured,
      bases: a.bases.length,
      base_depth_pct: cur ? cur.depth_pct : null,
      base_vol: cur?.vol ?? null,
      stage: a.stage,
      stage_note: a.stage_note,
      live_entry: a.live_entry,
      last_entry: a.entries[a.entries.length - 1] ?? null,
      sell_now: a.sell_now,
      lockout: a.lockout,
      pivot: a.pivot,
      to_pivot_pct: a.to_pivot_pct,
      vol_dry: a.vol_dry,
      legs: a.legs,
      corp_actions: a.corp_actions,
      score,
      last_date: a.last_date,
    });
  }
  // Prices older than the latest trading day: refresh in the background (queued, 6 at a time);
  // the screen rebuilds once the queue drains.
  const latest = rows.reduce((m, r) => (r.last_date > m ? r.last_date : m), "");
  const stale = rows.filter((r) => r.last_date < latest);
  if (!refreshHooked) {
    refreshHooked = true;
    onRotationBarsRefreshed(() => clearIpo2Cache());
  }
  for (const r of stale) void rotationCloses(r.ticker, r.market, years).catch(() => {});
  const result: Ipo2Result = {
    stale_prices: stale.length,
    refreshing: rotationBarsRefreshing(),
    rows,
    universe,
    skipped_old: skippedOld,
    no_prices: noPrices,
    listing_dates: nse.size,
    with_issue_price: rows.filter((r) => r.run_base === "issue").length,
    listing_dates_at: nseAt ? new Date(nseAt).toISOString() : null,
    rules: R,
    built_at: new Date().toISOString(),
  };
  screenCache = { at: Date.now(), result };
  return result;
}

export type BasesDetail =
  | {
      ok: true;
      ticker: string;
      /** ipo = listed in the last 4 years (series from listing); established = any older stock. */
      mode: "ipo" | "established";
      listing_date: string | null;
      listing_source: "nse" | "history" | null;
      series: Close[];
      analysis: Ipo2Analysis;
    }
  | { ok: false; error: string };

/**
 * One stock's bases and entries, for a chart (IPO2 row or Napkin).
 * Listed in the last 4 years (and not an older company newly on NSE): IPO rules
 * from the listing day. Otherwise: the normal base rules on the saved ~6 years.
 * Fetches prices once when none are saved.
 */
export async function stockBasesDetail(ticker: string, marketHint?: string | null): Promise<BasesDetail> {
  const t = ticker.trim().toUpperCase();
  if (!t) return { ok: false, error: "No ticker" };
  const co = loadAllCompanies().find((c) => c.ticker.toUpperCase() === t);
  const market = (co?.market || marketHint || "NSE").trim();
  const years = rotationFetchYears();
  let all = cachedRotationCloses(t, market, years);
  if (all.length < 2) {
    try {
      all = await rotationCloses(t, market, years);
    } catch {
      all = [];
    }
  }
  if (all.length < 2) return { ok: false, error: `No daily prices for ${t}` };
  const { map: nse } = await nseListingDates();
  const cutoff = new Date(Date.now() - IPO2_RULES.maxAgeYears * 365.25 * 86_400_000).toISOString().slice(0, 10);
  const nseDate = nse.get(t) ?? null;
  const s = seriesSinceListing(t, market, nseDate, years, cutoff, bulkFirstTradeDays(years));
  if (s && !olderCompany(t, s.source === "nse" ? nseDate : null, bseCodes(), bulkListingDays(nse))) {
    const issues = await nseIssuePrices();
    const analysis = analyzeBases(s.series, { listed: true, issuePrice: issuePriceFor(issues, t, s.listing) });
    if (analysis)
      return {
        ok: true,
        ticker: t,
        mode: "ipo",
        listing_date: s.listing,
        listing_source: s.source,
        series: adjustCorporateActions(s.series).series,
        analysis,
      };
  }
  const analysis = analyzeBases(all, { listed: false });
  if (!analysis) return { ok: false, error: `${t}: too few prices` };
  return {
    ok: true,
    ticker: t,
    mode: "established",
    listing_date: null,
    listing_source: null,
    series: adjustCorporateActions(all).series,
    analysis,
  };
}
