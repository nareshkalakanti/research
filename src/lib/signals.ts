import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  adx,
  alignBars,
  bollingerBands,
  ema,
  relativeStrength,
  rollingMean,
  rsi,
  supertrend,
  type Bar,
} from "./indicators";
import {
  fetchDailyBars,
  fetchMonthlyBars,
  fetchNiftyDailyBars,
  fetchNiftyWeeklyBars,
  fetchWeeklyBars,
  isSkippableSymbol,
  toTradingWeekFriday,
} from "./ohlc";
import { isSqliteCorrupt } from "./sqlite-utils";

const DATA_DIR = path.join(process.cwd(), "data");
const SIGNALS_PATH = path.join(DATA_DIR, "signals.db");
/** TQ uses the latest weekly bar only. */
const TQ_TF = "weekly";
/** Daily EMA stack (10/20/50/200) — latest session only. */
const EMA_TF = "daily";
/** ATH / 52W high — daily session. */
const ATH_TF = "daily";
const HIGH52_TF = "daily";
/** Trading days in a 52-week lookback (~1 calendar year). */
const HIGH52_LOOKBACK = 252;
/** Dragonfly Doji — latest weekly bar. */
const DD_TF = "weekly";
/** Body ≤ 10% of range. */
const DD_MAX_BODY_RATIO = 0.1;
/** Upper shadow ≤ 10% of range. */
const DD_MAX_UPPER_RATIO = 0.1;
/** Lower shadow ≥ 60% of range. */
const DD_MIN_LOWER_RATIO = 0.6;
/** 12−1 momentum — daily closes (~1y lookback, skip latest ~1m). */
const MOM_TF = "daily";
const MOM_LOOKBACK_1Y = 395;
const MOM_LOOKBACK_1M = 30;
const MOM_MIN_HISTORY = 400;

export type BbTimeframe = "weekly" | "monthly";
export const BB_TIMEFRAMES: BbTimeframe[] = ["weekly", "monthly"];

export type BbSignal = {
  timeframe: string;
  signal: string;
  price: number | null;
  upper_band: number | null;
  signal_date: string | null;
};

export type TqSignal = {
  timeframe: string;
  score: number | null;
  crossover_type: string | null;
  signal_date: string | null;
};

export type EmaSignal = {
  timeframe: string;
  price: number | null;
  ema10: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  signal_date: string | null;
};

export type AthSignal = {
  timeframe: string;
  price: number | null;
  ath: number | null;
  signal_date: string | null;
};

export type High52Signal = {
  timeframe: string;
  price: number | null;
  high_52w: number | null;
  signal_date: string | null;
};

export type DdSignal = {
  timeframe: string;
  price: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  signal_date: string | null;
};

export type MomSignal = {
  timeframe: string;
  price: number | null;
  price_1y: number | null;
  price_1m: number | null;
  momentum_pct: number | null;
  /** 1 = highest 12−1 momentum in the scanned universe. */
  momentum_rank: number | null;
  signal_date: string | null;
};

export type BreakoutFlags = {
  has_bb: boolean;
  has_tq: boolean;
  has_ema: boolean;
  has_ath: boolean;
  has_high52: boolean;
  has_dd: boolean;
  has_mom: boolean;
  bb?: BbSignal;
  tq?: TqSignal;
  ema?: EmaSignal;
  ath?: AthSignal;
  high52?: High52Signal;
  dd?: DdSignal;
  mom?: MomSignal;
};

function emptyFlags(): BreakoutFlags {
  return {
    has_bb: false,
    has_tq: false,
    has_ema: false,
    has_ath: false,
    has_high52: false,
    has_dd: false,
    has_mom: false,
  };
}

let signalsDb: Database.Database | null = null;
let cache: {
  at: number;
  map: Map<string, BreakoutFlags>;
  bbTf: BbTimeframe;
} | null = null;
const CACHE_MS = 5_000;

const SIGNALS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bb_signals (
    ticker TEXT NOT NULL,
    market TEXT,
    signal TEXT NOT NULL,
    timeframe TEXT NOT NULL DEFAULT 'weekly',
    price REAL,
    upper_band REAL,
    signal_date TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (ticker, timeframe)
  );
  CREATE TABLE IF NOT EXISTS tq_signals (
    ticker TEXT NOT NULL,
    timeframe TEXT NOT NULL DEFAULT 'weekly',
    market TEXT,
    score REAL,
    crossover_type TEXT,
    crossover_score INTEGER,
    signal_date TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (ticker, timeframe)
  );
  CREATE TABLE IF NOT EXISTS scan_checked (
    ticker TEXT NOT NULL,
    kind TEXT NOT NULL,
    timeframe TEXT NOT NULL DEFAULT 'weekly',
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (ticker, kind, timeframe)
  );
    CREATE TABLE IF NOT EXISTS ema_signals (
      ticker TEXT NOT NULL,
      timeframe TEXT NOT NULL DEFAULT 'daily',
      market TEXT,
      price REAL,
      ema10 REAL,
      ema20 REAL,
      ema50 REAL,
      ema200 REAL,
      signal_date TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (ticker, timeframe)
    );
    CREATE TABLE IF NOT EXISTS ath_signals (
      ticker TEXT NOT NULL,
      timeframe TEXT NOT NULL DEFAULT 'daily',
      market TEXT,
      price REAL,
      ath REAL,
      signal_date TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (ticker, timeframe)
    );
    CREATE TABLE IF NOT EXISTS high52_signals (
      ticker TEXT NOT NULL,
      timeframe TEXT NOT NULL DEFAULT 'daily',
      market TEXT,
      price REAL,
      high_52w REAL,
      signal_date TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (ticker, timeframe)
    );
    CREATE TABLE IF NOT EXISTS dd_signals (
      ticker TEXT NOT NULL,
      timeframe TEXT NOT NULL DEFAULT 'weekly',
      market TEXT,
      price REAL,
      open REAL,
      high REAL,
      low REAL,
      signal_date TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (ticker, timeframe)
    );
    CREATE TABLE IF NOT EXISTS mom_signals (
      ticker TEXT NOT NULL,
      timeframe TEXT NOT NULL DEFAULT 'daily',
      market TEXT,
      price REAL,
      price_1y REAL,
      price_1m REAL,
      momentum_pct REAL,
      signal_date TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (ticker, timeframe)
    );
