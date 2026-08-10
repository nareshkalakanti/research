import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  adx,
  alignBars,
  bollingerBands,
  relativeStrength,
  rollingMean,
  rsi,
  supertrend,
  type Bar,
} from "./indicators";
import {
  fetchNiftyWeeklyBars,
  fetchWeeklyBars,
  isSkippableSymbol,
  toTradingWeekFriday,
} from "./ohlc";

const DATA_DIR = path.join(process.cwd(), "data");
const SIGNALS_PATH = path.join(DATA_DIR, "signals.db");
/** BB/TQ use the latest weekly bar only. */
const SIGNAL_TF = "weekly";

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

export type BreakoutFlags = {
  has_bb: boolean;
  has_tq: boolean;
  bb?: BbSignal;
  tq?: TqSignal;
};

let signalsDb: Database.Database | null = null;
let cache: { at: number; map: Map<string, BreakoutFlags> } | null = null;
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
  `);
  signalsDb = db;
  return db;
}

export function invalidateBreakoutCache(): void {
  cache = null;
}

/** Wipe BB/TQ hits + scan progress (full rescan from scratch). */
export function clearAllWeeklySignals(): void {
  const db = ensureDb();
  db.exec(`
    DELETE FROM bb_signals;
    DELETE FROM tq_signals;
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
} {
  let bb: string | null = null;
  let tq: string | null = null;
  for (const v of map.values()) {
    if (v.has_bb && v.bb?.signal_date) {
      const d = v.bb.signal_date.slice(0, 10);
      if (!bb || d > bb) bb = d;
    }
    if (v.has_tq && v.tq?.signal_date) {
      const d = v.tq.signal_date.slice(0, 10);
      if (!tq || d > tq) tq = d;
    }
  }
  return { bb, tq };
}

export function loadBreakoutMap(): Map<string, BreakoutFlags> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.map;

  const map = new Map<string, BreakoutFlags>();
  try {
    if (!fs.existsSync(SIGNALS_PATH)) {
      cache = { at: now, map };
      return map;
    }
    const db = ensureDb();

    const latestBb = (
      db
        .prepare(
          `SELECT MAX(signal_date) AS d FROM bb_signals
           WHERE signal = 'NEW_BREAKOUT' AND lower(timeframe) = ?`,
        )
        .get(SIGNAL_TF) as { d: string | null } | undefined
    )?.d;
    const latestTq = (
      db
        .prepare(
          `SELECT MAX(signal_date) AS d FROM tq_signals
           WHERE lower(timeframe) = ?
             AND crossover_type IS NOT NULL
             AND crossover_type != 'No Crossover'`,
        )
        .get(SIGNAL_TF) as { d: string | null } | undefined
    )?.d;

    // Drop older sessions so tags only ever show the latest day.
    if (latestBb) {
      db.prepare(
        `DELETE FROM bb_signals
         WHERE lower(timeframe) = ? AND (signal_date IS NULL OR signal_date < ?)`,
      ).run(SIGNAL_TF, latestBb.slice(0, 10));
    }
    if (latestTq) {
      db.prepare(
        `DELETE FROM tq_signals
         WHERE lower(timeframe) = ? AND (signal_date IS NULL OR signal_date < ?)`,
      ).run(SIGNAL_TF, latestTq.slice(0, 10));
    }

    const bbRows = db
      .prepare(
        `SELECT ticker, timeframe, signal, price, upper_band, signal_date
         FROM bb_signals
         WHERE signal = 'NEW_BREAKOUT' AND lower(timeframe) = ?`,
      )
      .all(SIGNAL_TF) as Array<{
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
      const cur = map.get(t) ?? { has_bb: false, has_tq: false };
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
      .all(SIGNAL_TF) as Array<{
      ticker: string;
      timeframe: string;
      score: number | null;
      crossover_type: string | null;
      signal_date: string | null;
    }>;
    for (const r of tqRows) {
      if (!isLatestSession(r.signal_date, latestTq ?? null)) continue;
      const t = r.ticker.toUpperCase();
      const cur = map.get(t) ?? { has_bb: false, has_tq: false };
      cur.has_tq = true;
      cur.tq = {
        timeframe: r.timeframe,
        score: r.score,
        crossover_type: r.crossover_type,
        signal_date: r.signal_date,
      };
      map.set(t, cur);
    }
  } catch {
    /* missing db */
  }

  cache = { at: now, map };
  return map;
}

export function breakoutCounts(map = loadBreakoutMap()): {
  bb: number;
  tq: number;
} {
  let bb = 0;
  let tq = 0;
  for (const v of map.values()) {
    if (v.has_bb) bb += 1;
    if (v.has_tq) tq += 1;
  }
  return { bb, tq };
}

export function analyzeBbWeekly(
  bars: Bar[],
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
  return {
    signal,
    price: Math.round(price * 100) / 100,
    upper_band: Math.round(u * 100) / 100,
    // Practical rule: weekly stamp = Friday of the NSE trading week.
    signal_date: toTradingWeekFriday(bars[i].date),
  };
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

function upsertBb(
  rows: Array<{
    ticker: string;
    market: string | null;
    signal: string;
    price: number;
    upper_band: number;
    signal_date: string;
  }>,
): number {
  if (!rows.length) return 0;
  const db = ensureDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO bb_signals (ticker, market, signal, timeframe, price, upper_band, signal_date, fetched_at)
    VALUES (@ticker, @market, @signal, '${SIGNAL_TF}', @price, @upper_band, @signal_date, @fetched_at)
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
      stmt.run({ ...r, fetched_at: now });
    }
  });
  tx(rows);
  return rows.length;
}

