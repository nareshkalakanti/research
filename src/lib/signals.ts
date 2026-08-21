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

const DATA_DIR = path.join(process.cwd(), "data");
const SIGNALS_PATH = path.join(DATA_DIR, "signals.db");
/** TQ uses the latest weekly bar only. */
const TQ_TF = "weekly";
/** Daily EMA stack (10/20/50/200) — latest session only. */
const EMA_TF = "daily";

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

export type BreakoutFlags = {
  has_bb: boolean;
  has_tq: boolean;
  has_ema: boolean;
  bb?: BbSignal;
  tq?: TqSignal;
  ema?: EmaSignal;
};

let signalsDb: Database.Database | null = null;
let cache: {
  at: number;
  map: Map<string, BreakoutFlags>;
  bbTf: BbTimeframe;
} | null = null;
const CACHE_MS = 5_000;

function ensureDb(): Database.Database {
  if (signalsDb) return signalsDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(SIGNALS_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
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
  `);
  signalsDb = db;
  return db;
}

export function invalidateBreakoutCache(): void {
  cache = null;
}

/** Wipe BB/TQ/EMA hits + scan progress (full rescan from scratch). */
export function clearAllWeeklySignals(): void {
  const db = ensureDb();
  db.exec(`
    DELETE FROM bb_signals;
    DELETE FROM tq_signals;
    DELETE FROM ema_signals;
    DELETE FROM scan_checked;
  `);
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
} {
  let bb: string | null = null;
  let tq: string | null = null;
  let ema: string | null = null;
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
  }
  return { bb, tq, ema };
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
      const cur = map.get(t) ?? { has_bb: false, has_tq: false, has_ema: false };
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
      const cur = map.get(t) ?? { has_bb: false, has_tq: false, has_ema: false };
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
      const cur = map.get(t) ?? { has_bb: false, has_tq: false, has_ema: false };
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
  } catch {
    /* missing db */
  }

  cache = { at: now, map, bbTf };
  return map;
}

export function breakoutCounts(map = loadBreakoutMap()): {
  bb: number;
  tq: number;
  ema: number;
} {
  let bb = 0;
  let tq = 0;
  let ema = 0;
  for (const v of map.values()) {
    if (v.has_bb) bb += 1;
    if (v.has_tq) tq += 1;
    if (v.has_ema) ema += 1;
  }
  return { bb, tq, ema };
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
  const db = ensureDb();
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
}

function clearBbForTickers(tickers: string[], timeframe: BbTimeframe): void {
  if (!tickers.length) return;
  const db = ensureDb();
  const placeholders = tickers.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM bb_signals WHERE timeframe = ? AND ticker IN (${placeholders})`,
  ).run(timeframe, ...tickers.map((t) => t.toUpperCase()));
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
  const db = ensureDb();
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
}

function clearTqForTickers(tickers: string[]): void {
  if (!tickers.length) return;
  const db = ensureDb();
  const placeholders = tickers.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM tq_signals WHERE timeframe = ? AND ticker IN (${placeholders})`,
  ).run(TQ_TF, ...tickers.map((t) => t.toUpperCase()));
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
  const db = ensureDb();
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
}

function clearEmaForTickers(tickers: string[]): void {
  if (!tickers.length) return;
  const db = ensureDb();
  const placeholders = tickers.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM ema_signals WHERE timeframe = ? AND ticker IN (${placeholders})`,
  ).run(EMA_TF, ...tickers.map((t) => t.toUpperCase()));
}

function markChecked(
  tickers: string[],
  checks: Array<{ kind: "bb" | "tq" | "ema"; timeframe: string }>,
): void {
  if (!tickers.length || !checks.length) return;
  const db = ensureDb();
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
}

export type ScanKind = "bb" | "tq" | "ema" | "both" | "all";

function scanKinds(kind: ScanKind): Array<"bb" | "tq" | "ema"> {
  if (kind === "all") return ["bb", "tq", "ema"];
  if (kind === "both") return ["bb", "tq"];
  return [kind];
}

function kindTimeframe(
  k: "bb" | "tq" | "ema",
  bbTimeframe: BbTimeframe = "weekly",
): string {
  if (k === "ema") return EMA_TF;
  if (k === "bb") return bbTimeframe;
  return TQ_TF;
}

function kindMaxAgeMs(k: "bb" | "tq" | "ema"): number {
  return k === "ema" ? 24 * 60 * 60 * 1000 : 6 * 24 * 60 * 60 * 1000;
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
  failed: number;
  remaining: number;
  bbTickers: string[];
  tqTickers: string[];
  emaTickers: string[];
};

/**
 * Scan a batch of tickers for BB/TQ weekly and/or daily EMA stack (latest session only).
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

  const nifty = doTq ? await fetchNiftyWeeklyBars() : [];
  const sessionDate = nifty.length
    ? toTradingWeekFriday(nifty[nifty.length - 1].date)
    : null;

  const niftyDaily = doEma ? await fetchNiftyDailyBars() : [];
  const dailySession = niftyDaily.length
    ? niftyDaily[niftyDaily.length - 1].date.slice(0, 10)
    : null;

  if (doTq && !nifty.length) {
    return {
      tried: 0,
      bbHits: 0,
      tqHits: 0,
      emaHits: 0,
      failed: tickers.length,
      remaining: 0,
      bbTickers: [],
      tqTickers: [],
      emaTickers: [],
    };
  }

  if (doEma && !dailySession) {
    return {
      tried: 0,
      bbHits: 0,
      tqHits: 0,
      emaHits: 0,
      failed: tickers.length,
      remaining: 0,
      bbTickers: [],
      tqTickers: [],
      emaTickers: [],
    };
  }

  if (doBb) clearBbForTickers(tickers.map((t) => t.ticker), bbTf);
  if (doTq) clearTqForTickers(tickers.map((t) => t.ticker));
  if (doEma) clearEmaForTickers(tickers.map((t) => t.ticker));

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
  let failed = 0;

  for (let i = 0; i < tickers.length; i += concurrency) {
    const chunk = tickers.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async ({ ticker, market }) => {
        try {
          let any = false;

          if (doTq) {
            const weeklyBars = await fetchWeeklyBars(ticker, market, 2);
            if (weeklyBars.length >= 50) {
              const lastDate = toTradingWeekFriday(
                weeklyBars[weeklyBars.length - 1].date,
              );
              if (!sessionDate || lastDate === sessionDate) {
                any = true;
                const hit = analyzeTqWeekly(weeklyBars, nifty);
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

          if (doBb) {
            const bars =
              bbTf === "monthly"
                ? await fetchMonthlyBars(ticker, market, 5)
                : await fetchWeeklyBars(ticker, market, 2);
            if (bars.length >= 50) {
              const lastDate =
                bbTf === "monthly"
                  ? bars[bars.length - 1].date.slice(0, 10)
                  : toTradingWeekFriday(bars[bars.length - 1].date);
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

          if (doEma) {
            const dailyBars = await fetchDailyBars(ticker, market, 2);
            if (dailyBars.length >= 200) {
              const lastDay = dailyBars[dailyBars.length - 1].date.slice(0, 10);
              if (!dailySession || lastDay === dailySession) {
                any = true;
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
    failed,
    remaining: 0,
    bbTickers: bbRows.map((r) => r.ticker),
    tqTickers: tqRows.map((r) => r.ticker),
    emaTickers: emaRows.map((r) => r.ticker),
  };
}