`;

function closeSignalsDb(): void {
  if (!signalsDb) return;
  try {
    signalsDb.close();
  } catch {
    /* already closed */
  }
  signalsDb = null;
}

/** Recreate signals.db when the on-disk image is malformed (BB/TQ/EMA scan). */
export function resetSignalsDb(): void {
  closeSignalsDb();
  invalidateBreakoutCache();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = SIGNALS_PATH + suffix;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* another process may still hold the inode */
    }
  }
}

function ensureDb(): Database.Database {
  if (signalsDb) return signalsDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const db = new Database(SIGNALS_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(SIGNALS_SCHEMA);
    // Fail fast if the file is already corrupt (open alone often succeeds).
    db.pragma("quick_check");
    signalsDb = db;
    return db;
  } catch (err) {
    if (!isSqliteCorrupt(err)) throw err;
    console.warn("[signals] corrupt db — recreating signals.db");
    resetSignalsDb();
    const db = new Database(SIGNALS_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(SIGNALS_SCHEMA);
    signalsDb = db;
    return db;
  }
}

/** Run a write against signals.db; recreate once on SQLITE_CORRUPT. */
function withSignalsWrite<T>(fn: (db: Database.Database) => T, retry = true): T {
  try {
    return fn(ensureDb());
  } catch (err) {
    if (retry && isSqliteCorrupt(err)) {
      console.warn("[signals] corrupt db during write — recreating signals.db");
      resetSignalsDb();
      return withSignalsWrite(fn, false);
    }
    throw err;
  }
}

export function invalidateBreakoutCache(): void {
  cache = null;
}

/** Wipe BB/TQ/EMA/ATH/52W/DD/MOM hits + scan progress (full rescan from scratch). */
export function clearAllWeeklySignals(): void {
  withSignalsWrite((db) => {
    db.exec(`
      DELETE FROM bb_signals;
      DELETE FROM tq_signals;
      DELETE FROM ema_signals;
      DELETE FROM ath_signals;
      DELETE FROM high52_signals;
      DELETE FROM dd_signals;
      DELETE FROM mom_signals;
      DELETE FROM scan_checked;
    `);
  });
  invalidateBreakoutCache();
}

/** Keep only the latest session bar date. */
function isLatestSession(
  signalDate: string | null,
  latestBar: string | null,
): boolean {
  if (!signalDate || !latestBar) return false;
  return signalDate.slice(0, 10) === latestBar.slice(0, 10);
}

export function latestSignalDates(map = loadBreakoutMap()): {
  bb: string | null;
  tq: string | null;
  ema: string | null;
  ath: string | null;
  high52: string | null;
  dd: string | null;
  mom: string | null;
} {
  let bb: string | null = null;
  let tq: string | null = null;
  let ema: string | null = null;
  let ath: string | null = null;
  let high52: string | null = null;
  let dd: string | null = null;
  let mom: string | null = null;
  for (const v of map.values()) {
    if (v.has_bb && v.bb?.signal_date) {
      const d = v.bb.signal_date.slice(0, 10);
      if (!bb || d > bb) bb = d;
    }
    if (v.has_tq && v.tq?.signal_date) {
      const d = v.tq.signal_date.slice(0, 10);
      if (!tq || d > tq) tq = d;
    }
    if (v.has_ema && v.ema?.signal_date) {
      const d = v.ema.signal_date.slice(0, 10);
      if (!ema || d > ema) ema = d;
    }
    if (v.has_ath && v.ath?.signal_date) {
      const d = v.ath.signal_date.slice(0, 10);
      if (!ath || d > ath) ath = d;
    }
    if (v.has_high52 && v.high52?.signal_date) {
      const d = v.high52.signal_date.slice(0, 10);
      if (!high52 || d > high52) high52 = d;
    }
    if (v.has_dd && v.dd?.signal_date) {
      const d = v.dd.signal_date.slice(0, 10);
      if (!dd || d > dd) dd = d;
    }
    if (v.mom?.signal_date) {
      const d = v.mom.signal_date.slice(0, 10);
      if (!mom || d > mom) mom = d;
    }
  }
  return { bb, tq, ema, ath, high52, dd, mom };
}

export function loadBreakoutMap(bbTimeframe: BbTimeframe = "weekly"): Map<string, BreakoutFlags> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS && cache.bbTf === bbTimeframe) {
    return cache.map;
  }

  const map = new Map<string, BreakoutFlags>();
  const bbTf = bbTimeframe;
  try {
    if (!fs.existsSync(SIGNALS_PATH)) {
      cache = { at: now, map, bbTf };
      return map;
    }
    const db = ensureDb();

    const latestBb = (
      db
        .prepare(
          `SELECT MAX(signal_date) AS d FROM bb_signals
           WHERE signal = 'NEW_BREAKOUT' AND lower(timeframe) = ?`,
        )
        .get(bbTf) as { d: string | null } | undefined
    )?.d;
    const latestTq = (
      db
        .prepare(
          `SELECT MAX(signal_date) AS d FROM tq_signals
           WHERE lower(timeframe) = ?
             AND crossover_type IS NOT NULL
             AND crossover_type != 'No Crossover'`,
        )
        .get(TQ_TF) as { d: string | null } | undefined
    )?.d;

    // Drop older sessions so tags only ever show the latest day.
    if (latestBb) {
      db.prepare(
        `DELETE FROM bb_signals
         WHERE lower(timeframe) = ? AND (signal_date IS NULL OR signal_date < ?)`,
      ).run(bbTf, latestBb.slice(0, 10));
    }
    if (latestTq) {
      db.prepare(
        `DELETE FROM tq_signals
         WHERE lower(timeframe) = ? AND (signal_date IS NULL OR signal_date < ?)`,
      ).run(TQ_TF, latestTq.slice(0, 10));
    }

    const bbRows = db
      .prepare(
        `SELECT ticker, timeframe, signal, price, upper_band, signal_date
         FROM bb_signals
         WHERE signal = 'NEW_BREAKOUT' AND lower(timeframe) = ?`,
      )
      .all(bbTf) as Array<{
      ticker: string;
      timeframe: string;
      signal: string;
      price: number | null;
      upper_band: number | null;
      signal_date: string | null;
    }>;
    for (const r of bbRows) {
      if (!isLatestSession(r.signal_date, latestBb ?? null)) continue;
      const t = r.ticker.toUpperCase();
      const cur = map.get(t) ?? emptyFlags();
      cur.has_bb = true;
      cur.bb = {
        timeframe: r.timeframe,
        signal: r.signal,
        price: r.price,
        upper_band: r.upper_band,
        signal_date: r.signal_date,
      };
      map.set(t, cur);
    }

    const tqRows = db
      .prepare(
        `SELECT ticker, timeframe, score, crossover_type, signal_date
         FROM tq_signals
         WHERE lower(timeframe) = ?
           AND crossover_type IS NOT NULL
           AND crossover_type != 'No Crossover'`,
      )
      .all(TQ_TF) as Array<{
      ticker: string;
      timeframe: string;
      score: number | null;
      crossover_type: string | null;
      signal_date: string | null;
    }>;
    for (const r of tqRows) {
      if (!isLatestSession(r.signal_date, latestTq ?? null)) continue;
      const t = r.ticker.toUpperCase();
      const cur = map.get(t) ?? emptyFlags();
      cur.has_tq = true;
      cur.tq = {
        timeframe: r.timeframe,
        score: r.score,
        crossover_type: r.crossover_type,
        signal_date: r.signal_date,
      };
      map.set(t, cur);
    }

    const latestEma = (
      db
        .prepare(
          `SELECT MAX(signal_date) AS d FROM ema_signals WHERE lower(timeframe) = ?`,
        )
        .get(EMA_TF) as { d: string | null } | undefined
    )?.d;
    if (latestEma) {
      db.prepare(
        `DELETE FROM ema_signals
         WHERE lower(timeframe) = ? AND (signal_date IS NULL OR signal_date < ?)`,
      ).run(EMA_TF, latestEma.slice(0, 10));
    }

    const emaRows = db
      .prepare(
        `SELECT ticker, timeframe, price, ema10, ema20, ema50, ema200, signal_date
         FROM ema_signals WHERE lower(timeframe) = ?`,
      )
      .all(EMA_TF) as Array<{
      ticker: string;
      timeframe: string;
      price: number | null;
      ema10: number | null;
      ema20: number | null;
      ema50: number | null;
      ema200: number | null;
      signal_date: string | null;
    }>;
    for (const r of emaRows) {
      if (!isLatestSession(r.signal_date, latestEma ?? null)) continue;
      const t = r.ticker.toUpperCase();
      const cur = map.get(t) ?? emptyFlags();
      cur.has_ema = true;
      cur.ema = {
        timeframe: r.timeframe,
        price: r.price,
        ema10: r.ema10,
        ema20: r.ema20,
        ema50: r.ema50,
        ema200: r.ema200,
        signal_date: r.signal_date,
      };
      map.set(t, cur);
    }

    const latestAth = (
      db
        .prepare(
          `SELECT MAX(signal_date) AS d FROM ath_signals WHERE lower(timeframe) = ?`,
        )
        .get(ATH_TF) as { d: string | null } | undefined
    )?.d;
    if (latestAth) {
      db.prepare(
        `DELETE FROM ath_signals
         WHERE lower(timeframe) = ? AND (signal_date IS NULL OR signal_date < ?)`,
      ).run(ATH_TF, latestAth.slice(0, 10));
    }
    const athRows = db
      .prepare(
        `SELECT ticker, timeframe, price, ath, signal_date
         FROM ath_signals WHERE lower(timeframe) = ?`,
      )
      .all(ATH_TF) as Array<{
      ticker: string;
      timeframe: string;
      price: number | null;
      ath: number | null;
      signal_date: string | null;
    }>;
    for (const r of athRows) {
      if (!isLatestSession(r.signal_date, latestAth ?? null)) continue;
      const t = r.ticker.toUpperCase();
      const cur = map.get(t) ?? emptyFlags();
      cur.has_ath = true;
      cur.ath = {
        timeframe: r.timeframe,
        price: r.price,
        ath: r.ath,
        signal_date: r.signal_date,
      };
      map.set(t, cur);
    }

    const latestHigh52 = (
      db
        .prepare(
          `SELECT MAX(signal_date) AS d FROM high52_signals WHERE lower(timeframe) = ?`,
        )
        .get(HIGH52_TF) as { d: string | null } | undefined
    )?.d;
    if (latestHigh52) {
      db.prepare(
        `DELETE FROM high52_signals
         WHERE lower(timeframe) = ? AND (signal_date IS NULL OR signal_date < ?)`,
      ).run(HIGH52_TF, latestHigh52.slice(0, 10));
    }
    const high52Rows = db
      .prepare(
        `SELECT ticker, timeframe, price, high_52w, signal_date
         FROM high52_signals WHERE lower(timeframe) = ?`,
      )
      .all(HIGH52_TF) as Array<{
      ticker: string;
      timeframe: string;
      price: number | null;
      high_52w: number | null;
      signal_date: string | null;
    }>;
    for (const r of high52Rows) {
      if (!isLatestSession(r.signal_date, latestHigh52 ?? null)) continue;
      const t = r.ticker.toUpperCase();
      const cur = map.get(t) ?? emptyFlags();
      cur.has_high52 = true;
      cur.high52 = {
        timeframe: r.timeframe,
        price: r.price,
        high_52w: r.high_52w,
        signal_date: r.signal_date,
      };
      map.set(t, cur);
    }

    const latestDd = (
      db
        .prepare(
          `SELECT MAX(signal_date) AS d FROM dd_signals WHERE lower(timeframe) = ?`,
        )
        .get(DD_TF) as { d: string | null } | undefined
    )?.d;
    if (latestDd) {
      db.prepare(
        `DELETE FROM dd_signals
         WHERE lower(timeframe) = ? AND (signal_date IS NULL OR signal_date < ?)`,
      ).run(DD_TF, latestDd.slice(0, 10));
    }
    const ddRows = db
      .prepare(
        `SELECT ticker, timeframe, price, open, high, low, signal_date
         FROM dd_signals WHERE lower(timeframe) = ?`,
      )
      .all(DD_TF) as Array<{
      ticker: string;
      timeframe: string;
      price: number | null;
      open: number | null;
      high: number | null;
      low: number | null;
      signal_date: string | null;
    }>;
    for (const r of ddRows) {
      if (!isLatestSession(r.signal_date, latestDd ?? null)) continue;
      const t = r.ticker.toUpperCase();
      const cur = map.get(t) ?? emptyFlags();
      cur.has_dd = true;
      cur.dd = {
        timeframe: r.timeframe,
        price: r.price,
        open: r.open,
        high: r.high,
        low: r.low,
        signal_date: r.signal_date,
      };
      map.set(t, cur);
    }

    // Momentum is a trailing 12−1 snapshot — keep all tickers even if their
    // last bar is a session or two behind the freshest name in the table.
    const momRows = db
      .prepare(
        `SELECT ticker, timeframe, price, price_1y, price_1m, momentum_pct, signal_date
         FROM mom_signals WHERE lower(timeframe) = ?`,
      )
      .all(MOM_TF) as Array<{
      ticker: string;
      timeframe: string;
      price: number | null;
      price_1y: number | null;
      price_1m: number | null;
      momentum_pct: number | null;
      signal_date: string | null;
    }>;
    // Rank 1 = highest momentum across the full scanned universe
    const ranked = [...momRows]
      .filter((r) => r.momentum_pct != null)
      .sort(
        (a, b) =>
          (b.momentum_pct as number) - (a.momentum_pct as number) ||
          a.ticker.localeCompare(b.ticker),
      );
    const rankByTicker = new Map<string, number>();
    ranked.forEach((r, i) => {
      rankByTicker.set(r.ticker.toUpperCase(), i + 1);
    });
    for (const r of momRows) {
      if (r.momentum_pct == null) continue;
      const t = r.ticker.toUpperCase();
      const cur = map.get(t) ?? emptyFlags();
      cur.mom = {
        timeframe: r.timeframe,
        price: r.price,
        price_1y: r.price_1y,
        price_1m: r.price_1m,
        momentum_pct: r.momentum_pct,
        momentum_rank: rankByTicker.get(t) ?? null,
        signal_date: r.signal_date,
      };
      // Filter / count = positive 12−1 only
      cur.has_mom = r.momentum_pct > 0;
      map.set(t, cur);
    }
  } catch (err) {
    if (isSqliteCorrupt(err)) {
      console.warn("[signals] corrupt db on load — recreating signals.db");
      resetSignalsDb();
    }
    /* missing / unreadable db */
  }

  cache = { at: now, map, bbTf };
  return map;
}

export function breakoutCounts(map = loadBreakoutMap()): {
  bb: number;
  tq: number;
  ema: number;
  ath: number;
  high52: number;
  dd: number;
  mom: number;
} {
  let bb = 0;
  let tq = 0;
  let ema = 0;
  let ath = 0;
  let high52 = 0;
  let dd = 0;
  let mom = 0;
  for (const v of map.values()) {
    if (v.has_bb) bb += 1;
    if (v.has_tq) tq += 1;
    if (v.has_ema) ema += 1;
    if (v.has_ath) ath += 1;
    if (v.has_high52) high52 += 1;
    if (v.has_dd) dd += 1;
    if (v.has_mom) mom += 1;
  }
  return { bb, tq, ema, ath, high52, dd, mom };
}

export function analyzeBbNewBreakout(
  bars: Bar[],
  timeframe: BbTimeframe = "weekly",
): Omit<BbSignal, "timeframe"> & { price: number; upper_band: number } | null {
  if (bars.length < 50) return null;
  const closes = bars.map((b) => b.close);
  const { upper, lower } = bollingerBands(closes, 50, 2);
  const i = bars.length - 1;
  const prev = i - 1;
  const u = upper[i];
  const pu = upper[prev];
  const l = lower[i];
  if (u == null || pu == null || l == null) return null;

  const price = bars[i].close;
  const prevClose = bars[prev].close;
  let signal: string;
  if (price > u) {
    signal = prevClose <= pu ? "NEW_BREAKOUT" : "ABOVE_BAND";
  } else if (price < l) {
    signal = "BELOW_BAND";
  } else {
    signal = "NEUTRAL";
  }
  if (signal !== "NEW_BREAKOUT") return null;
  const signal_date =
    timeframe === "monthly"
      ? bars[i].date.slice(0, 10)
      : toTradingWeekFriday(bars[i].date);
  return {
    signal,
    price: Math.round(price * 100) / 100,
    upper_band: Math.round(u * 100) / 100,
    signal_date,
  };
}

/** @deprecated use analyzeBbNewBreakout */
export function analyzeBbWeekly(bars: Bar[]) {
  return analyzeBbNewBreakout(bars, "weekly");
}

export function analyzeTqWeekly(
  stockBars: Bar[],
  niftyBars: Bar[],
): {
  score: number;
  crossover_type: string;
  crossover_score: number;
  signal_date: string;
} | null {
  const aligned = alignBars(stockBars, niftyBars, 65);
  if (!aligned) return null;
  const { stock, nifty } = aligned;
  const closes = stock.map((b) => b.close);
  const volumes = stock.map((b) => b.volume);
  const niftyCloses = nifty.map((b) => b.close);

  const nanClose = closes.filter((c) => !Number.isFinite(c)).length;
  if (nanClose > closes.length * 0.1) return null;

  const rsiVals = rsi(closes, 21);
  const { line: stLine } = supertrend(stock, 10, 3);
  const { adx: adxVals, diPlus, diMinus } = adx(stock, 13);
  const priceMa = rollingMean(closes, 13);
  const volMa = rollingMean(volumes, 13);
  const longRs = relativeStrength(closes, niftyCloses, 52);
  const shortRs = relativeStrength(closes, niftyCloses, 13);

  const i = stock.length - 1;
  const prev = i - 1;
  const curRsi = rsiVals[i];
  const curSt = stLine[i];
  const curAdx = adxVals[i];
  const curDiP = diPlus[i];
  const curDiM = diMinus[i];
  const curPma = priceMa[i];
  const curVma = volMa[i];
  const curLrs = longRs[i];
  const curSrs = shortRs[i];
  const price = closes[i];
  const vol = volumes[i];

  if (curRsi == null || curRsi <= 55) return null;
  if (curSt == null || price <= curSt) return null;
  if (curAdx == null || curAdx <= 20) return null;
  if (curDiP == null || curDiM == null || curDiP <= curDiM) return null;
  if (curPma == null || price <= curPma) return null;
  if (curVma == null || vol <= curVma) return null;
  if (curLrs == null || curLrs <= 0) return null;
  if (curSrs == null || curSrs <= 0) return null;

  const prevLrs = longRs[prev] ?? 0;
  const prevSrs = shortRs[prev] ?? 0;

  const longX =
    (prevLrs < -0.15 && curLrs > 0.005) || (prevLrs < 0 && curLrs > 0.02);
  const shortX =
    (prevSrs < -0.005 && curSrs > 0.005) || (prevSrs < 0.01 && curSrs > 0.02);

  let crossover_type: string;
  let crossover_score: number;
  if (longX && shortX) {
    crossover_type = "Both 52W & 13W";
    crossover_score = 3;
  } else if (longX) {
    crossover_type = "52W Only";
    crossover_score = 2;
  } else if (shortX) {
    crossover_type = "13W Only";
    crossover_score = 1;
  } else {
    return null; // No Crossover — not tagged
  }

  const rsiScore = Math.min(25, Math.max(0, (curRsi - 55) * 2.5));
  const adxScore = Math.min(25, Math.max(0, (curAdx - 20) * 1.25));
  const dmiScore = Math.min(25, Math.max(0, (curDiP - curDiM) * 2));
  const rsScore = Math.min(25, Math.max(0, (curLrs + curSrs) * 1000));
  const score = Math.round((rsiScore + adxScore + dmiScore + rsScore) * 100) / 100;

  return {
    score,
    crossover_type,
    crossover_score,
    signal_date: toTradingWeekFriday(stock[i].date),
  };
}

/** Daily close above 10 / 20 / 50 / 200 EMA (all four). */
export function analyzeEmaDaily(bars: Bar[]): {
  price: number;
  ema10: number;
  ema20: number;
  ema50: number;
  ema200: number;
  signal_date: string;
} | null {
  if (bars.length < 200) return null;
  const closes = bars.map((b) => b.close);
  const e10 = ema(closes, 10);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const i = bars.length - 1;
  const price = closes[i];
  const v10 = e10[i];
  const v20 = e20[i];
  const v50 = e50[i];
  const v200 = e200[i];
  if (v10 == null || v20 == null || v50 == null || v200 == null) return null;
  if (price <= v10 || price <= v20 || price <= v50 || price <= v200) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    price: round(price),
    ema10: round(v10),
    ema20: round(v20),
    ema50: round(v50),
    ema200: round(v200),
    signal_date: bars[i].date.slice(0, 10),
  };
}

/**
 * NEW all-time high: close prints above the prior max high, and previous close
 * was still below that level (same “NEW” idea as BB NEW).
 */
export function analyzeAthNew(bars: Bar[]): {
  price: number;
  ath: number;
  signal_date: string;
} | null {
  if (bars.length < 60) return null;
  const i = bars.length - 1;
  let priorMax = -Infinity;
  for (let j = 0; j < i; j += 1) {
    const h = bars[j]!.high;
    if (Number.isFinite(h) && h > priorMax) priorMax = h;
  }
  if (!Number.isFinite(priorMax) || priorMax <= 0) return null;
  const price = bars[i]!.close;
  const prevClose = bars[i - 1]!.close;
  if (!Number.isFinite(price) || !Number.isFinite(prevClose)) return null;
  if (price < priorMax || prevClose >= priorMax) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    price: round(price),
    ath: round(Math.max(priorMax, price)),
    signal_date: bars[i]!.date.slice(0, 10),
  };
}

/**
 * NEW 52-week high: close above prior 252-day max high, with previous close below.
 */
export function analyzeHigh52New(bars: Bar[]): {
  price: number;
  high_52w: number;
  signal_date: string;
} | null {
  if (bars.length < HIGH52_LOOKBACK + 2) return null;
  const i = bars.length - 1;
  const start = Math.max(0, i - HIGH52_LOOKBACK);
  let priorMax = -Infinity;
  for (let j = start; j < i; j += 1) {
    const h = bars[j]!.high;
    if (Number.isFinite(h) && h > priorMax) priorMax = h;
  }
  if (!Number.isFinite(priorMax) || priorMax <= 0) return null;
  const price = bars[i]!.close;
  const prevClose = bars[i - 1]!.close;
  if (!Number.isFinite(price) || !Number.isFinite(prevClose)) return null;
  if (price < priorMax || prevClose >= priorMax) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    price: round(price),
    high_52w: round(Math.max(priorMax, price)),
    signal_date: bars[i]!.date.slice(0, 10),
  };
}

/**
 * Weekly Dragonfly Doji: tiny body near the high, long lower wick, little/no
 * upper wick on the latest completed weekly bar.
 */
export function analyzeDragonflyWeekly(bars: Bar[]): {
  price: number;
  open: number;
  high: number;
  low: number;
  signal_date: string;
} | null {
  if (bars.length < 2) return null;
  const bar = bars[bars.length - 1]!;
  const { open, high, low, close } = bar;
  if (
    ![open, high, low, close].every((n) => Number.isFinite(n)) ||
    high < low
  ) {
    return null;
  }
  const range = high - low;
  if (range <= 0) return null;
  const body = Math.abs(close - open);
  const upper = high - Math.max(open, close);
  const lower = Math.min(open, close) - low;
  if (body / range > DD_MAX_BODY_RATIO) return null;
  if (upper / range > DD_MAX_UPPER_RATIO) return null;
  if (lower / range < DD_MIN_LOWER_RATIO) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    price: round(close),
    open: round(open),
    high: round(high),
    low: round(low),
    signal_date: toTradingWeekFriday(bar.date),
  };
}

/**
 * 12−1 price momentum (stocks-ai / Google Finance style):
 * (Price ~1M ago / Price ~1Y ago − 1) × 100 — skips the most recent month.
 */
export function analyzeMomentumDaily(bars: Bar[]): {
  price: number;
  price_1y: number;
  price_1m: number;
  momentum_pct: number;
  signal_date: string;
} | null {
  if (bars.length < MOM_MIN_HISTORY) return null;
  const closes = bars.map((b) => b.close).filter((n) => Number.isFinite(n));
  if (closes.length < MOM_MIN_HISTORY) return null;
  const price = closes[closes.length - 1]!;
  const price_1y = closes[closes.length - MOM_LOOKBACK_1Y]!;
  const price_1m = closes[closes.length - MOM_LOOKBACK_1M]!;
  if (!(price_1y > 0) || !Number.isFinite(price_1m)) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    price: round(price),
    price_1y: round(price_1y),
    price_1m: round(price_1m),
    momentum_pct: round((price_1m / price_1y - 1) * 100),
    signal_date: bars[bars.length - 1]!.date.slice(0, 10),
  };
}

function upsertBb(
  rows: Array<{
    ticker: string;
    market: string | null;
    signal: string;
    price: number;
    upper_band: number;
    signal_date: string;
  }>,
  timeframe: BbTimeframe,
): number {
  if (!rows.length) return 0;
  return withSignalsWrite((db) => {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO bb_signals (ticker, market, signal, timeframe, price, upper_band, signal_date, fetched_at)
      VALUES (@ticker, @market, @signal, @timeframe, @price, @upper_band, @signal_date, @fetched_at)
      ON CONFLICT(ticker, timeframe) DO UPDATE SET
        market = excluded.market,
        signal = excluded.signal,
        price = excluded.price,
        upper_band = excluded.upper_band,
        signal_date = excluded.signal_date,
        fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction((batch: typeof rows) => {
      for (const r of batch) {
        stmt.run({ ...r, timeframe, fetched_at: now });
      }
    });
    tx(rows);
    return rows.length;
  });
}

function clearBbForTickers(tickers: string[], timeframe: BbTimeframe): void {
  if (!tickers.length) return;
  withSignalsWrite((db) => {
    const placeholders = tickers.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM bb_signals WHERE timeframe = ? AND ticker IN (${placeholders})`,
    ).run(timeframe, ...tickers.map((t) => t.toUpperCase()));
  });
}