function clearBbForTickers(tickers: string[]): void {
  if (!tickers.length) return;
  const db = ensureDb();
  const placeholders = tickers.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM bb_signals WHERE timeframe = ? AND ticker IN (${placeholders})`,
  ).run(SIGNAL_TF, ...tickers.map((t) => t.toUpperCase()));
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
    VALUES (@ticker, '${SIGNAL_TF}', @market, @score, @crossover_type, @crossover_score, @signal_date, @fetched_at)
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
  ).run(SIGNAL_TF, ...tickers.map((t) => t.toUpperCase()));
}

function markChecked(tickers: string[], kinds: Array<"bb" | "tq">): void {
  if (!tickers.length || !kinds.length) return;
  const db = ensureDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO scan_checked (ticker, kind, timeframe, fetched_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ticker, kind, timeframe) DO UPDATE SET fetched_at = excluded.fetched_at
  `);
  const tx = db.transaction(() => {
    for (const t of tickers) {
      for (const k of kinds) stmt.run(t.toUpperCase(), k, SIGNAL_TF, now);
    }
  });
  tx();
}

export type ScanKind = "bb" | "tq" | "both";

export function uncheckedTickers(
  tickers: string[],
  kind: ScanKind,
  opts?: { maxAgeMs?: number },
): Set<string> {
  if (!tickers.length) return new Set();
  // Weekly bars — re-check within ~6 days.
  const maxAgeMs = opts?.maxAgeMs ?? 6 * 24 * 60 * 60 * 1000;
  try {
    if (!fs.existsSync(SIGNALS_PATH)) return new Set(tickers.map((t) => t.toUpperCase()));
    const db = ensureDb();
    const kinds =
      kind === "both" ? (["bb", "tq"] as const) : ([kind] as const);
    const checked = new Set<string>();
    const now = Date.now();
    for (const k of kinds) {
      const rows = db
        .prepare(
          `SELECT ticker, fetched_at FROM scan_checked WHERE kind = ? AND timeframe = ?`,
        )
        .all(k, SIGNAL_TF) as { ticker: string; fetched_at: string }[];
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
      if (kind === "both") {
        if (!checked.has(`${t}:bb`) || !checked.has(`${t}:tq`)) out.add(t);
      } else if (!checked.has(`${t}:${kind}`)) {
        out.add(t);
      }
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
  failed: number;
  remaining: number;
  /** Tickers that hit BB in this batch (new/refreshed). */
  bbTickers: string[];
  /** Tickers that hit TQ in this batch (new/refreshed). */
  tqTickers: string[];
};

/**
 * Scan a batch of tickers for BB NEW weekly and/or TQ weekly (latest week only).
 * Clears prior weekly signals for those tickers, then upserts fresh hits.
 */
export async function runSignalBatch(
  items: Array<{ ticker: string; market?: string | null }>,
  kind: ScanKind = "both",
  opts?: { concurrency?: number },
): Promise<ScanBatchResult> {
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 4, 6));
  const tickers = items
    .map((i) => ({
      ticker: i.ticker.toUpperCase(),
      market: i.market ?? null,
    }))
    .filter((i) => !isSkippableSymbol(i.ticker));

  const doBb = kind === "bb" || kind === "both";
  const doTq = kind === "tq" || kind === "both";

  // Nifty weekly → Friday stamp for the latest NSE trading week.
  const nifty = await fetchNiftyWeeklyBars();
  const sessionDate = nifty.length
    ? toTradingWeekFriday(nifty[nifty.length - 1].date)
    : null;

  if (doTq && !nifty.length) {
    return {
      tried: 0,
      bbHits: 0,
      tqHits: 0,
      failed: tickers.length,
      remaining: 0,
      bbTickers: [],
      tqTickers: [],
    };
  }

  if (doBb) clearBbForTickers(tickers.map((t) => t.ticker));
  if (doTq) clearTqForTickers(tickers.map((t) => t.ticker));

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
  let failed = 0;

  for (let i = 0; i < tickers.length; i += concurrency) {
    const chunk = tickers.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async ({ ticker, market }) => {
        try {
          const bars = await fetchWeeklyBars(ticker, market, 2);
          if (bars.length < 50) {
            failed += 1;
            return;
          }
          const lastDate = toTradingWeekFriday(bars[bars.length - 1].date);
          // Only accept signals from the latest NSE week (Friday stamp).
          if (sessionDate && lastDate !== sessionDate) {
            return;
          }
          if (doBb) {
            const hit = analyzeBbWeekly(bars);
            if (hit && hit.signal_date?.slice(0, 10) === (sessionDate || lastDate)) {
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
          if (doTq) {
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
        } catch {
          failed += 1;
        }
      }),
    );
  }

  if (doBb) upsertBb(bbRows);
  if (doTq) upsertTq(tqRows);
  const kinds: Array<"bb" | "tq"> =
    kind === "both" ? ["bb", "tq"] : [kind];
  markChecked(
    tickers.map((t) => t.ticker),
    kinds,
  );
  invalidateBreakoutCache();

  return {
    tried: tickers.length,
    bbHits: bbRows.length,
    tqHits: tqRows.length,
    failed,
    remaining: 0,
    bbTickers: bbRows.map((r) => r.ticker),
    tqTickers: tqRows.map((r) => r.ticker),
  };
}
