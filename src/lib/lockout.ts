/**
 * Lockout Rallies (Davinder Khurana, IPO V2.0 notes): 6 of 8 weekly bars green at
 * the end of stage 1 or the start of stage 2 — a steady climb with no pullback to
 * buy, so anyone waiting is "locked out".
 *
 * From daily closes only: a week is green when its last close beats the week before.
 * Stage check on the 30-week average of weekly closes:
 *   - the week before the run closed under, at, or at most 10% above the average
 *     (still basing / just turning up, not already stretched in stage 2), and
 *   - the run ends above the average, and the average has risen over the run.
 */
export const LOCKOUT_RULES = {
  weeks: 8,
  green: 6,
  maWeeks: 30,
  /** Fewer weekly bars than this before the run: no average, no stage read (urgency covers new listings). */
  minMaWeeks: 10,
  /** Week before the run at most this % above the 30-week average. */
  stage1BandPct: 10,
  /** A rally ending this many weeks ago or less is current (1 = this week). */
  freshWeeks: 2,
} as const;

export type Lockout = {
  /** First day of the first week in the run, and its daily index. */
  start: string;
  start_idx: number;
  /** Last day of the last qualifying week, and its daily index. */
  end: string;
  end_idx: number;
  /** Close of the week before the run (what the gain is measured from). */
  from_price: number;
  gain_pct: number;
  /** Most green weeks in any 8-week window of the run. */
  green: number;
  weeks: number;
  /** Week before the run vs its 30-week average, %. */
  ma_start_pct: number;
};

type Bar = { date: string; close: number };
type Week = { close: number; first: number; last: number };

/** Trading week (Mon–Sun) of an ISO date, as the Monday's date. */
export function weekKey(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
}

function weekly(s: Bar[]): Week[] {
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

function sma(w: Week[], end: number, len: number, min: number): number | null {
  const from = Math.max(0, end - len + 1);
  if (end - from + 1 < min) return null;
  let sum = 0;
  for (let k = from; k <= end; k++) sum += w[k]!.close;
  return sum / (end - from + 1);
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Every lockout rally in the history; overlapping 8-week windows merge into one run. */
export function lockoutRallies(s: Bar[], R = LOCKOUT_RULES): Lockout[] {
  const w = weekly(s);
  const out: Array<Lockout & { _ref: number; _end: number }> = [];
  for (let e = R.weeks; e < w.length; e++) {
    const ref = e - R.weeks; // week before the window
    let green = 0;
    for (let k = ref + 1; k <= e; k++) if (w[k]!.close > w[k - 1]!.close) green++;
    if (green < R.green) continue;
    const maS = sma(w, ref, R.maWeeks, R.minMaWeeks);
    const maE = sma(w, e, R.maWeeks, R.minMaWeeks);
    if (maS == null || maE == null || !(maS > 0)) continue;
    const startPct = (w[ref]!.close / maS - 1) * 100;
    if (startPct > R.stage1BandPct) continue;
    if (!(w[e]!.close > maE && maE > maS)) continue;
    const prev = out[out.length - 1];
    if (prev && ref <= prev._end) {
      // Same run, still going: extend it.
      prev._end = e;
      prev.end = s[w[e]!.last]!.date;
      prev.end_idx = w[e]!.last;
      prev.green = Math.max(prev.green, green);
      prev.weeks = e - prev._ref;
      prev.gain_pct = r1((w[e]!.close / prev.from_price - 1) * 100);
      continue;
    }
    out.push({
      _ref: ref,
      _end: e,
      start: s[w[ref + 1]!.first]!.date,
      start_idx: w[ref + 1]!.first,
      end: s[w[e]!.last]!.date,
      end_idx: w[e]!.last,
      from_price: w[ref]!.close,
      gain_pct: r1((w[e]!.close / w[ref]!.close - 1) * 100),
      green,
      weeks: R.weeks,
      ma_start_pct: r1(startPct),
    });
  }
  return out.map(({ _ref, _end, ...l }) => {
    void _ref;
    void _end;
    return l;
  });
}

/** The rally still running (its last qualifying week is this week or last week), or null. */
export function currentLockout(s: Bar[], all = lockoutRallies(s), R = LOCKOUT_RULES): Lockout | null {
  const last = all[all.length - 1];
  if (!last || !s.length) return null;
  const w = weekly(s);
  const endWeek = w.findIndex((x) => x.last === last.end_idx);
  return endWeek >= w.length - R.freshWeeks ? last : null;
}