function upsertTq(
  rows: Array<{
    ticker: string;
    market: string | null;
    score: number;
    crossover_type: string;
    crossover_score: number;
    signal_date: string;
  }>,
): number {
  if (!rows.length) return 0;
  return withSignalsWrite((db) => {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO tq_signals (ticker, timeframe, market, score, crossover_type, crossover_score, signal_date, fetched_at)
      VALUES (@ticker, '${TQ_TF}', @market, @score, @crossover_type, @crossover_score, @signal_date, @fetched_at)
      ON CONFLICT(ticker, timeframe) DO UPDATE SET
        market = excluded.market,
        score = excluded.score,
        crossover_type = excluded.crossover_type,
        crossover_score = excluded.crossover_score,
        signal_date = excluded.signal_date,
        fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction((batch: typeof rows) => {
      for (const r of batch) {
        stmt.run({ ...r, fetched_at: now });
      }
    });
    tx(rows);
    return rows.length;
  });
}

function clearTqForTickers(tickers: string[]): void {
  if (!tickers.length) return;
  withSignalsWrite((db) => {
    const placeholders = tickers.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM tq_signals WHERE timeframe = ? AND ticker IN (${placeholders})`,
    ).run(TQ_TF, ...tickers.map((t) => t.toUpperCase()));
  });
}

function upsertEma(
  rows: Array<{
    ticker: string;
    market: string | null;
    price: number;
    ema10: number;
    ema20: number;
    ema50: number;
    ema200: number;
    signal_date: string;
  }>,
): number {
  if (!rows.length) return 0;
  return withSignalsWrite((db) => {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO ema_signals (ticker, timeframe, market, price, ema10, ema20, ema50, ema200, signal_date, fetched_at)
      VALUES (@ticker, '${EMA_TF}', @market, @price, @ema10, @ema20, @ema50, @ema200, @signal_date, @fetched_at)
      ON CONFLICT(ticker, timeframe) DO UPDATE SET
        market = excluded.market,
        price = excluded.price,
        ema10 = excluded.ema10,
        ema20 = excluded.ema20,
        ema50 = excluded.ema50,
        ema200 = excluded.ema200,
        signal_date = excluded.signal_date,
        fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction((batch: typeof rows) => {
      for (const r of batch) stmt.run({ ...r, fetched_at: now });
    });
    tx(rows);
    return rows.length;
  });
}

function clearEmaForTickers(tickers: string[]): void {
  if (!tickers.length) return;
  withSignalsWrite((db) => {
    const placeholders = tickers.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM ema_signals WHERE timeframe = ? AND ticker IN (${placeholders})`,
    ).run(EMA_TF, ...tickers.map((t) => t.toUpperCase()));
  });
}

