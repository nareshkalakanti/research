import { adjustSplitJumps, fetchDailyBars, fetchGrowwDailyBarsOne } from "./ohlc";
import { yfSymbolCandidates } from "./yfinance";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Daily closes and volume for Sector Rotation and the Price Action screen,
 * cached on disk (data/rotation_bars.db, git-ignored) and in memory.
 *
 * Fresh = fetched after the last NSE close (15:30 IST), or within 6 h while the
 * market is open. A stale series is returned at once and refreshed in the
 * background (stale-while-revalidate), so the board never waits on Yahoo once
 * a stock has been seen. A failed fetch keeps the old series.
 */

/** `volume` is absent on series cached before volume was stored. */
export type Close = { date: string; close: number; volume?: number };

/** `volTried`: a refetch for volume already failed this run, so don't keep retrying. */
type Entry = { at: number; bars: Close[]; volTried?: boolean };

const mem = new Map<string, Entry>();
const INTRADAY_TTL_MS = 6 * 3_600_000;
/** No prices (Yahoo refused or symbol dead): try again after 30 min, in the background. */
const EMPTY_RETRY_MS = 30 * 60_000;
/** Yahoo throttles bursts — never more than this many chart calls at once. */
const MAX_YAHOO = 6;
const IST_MS = 5.5 * 3_600_000;

function withDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("rotation_bars.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS bars (
      key TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      n INTEGER NOT NULL,
      blob BLOB
    )`);
    return fn(db);
  } finally {
    db.close();
  }
}

/** [epochDay int32, close float32, volume float32] per bar (older rows: 8 bytes, no volume). */
const STRIDE = 12;
function pack(bars: Close[]): Buffer {
  const buf = Buffer.alloc(bars.length * STRIDE);
  bars.forEach((b, i) => {
    const o = i * STRIDE;
    buf.writeInt32LE(Math.round(Date.parse(`${b.date}T00:00:00Z`) / 86_400_000), o);
    buf.writeFloatLE(b.close, o + 4);
    buf.writeFloatLE(b.volume != null && Number.isFinite(b.volume) ? b.volume : 0, o + 8);
  });
  return buf;
}

function unpack(buf: Buffer | null, n: number): Close[] {
  if (!buf) return [];
  const stride = n > 0 && buf.length === n * STRIDE ? STRIDE : 8;
  const out: Close[] = [];
  for (let o = 0; o + stride <= buf.length; o += stride) {
    const b: Close = {
      date: new Date(buf.readInt32LE(o) * 86_400_000).toISOString().slice(0, 10),
      close: buf.readFloatLE(o + 4),
    };
    if (stride === STRIDE) b.volume = buf.readFloatLE(o + 8);
    out.push(b);
  }
  return out;
}

/** Stored before volume was kept: refetch once so the Price Action screen has volume. */
/** Newest bar date seen in any series: the latest session the market had. */
let newestDay = "";
function noteNewest(bars: Close[]): void {
  const d = bars[bars.length - 1]?.date;
  if (d && d > newestDay) newestDay = d;
}

const lacksVolume = (bars: Close[]) => bars.length >= 2 && bars[bars.length - 1]!.volume === undefined;

/** Last NSE close (15:30 IST on a weekday) at or before now, in ms. */
function lastCloseMs(now = Date.now()): number {
  const ist = new Date(now + IST_MS);
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 15, 30));
  let t = d.getTime() - IST_MS;
  if (t > now) t -= 86_400_000;
  for (;;) {
    const day = new Date(t + IST_MS).getUTCDay();
    if (day !== 0 && day !== 6) return t;
    t -= 86_400_000;
  }
}

function marketOpen(now = Date.now()): boolean {
  const ist = new Date(now + IST_MS);
  const day = ist.getUTCDay();
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day !== 0 && day !== 6 && m >= 9 * 60 + 15 && m <= 15 * 60 + 30;
}

function isFresh(e: Entry, now = Date.now()): boolean {
  // One close is a stub from the source, not a history: retry like an empty series.
  if (e.bars.length < 2) return now - e.at < EMPTY_RETRY_MS;
  if (!e.volTried && lacksVolume(e.bars)) return false;
  // Missing the latest session other stocks have (e.g. Yahoo's blank last close):
  // retry, at most every 30 min, so thinly traded stocks don't refetch on every call.
  const lastSession = new Date(lastCloseMs(now) + IST_MS).toISOString().slice(0, 10);
  const expected = newestDay < lastSession ? newestDay : lastSession;
  if (e.bars[e.bars.length - 1]!.date < expected && now - e.at >= EMPTY_RETRY_MS) return false;
  if (e.at >= lastCloseMs(now)) return !marketOpen(now) || now - e.at < INTRADAY_TTL_MS;
  return false;
}

const keyOf = (ticker: string, market: string | null | undefined, years: number) =>
  `${ticker.toUpperCase()}|${(market || "NSE").toUpperCase()}|${years}`;

function readDisk(key: string): Entry | null {
  try {
    return withDb((db) => {
      const r = db.prepare(`SELECT fetched_at, n, blob FROM bars WHERE key = ?`).get(key) as
        | { fetched_at: number; n: number; blob: Buffer | null }
        | undefined;
      return r ? { at: r.fetched_at, bars: unpack(r.blob, r.n) } : null;
    });
  } catch {
    return null;
  }
}

function writeDisk(key: string, e: Entry): void {
  try {
    withDb((db) =>
      db
        .prepare(
          `INSERT INTO bars (key, fetched_at, n, blob) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, n = excluded.n, blob = excluded.blob`,
        )
        .run(key, e.at, e.bars.length, pack(e.bars)),
    );
  } catch {
    /* memory copy still serves */
  }
}

const inflight = new Map<string, Promise<Close[]>>();

/**
 * Yahoo's public chart endpoint, called directly (no crumb / session). The
 * shared yahoo-finance2 session gets throttled after a few thousand calls and
 * then returns nothing; this endpoint keeps answering.
 */
async function chartCloses(symbol: string, years: number): Promise<Close[]> {
  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - Math.round(years * 365.25 * 86_400);
  const host = Math.random() < 0.5 ? "query1" : "query2";
  const res = await fetch(
    `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}`,
    { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(15_000), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`chart ${res.status}`);
  const j = (await res.json()) as {
    chart?: {
      result?: Array<{
        meta?: { regularMarketPrice?: number; regularMarketTime?: number };
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: Array<number | null>; volume?: Array<number | null> }> };
      }>;
    };
  };
  const r = j.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const cl = r?.indicators?.quote?.[0]?.close ?? [];
  const vol = r?.indicators?.quote?.[0]?.volume ?? [];
  const istDay = (sec: number) => new Date((sec + 5.5 * 3600) * 1000).toISOString().slice(0, 10);
  // Yahoo often leaves the latest day's close blank (volume present) until the
  // next update; its meta price for that same day fills it.
  const metaPx = r?.meta?.regularMarketPrice;
  const metaDay = r?.meta?.regularMarketTime ? istDay(r.meta.regularMarketTime) : "";
  const out: Close[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < ts.length; i++) {
    const date = istDay(ts[i]!);
    let c = cl[i];
    if (c == null && i === ts.length - 1 && date === metaDay && metaPx != null) c = metaPx;
    if (c == null || !Number.isFinite(c) || c <= 0) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    const v = vol[i];
    out.push({ date, close: c, volume: v != null && Number.isFinite(v) && v >= 0 ? v : 0 });
  }
  return out;
}

const isRecent = (bars: Close[]) =>
  Date.now() - Date.parse(`${bars.at(-1)?.date ?? "1970-01-01"}T12:00:00Z`) < 12 * 86_400_000;

/**
 * NSE SME: Yahoo's -SM.NS now returns a single close and bare .NS can be stale
 * or a different listing, so read the NSE board from Groww first.
 */
async function nseSmeCloses(ticker: string, years: number): Promise<Close[]> {
  const sym = ticker.trim().toUpperCase().replace(/-SM$/, "");
  const bars = await fetchGrowwDailyBarsOne(sym, "NSE", Math.ceil(years * 365.25));
  return bars.map((b) => ({ date: b.date, close: b.close, volume: b.volume ?? 0 }));
}

/** Primary symbol, then NSE / SME / BSE aliases; first with enough fresh history wins. */
async function directCloses(ticker: string, market: string | null | undefined, years: number): Promise<Close[]> {
  let best: Close[] = [];
  const mk = (market || "").trim().toUpperCase();
  if (mk === "NSE SME" || mk === "SME" || mk === "EMERGE") {
    best = await nseSmeCloses(ticker, years);
    if (best.length >= 2 && isRecent(best)) return best;
  }
  for (const sym of yfSymbolCandidates(ticker, market).slice(0, 4)) {
    try {
      const bars = await chartCloses(sym, years);
      if (bars.length >= 60 && isRecent(bars)) return bars;
      if (bars.length > best.length) best = bars;
    } catch {
      /* next alias */
    }
  }
  return best;
}

let running = 0;
const waiters: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_YAHOO) await new Promise<void>((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

async function fetchAndStore(key: string, ticker: string, market: string | null | undefined, years: number, prev: Entry | null) {
  let p = inflight.get(key);
  if (p) return p;
  p = (async () => {
    let bars: Close[] = [];
    try {
      bars = await slot(() => directCloses(ticker, market, years));
      // Rare: nothing on Yahoo's chart endpoint — the app-wide fetcher also tries Groww.
      if (!bars.length)
        bars = (await slot(() => fetchDailyBars(ticker, market, years))).map((b) => ({
          date: b.date,
          close: b.close,
          volume: b.volume ?? 0,
        }));
      else
        bars = adjustSplitJumps(
          bars.map((b) => ({ date: b.date, open: b.close, high: b.close, low: b.close, close: b.close, volume: b.volume ?? 0 })),
        ).map((b) => ({ date: b.date, close: b.close, volume: b.volume }));
    } catch {
      bars = [];
    }
    // Yahoo hiccup: keep what we had, retry later.
    if (bars.length < 2 && prev && prev.bars.length > bars.length) {
      const keep = { at: Date.now() - INTRADAY_TTL_MS + 30 * 60_000, bars: prev.bars, volTried: true };
      mem.set(key, keep);
      return prev.bars;
    }
    const e = { at: Date.now(), bars };
    noteNewest(bars);
    mem.set(key, e);
    writeDisk(key, e);
    return bars;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Background refreshes for stale series, a few at a time.
const queue: Array<() => Promise<unknown>> = [];
let active = 0;
const onIdle = new Set<() => void>();
function pump() {
  while (active < 4 && queue.length) {
    const job = queue.shift()!;
    active++;
    void job().finally(() => {
      active--;
      if (!active && !queue.length) onIdle.forEach((fn) => fn());
      pump();
    });
  }
}
const queued = new Set<string>();

/** Called once the background refresh queue drains (e.g. drop cached ranks). */
export function onRotationBarsRefreshed(fn: () => void): void {
  onIdle.add(fn);
}

/** Stored closes only — never fetches. Empty when nothing is cached yet. */
export function cachedRotationCloses(ticker: string, market: string | null | undefined, years: number): Close[] {
  preload();
  const key = keyOf(ticker, market, years);
  return (mem.get(key) ?? readDisk(key))?.bars ?? [];
}

export function rotationBarsRefreshing(): number {
  return queue.length + active;
}

let preloaded = false;
/** Load every stored series into memory once (one read instead of one per stock). */
function preload(): void {
  if (preloaded) return;
  preloaded = true;
  try {
    withDb((db) => {
      for (const r of db.prepare(`SELECT key, fetched_at, n, blob FROM bars`).all() as Array<{
        key: string;
        fetched_at: number;
        n: number;
        blob: Buffer | null;
      }>)
        if (!mem.has(r.key)) {
          const bars = unpack(r.blob, r.n);
          noteNewest(bars);
          mem.set(r.key, { at: r.fetched_at, bars });
        }
    });
  } catch {
    /* empty cache */
  }
}

/** Cached daily closes; fetches only when nothing is stored yet. */
export async function rotationCloses(ticker: string, market: string | null | undefined, years: number): Promise<Close[]> {
  preload();
  const key = keyOf(ticker, market, years);
  let e = mem.get(key) ?? null;
  if (!e) {
    e = readDisk(key);
    if (e) mem.set(key, e);
  }
  if (e && isFresh(e)) return e.bars;
  if (e) {
    if (!queued.has(key)) {
      queued.add(key);
      const prev = e;
      queue.push(() => fetchAndStore(key, ticker, market, years, prev).finally(() => queued.delete(key)));
      pump();
    }
    return e.bars;
  }
  return fetchAndStore(key, ticker, market, years, null);
}
