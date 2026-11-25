import { loadAllCompanies } from "./db";
import { isRightsOrPartlyPaid } from "./listing-name-match";
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
  /** Urgency run: up this much from the first close… */
  urgencyPct: 50,
  /** …within this many trading days (~8 weeks). */
  urgencyDays: 40,
  /** A rest of this many trading days below the high is a base (IPO base / later bases). */
  ipoBaseMinDays: 15,
  baseMinDays: 25,
  /** Shallower than this is a pause, not a base. */
  baseMinDepthPct: 8,
  /** Outside the IPO base, a base needs this much rise into its high (from the low of the prior ~6 months). */
  priorRisePct: 25,
  priorRiseDays: 126,
  /** Ideal and maximum depth (IPO base may go deeper). */
  idealDepth: [18, 26] as [number, number],
  maxDepthIpoPct: 40,
  maxDepthPct: 35,
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
};

export type EntryKind = "low_cheat" | "cheat" | "pivot" | "add";

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
  urgency: boolean | null;
  bases: Ipo2Base[];
  entries: Ipo2Entry[];
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
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

function avgVol(v: number[], end: number, len: number): number | null {
  let s = 0;
  let k = 0;
  for (let j = Math.max(0, end - len); j < end; j++) {
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
  low_cheat: "Low cheat",
  cheat: "Cheat",
  pivot: "Pivot breakout",
  add: "Add",
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
export function analyzeBases(raw: Close[], opts: { listed: boolean }, R = IPO2_RULES): Ipo2Analysis | null {
  const listed = opts.listed;
  const { series, actions } = adjustCorporateActions(raw, R);
  const n = series.length;
  if (n < 2) return null;
  const c = series.map((b) => b.close);
  const v = series.map((b) => b.volume ?? 0);
  const hasVol = v.some((x) => x > 0);
  const d = (i: number) => series[i]!.date;

  const runEnd = Math.min(n, R.urgencyDays + 1);
  const runMax = Math.max(...c.slice(0, runEnd));
  const runPct = listed && c[0]! > 0 ? (runMax / c[0]! - 1) * 100 : null;
  // Not enough days yet and not already there: undecided.
  const urgency = runPct == null ? null : runPct >= R.urgencyPct ? true : n < runEnd || n <= R.urgencyDays ? null : false;

  const bases: Ipo2Base[] = [];
  const entries: Ipo2Entry[] = [];
  let H = c[0]!;
  let hIdx = 0;
  let minSinceH = c[0]!;
  let base: Ipo2Base | null = null;
  let pause: { hi: number; lo: number; zone: "low" | "mid" } | null = null;
  let tookLow = false;
  let tookMid = false;
  let lastBreakout: number | null = null;
  let legs = 0;
  /** Valid bases since the last reset (a failed base). */
  let seq = 0;
  let resetIdx = 0;
  let lastFail: { idx: number; depth: number; label: string } | null = null;

  const push = (kind: EntryKind, i: number, level: number, structStop: number, label?: string) => {
    const a = avgVol(v, i, 50);
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
      continue;
    }
    minSinceH = Math.min(minSinceH, p);
    const depth = (1 - minSinceH / H) * 100;
    const ipoBase = listed && bases.length === 0;
    if (!base && i - hIdx >= (ipoBase ? R.ipoBaseMinDays : R.baseMinDays) && depth >= R.baseMinDepthPct) {
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
      continue;
    }
    if (base.status !== "open" || !base.valid) continue;

    // A pause triggers when today's close clears its high.
    if (pause && p > pause.hi) {
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
  if (listed && n < R.ipoBaseMinDays) {
    stage = "new";
    note = `${n} trading days since listing`;
  } else if (live) {
    stage = "buy_zone";
    const b = [...bases].reverse().find((x) => x.valid && x.n === live!.base && x.start_idx <= live!.idx);
    note =
      live.kind === "add"
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
    urgency,
    listed,
    corp_actions: actions,
    bases,
    entries,
    legs,
    stage,
    stage_note: note,
    live_entry: live,
    pivot,
    to_pivot_pct: toPivot,
    vol_dry: volDry,
  };
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
  urgency: boolean | null;
  growth: Growth | null;
  growth_ok: boolean | null;
  favoured: boolean;
  bases: number;
  base_depth_pct: number | null;
  stage: Ipo2Stage;
  stage_note: string;
  live_entry: Ipo2Entry | null;
  last_entry: Ipo2Entry | null;
  pivot: number | null;
  to_pivot_pct: number | null;
  vol_dry: boolean | null;
  legs: number;
  /** One-day jumps treated as splits / bonuses (earlier prices adjusted). */
  corp_actions: CorpAction[];
  /** Checklist passes out of the checks we can run (urgency, growth, sector, depth). */
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
  const { map: nse, at: nseAt } = await nseListingDates({ wait: opts?.refresh });
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
    const a = analyzeIpo2(s.series);
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
    const score = [urgency, growthOk, favoured, depthOk].filter((x) => x === true).length;
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
      urgency,
      growth: g,
      growth_ok: growthOk,
      favoured,
      bases: a.bases.length,
      base_depth_pct: cur ? cur.depth_pct : null,
      stage: a.stage,
      stage_note: a.stage_note,
      live_entry: a.live_entry,
      last_entry: a.entries[a.entries.length - 1] ?? null,
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
    const analysis = analyzeBases(s.series, { listed: true });
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