function upsertAth(
  rows: Array<{
    ticker: string;
    market: string | null;
    price: number;
    ath: number;
    signal_date: string;
  }>,
): number {
  if (!rows.length) return 0;
  return withSignalsWrite((db) => {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO ath_signals (ticker, timeframe, market, price, ath, signal_date, fetched_at)
      VALUES (@ticker, '${ATH_TF}', @market, @price, @ath, @signal_date, @fetched_at)
      ON CONFLICT(ticker, timeframe) DO UPDATE SET
        market = excluded.market,
        price = excluded.price,
        ath = excluded.ath,
        signal_date = excluded.signal_date,
        fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction((batch: typeof rows) => {
      for (const r of batch) stmt.run({ ...r, fetched_at: now });
    });
    tx(rows);
    return rows.length;
  });
}

function clearAthForTickers(tickers: string[]): void {
  if (!tickers.length) return;
  withSignalsWrite((db) => {
    const placeholders = tickers.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM ath_signals WHERE timeframe = ? AND ticker IN (${placeholders})`,
    ).run(ATH_TF, ...tickers.map((t) => t.toUpperCase()));
  });
}

function upsertHigh52(
  rows: Array<{
    ticker: string;
    market: string | null;
    price: number;
    high_52w: number;
    signal_date: string;
  }>,
): number {
  if (!rows.length) return 0;
  return withSignalsWrite((db) => {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO high52_signals (ticker, timeframe, market, price, high_52w, signal_date, fetched_at)
      VALUES (@ticker, '${HIGH52_TF}', @market, @price, @high_52w, @signal_date, @fetched_at)
      ON CONFLICT(ticker, timeframe) DO UPDATE SET
        market = excluded.market,
        price = excluded.price,
        high_52w = excluded.high_52w,
        signal_date = excluded.signal_date,
        fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction((batch: typeof rows) => {
      for (const r of batch) stmt.run({ ...r, fetched_at: now });
    });
    tx(rows);
    return rows.length;
  });
}

function clearHigh52ForTickers(tickers: string[]): void {
  if (!tickers.length) return;
  withSignalsWrite((db) => {
    const placeholders = tickers.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM high52_signals WHERE timeframe = ? AND ticker IN (${placeholders})`,
    ).run(HIGH52_TF, ...tickers.map((t) => t.toUpperCase()));
  });
}

function upsertDd(
  rows: Array<{
    ticker: string;
    market: string | null;
    price: number;
    open: number;
    high: number;
    low: number;
    signal_date: string;
  }>,
): number {
  if (!rows.length) return 0;
  return withSignalsWrite((db) => {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO dd_signals (ticker, timeframe, market, price, open, high, low, signal_date, fetched_at)
      VALUES (@ticker, '${DD_TF}', @market, @price, @open, @high, @low, @signal_date, @fetched_at)
      ON CONFLICT(ticker, timeframe) DO UPDATE SET
        market = excluded.market,
        price = excluded.price,
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        signal_date = excluded.signal_date,
        fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction((batch: typeof rows) => {
      for (const r of batch) stmt.run({ ...r, fetched_at: now });
    });
    tx(rows);
    return rows.length;
  });
}

function clearDdForTickers(tickers: string[]): void {
  if (!tickers.length) return;
  withSignalsWrite((db) => {
    const placeholders = tickers.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM dd_signals WHERE timeframe = ? AND ticker IN (${placeholders})`,
    ).run(DD_TF, ...tickers.map((t) => t.toUpperCase()));
  });
}

function upsertMom(
  rows: Array<{
    ticker: string;
    market: string | null;
    price: number;
    price_1y: number;
    price_1m: number;
    momentum_pct: number;
    signal_date: string;
  }>,
): number {
  if (!rows.length) return 0;
  return withSignalsWrite((db) => {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO mom_signals (
        ticker, timeframe, market, price, price_1y, price_1m, momentum_pct, signal_date, fetched_at
      )
      VALUES (
        @ticker, '${MOM_TF}', @market, @price, @price_1y, @price_1m, @momentum_pct, @signal_date, @fetched_at
      )
      ON CONFLICT(ticker, timeframe) DO UPDATE SET
        market = excluded.market,
        price = excluded.price,
        price_1y = excluded.price_1y,
        price_1m = excluded.price_1m,
        momentum_pct = excluded.momentum_pct,
        signal_date = excluded.signal_date,
        fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction((batch: typeof rows) => {
      for (const r of batch) stmt.run({ ...r, fetched_at: now });
    });
    tx(rows);
    return rows.length;
  });
}

function clearMomForTickers(tickers: string[]): void {
  if (!tickers.length) return;
  withSignalsWrite((db) => {
    const placeholders = tickers.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM mom_signals WHERE timeframe = ? AND ticker IN (${placeholders})`,
    ).run(MOM_TF, ...tickers.map((t) => t.toUpperCase()));
  });
}

export type ScanKind =
  | "bb"
  | "tq"
  | "ema"
  | "ath"
  | "high52"
  | "dd"
  | "mom"
  | "both"
  | "all";

type SignalKind = "bb" | "tq" | "ema" | "ath" | "high52" | "dd" | "mom";

function scanKinds(kind: ScanKind): SignalKind[] {
  if (kind === "all") return ["bb", "tq", "ema", "ath", "high52", "dd", "mom"];
  if (kind === "both") return ["bb", "tq"];
  return [kind];
}

function kindTimeframe(
  k: SignalKind,
  bbTimeframe: BbTimeframe = "weekly",
): string {
  if (k === "ema" || k === "ath" || k === "high52" || k === "mom") return EMA_TF;
  if (k === "bb") return bbTimeframe;
  if (k === "dd") return DD_TF;
  return TQ_TF;
}

function kindMaxAgeMs(k: SignalKind): number {
  return k === "ema" || k === "ath" || k === "high52" || k === "mom"
    ? 24 * 60 * 60 * 1000
    : 6 * 24 * 60 * 60 * 1000;
}

function markChecked(
  tickers: string[],
  checks: Array<{ kind: SignalKind; timeframe: string }>,
): void {
  if (!tickers.length || !checks.length) return;
  withSignalsWrite((db) => {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO scan_checked (ticker, kind, timeframe, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ticker, kind, timeframe) DO UPDATE SET fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction(() => {
      for (const t of tickers) {
        for (const c of checks) stmt.run(t.toUpperCase(), c.kind, c.timeframe, now);
      }
    });
    tx();
  });
}

export function uncheckedTickers(
  tickers: string[],
  kind: ScanKind,
  opts?: { maxAgeMs?: number; bbTimeframe?: BbTimeframe },
): Set<string> {
  if (!tickers.length) return new Set();
  const kinds = scanKinds(kind);
  const bbTf = opts?.bbTimeframe ?? "weekly";
  try {
    if (!fs.existsSync(SIGNALS_PATH)) return new Set(tickers.map((t) => t.toUpperCase()));
    const db = ensureDb();
    const checked = new Set<string>();
    const now = Date.now();
    for (const k of kinds) {
      const maxAgeMs = opts?.maxAgeMs ?? kindMaxAgeMs(k);
      const tf = kindTimeframe(k, bbTf);
      // MOM: only treat as done if we actually stored a 12−1 row (not just
      // scan_checked — earlier session-gated runs marked many with no data).
      if (k === "mom") {
        const rows = db
          .prepare(
            `SELECT ticker, fetched_at FROM mom_signals WHERE lower(timeframe) = ?`,
          )
          .all(tf) as { ticker: string; fetched_at: string }[];
        for (const r of rows) {
          const at = Date.parse(r.fetched_at);
          if (Number.isFinite(at) && now - at < maxAgeMs) {
            checked.add(`${r.ticker.toUpperCase()}:${k}`);
          }
        }
        continue;
      }
      const rows = db
        .prepare(
          `SELECT ticker, fetched_at FROM scan_checked WHERE kind = ? AND timeframe = ?`,
        )
        .all(k, tf) as { ticker: string; fetched_at: string }[];
      for (const r of rows) {
        const at = Date.parse(r.fetched_at);
        if (Number.isFinite(at) && now - at < maxAgeMs) {
          checked.add(`${r.ticker.toUpperCase()}:${k}`);
        }
      }
    }
    const out = new Set<string>();
    for (const raw of tickers) {
      const t = raw.toUpperCase();
      if (kinds.some((k) => !checked.has(`${t}:${k}`))) out.add(t);
    }
    return out;
  } catch {
    return new Set(tickers.map((t) => t.toUpperCase()));
  }
}

export type ScanBatchResult = {
  tried: number;
  bbHits: number;
  tqHits: number;
  emaHits: number;
  athHits: number;
  high52Hits: number;
  ddHits: number;
  momHits: number;
  failed: number;
  remaining: number;
  bbTickers: string[];
  tqTickers: string[];
  emaTickers: string[];
  athTickers: string[];
  high52Tickers: string[];
  ddTickers: string[];
  momTickers: string[];
  /** Set when TQ cannot run because Nifty weekly OHLC failed to load. */
  error?: string;
};

/**
 * Scan a batch of tickers for BB/TQ/EMA/ATH/52W/DD/MOM (latest session only).
 */
export async function runSignalBatch(
  items: Array<{ ticker: string; market?: string | null }>,
  kind: ScanKind = "both",
  opts?: { concurrency?: number; bbTimeframe?: BbTimeframe },
): Promise<ScanBatchResult> {
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 4, 6));
  const bbTf = opts?.bbTimeframe ?? "weekly";
  const tickers = items
    .map((i) => ({
      ticker: i.ticker.toUpperCase(),
      market: i.market ?? null,
    }))
    .filter((i) => !isSkippableSymbol(i.ticker));

  const doBb = kind === "bb" || kind === "both" || kind === "all";
  const doTq = kind === "tq" || kind === "both" || kind === "all";
  const doEma = kind === "ema" || kind === "all";
  const doAth = kind === "ath" || kind === "all";
  const doHigh52 = kind === "high52" || kind === "all";
  const doDd = kind === "dd" || kind === "all";
  const doMom = kind === "mom" || kind === "all";
  const needDaily = doEma || doAth || doHigh52 || doMom;
  const needDailySession = doEma || doAth || doHigh52;
  const needWeekly = doTq || doDd || (doBb && bbTf === "weekly");

  const emptyResult = (error?: string): ScanBatchResult => ({
    tried: 0,
    bbHits: 0,
    tqHits: 0,
    emaHits: 0,
    athHits: 0,
    high52Hits: 0,
    ddHits: 0,
    momHits: 0,
    failed: tickers.length,
    remaining: 0,
    bbTickers: [],
    tqTickers: [],
    emaTickers: [],
    athTickers: [],
    high52Tickers: [],
    ddTickers: [],
    momTickers: [],
    ...(error ? { error } : {}),
  });

  const nifty = needWeekly ? await fetchNiftyWeeklyBars() : [];
  const sessionDate = nifty.length
    ? toTradingWeekFriday(nifty[nifty.length - 1]!.date)
    : null;

  const niftyDaily = needDailySession ? await fetchNiftyDailyBars() : [];
  const dailySession = niftyDaily.length
    ? niftyDaily[niftyDaily.length - 1]!.date.slice(0, 10)
    : null;

  if (doTq && !nifty.length) {
    return emptyResult("Nifty weekly data unavailable — retry TQ scan");
  }

  if (needDailySession && !dailySession) {
    return emptyResult("Nifty daily data unavailable — retry daily scan");
  }

  if (doBb) clearBbForTickers(tickers.map((t) => t.ticker), bbTf);
  if (doTq) clearTqForTickers(tickers.map((t) => t.ticker));
  if (doEma) clearEmaForTickers(tickers.map((t) => t.ticker));
  if (doAth) clearAthForTickers(tickers.map((t) => t.ticker));
  if (doHigh52) clearHigh52ForTickers(tickers.map((t) => t.ticker));
  if (doDd) clearDdForTickers(tickers.map((t) => t.ticker));
  if (doMom) clearMomForTickers(tickers.map((t) => t.ticker));

  const bbRows: Array<{
    ticker: string;
    market: string | null;
    signal: string;
    price: number;
    upper_band: number;
    signal_date: string;
  }> = [];
  const tqRows: Array<{
    ticker: string;
    market: string | null;
    score: number;
    crossover_type: string;
    crossover_score: number;
    signal_date: string;
  }> = [];
  const emaRows: Array<{
    ticker: string;
    market: string | null;
    price: number;
    ema10: number;
    ema20: number;
    ema50: number;
    ema200: number;
    signal_date: string;
  }> = [];
  const athRows: Array<{
    ticker: string;
    market: string | null;
    price: number;
    ath: number;
    signal_date: string;
  }> = [];
  const high52Rows: Array<{
    ticker: string;
    market: string | null;
    price: number;
    high_52w: number;
    signal_date: string;
  }> = [];
  const ddRows: Array<{
    ticker: string;
    market: string | null;
    price: number;
    open: number;
    high: number;
    low: number;
    signal_date: string;
  }> = [];
  const momRows: Array<{
    ticker: string;
    market: string | null;
    price: number;
    price_1y: number;
    price_1m: number;
    momentum_pct: number;
    signal_date: string;
  }> = [];
  let failed = 0;

  for (let i = 0; i < tickers.length; i += concurrency) {
    const chunk = tickers.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async ({ ticker, market }) => {
        try {
          let any = false;
          let weeklyBars: Bar[] | null = null;

          const loadWeekly = async () => {
            if (weeklyBars) return weeklyBars;
            weeklyBars = await fetchWeeklyBars(ticker, market, 2);
            return weeklyBars;
          };

          if (doTq) {
            const bars = await loadWeekly();
            if (bars.length >= 50) {
              const lastDate = toTradingWeekFriday(
                bars[bars.length - 1]!.date,
              );
              if (!sessionDate || lastDate === sessionDate) {
                any = true;
                const hit = analyzeTqWeekly(bars, nifty);
                if (
                  hit &&
                  hit.signal_date?.slice(0, 10) === (sessionDate || lastDate)
                ) {
                  tqRows.push({
                    ticker,
                    market,
                    score: hit.score,
                    crossover_type: hit.crossover_type,
                    crossover_score: hit.crossover_score,
                    signal_date: hit.signal_date,
                  });
                }
              }
            }
          }

          if (doDd) {
            const bars = await loadWeekly();
            if (bars.length >= 2) {
              const lastDate = toTradingWeekFriday(
                bars[bars.length - 1]!.date,
              );
              if (!sessionDate || lastDate === sessionDate) {
                any = true;
                const hit = analyzeDragonflyWeekly(bars);
                if (
                  hit &&
                  hit.signal_date.slice(0, 10) === (sessionDate || lastDate)
                ) {
                  ddRows.push({
                    ticker,
                    market,
                    price: hit.price,
                    open: hit.open,
                    high: hit.high,
                    low: hit.low,
                    signal_date: hit.signal_date,
                  });
                }
              }
            }
          }

          if (doBb) {
            const bars =
              bbTf === "monthly"
                ? await fetchMonthlyBars(ticker, market, 5)
                : await loadWeekly();
            if (bars.length >= 50) {
              const lastDate =
                bbTf === "monthly"
                  ? bars[bars.length - 1]!.date.slice(0, 10)
                  : toTradingWeekFriday(bars[bars.length - 1]!.date);
              const sessionOk =
                bbTf === "monthly" ||
                !sessionDate ||
                lastDate === sessionDate;
              if (sessionOk) {
                any = true;
                const hit = analyzeBbNewBreakout(bars, bbTf);
                if (hit && hit.signal_date?.slice(0, 10) === lastDate) {
                  bbRows.push({
                    ticker,
                    market,
                    signal: hit.signal,
                    price: hit.price,
                    upper_band: hit.upper_band,
                    signal_date: hit.signal_date!,
                  });
                }
              }
            }
          }

          if (needDaily) {
            // ATH needs long history; MOM/52W/EMA need ~2y — one fetch covers all.
            const yearsBack = doAth ? 25 : 2;
            const dailyBars = await fetchDailyBars(ticker, market, yearsBack);
            if (dailyBars.length >= 60) {
              const lastDay = dailyBars[dailyBars.length - 1]!.date.slice(0, 10);
              // MOM is a trailing 12−1 calc — run even if this name's last bar
              // lags the Nifty session (illiquid / holiday mismatches).
              if (doMom) {
                const hit = analyzeMomentumDaily(dailyBars);
                if (hit) {
                  any = true;
                  momRows.push({
                    ticker,
                    market,
                    price: hit.price,
                    price_1y: hit.price_1y,
                    price_1m: hit.price_1m,
                    momentum_pct: hit.momentum_pct,
                    signal_date: hit.signal_date,
                  });
                }
              }
              if (!dailySession || lastDay === dailySession) {
                any = true;
                if (doEma && dailyBars.length >= 200) {
                  const hit = analyzeEmaDaily(dailyBars);
                  if (
                    hit &&
                    hit.signal_date.slice(0, 10) === (dailySession || lastDay)
                  ) {
                    emaRows.push({
                      ticker,
                      market,
                      price: hit.price,
                      ema10: hit.ema10,
                      ema20: hit.ema20,
                      ema50: hit.ema50,
                      ema200: hit.ema200,
                      signal_date: hit.signal_date,
                    });
                  }
                }
                if (doAth) {
                  const hit = analyzeAthNew(dailyBars);
                  if (
                    hit &&
                    hit.signal_date.slice(0, 10) === (dailySession || lastDay)
                  ) {
                    athRows.push({
                      ticker,
                      market,
                      price: hit.price,
                      ath: hit.ath,
                      signal_date: hit.signal_date,
                    });
                  }
                }
                if (doHigh52) {
                  const hit = analyzeHigh52New(dailyBars);
                  if (
                    hit &&
                    hit.signal_date.slice(0, 10) === (dailySession || lastDay)
                  ) {
                    high52Rows.push({
                      ticker,
                      market,
                      price: hit.price,
                      high_52w: hit.high_52w,
                      signal_date: hit.signal_date,
                    });
                  }
                }
              }
            }
          }

          if (!any) failed += 1;
        } catch {
          failed += 1;
        }
      }),
    );
  }

  if (doBb) upsertBb(bbRows, bbTf);
  if (doTq) upsertTq(tqRows);
  if (doEma) upsertEma(emaRows);
  if (doAth) upsertAth(athRows);
  if (doHigh52) upsertHigh52(high52Rows);
  if (doDd) upsertDd(ddRows);
  if (doMom) upsertMom(momRows);
  const checks = scanKinds(kind).map((k) => ({
    kind: k,
    timeframe: kindTimeframe(k, bbTf),
  }));
  markChecked(
    tickers.map((t) => t.ticker),
    checks,
  );
  invalidateBreakoutCache();

  return {
    tried: tickers.length,
    bbHits: bbRows.length,
    tqHits: tqRows.length,
    emaHits: emaRows.length,
    athHits: athRows.length,
    high52Hits: high52Rows.length,
    ddHits: ddRows.length,
    momHits: momRows.filter((r) => r.momentum_pct > 0).length,
    failed,
    remaining: 0,
    bbTickers: bbRows.map((r) => r.ticker),
    tqTickers: tqRows.map((r) => r.ticker),
    emaTickers: emaRows.map((r) => r.ticker),
    athTickers: athRows.map((r) => r.ticker),
    high52Tickers: high52Rows.map((r) => r.ticker),
    ddTickers: ddRows.map((r) => r.ticker),
    momTickers: momRows.filter((r) => r.momentum_pct > 0).map((r) => r.ticker),
  };
}
