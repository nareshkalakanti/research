import {
  buildStock,
  loadCtx,
  loadCurrent,
  recentQuarter,
  type Ctx,
  type FillResult,
  type NanoStock,
  type Progress,
} from "./nanocap-champs";
import { inactiveListingTickers } from "./listing-sync";
import { fetchDailyBars } from "./ohlc";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Fallen Angels — our own recovery screen (inspired by Lotusdew's basket,
 * whose picks are tracked as holdings). Fallen companies (40%+ below their
 * 3-year high, off the low) that show a real turn in the numbers, ranked by a
 * 0–100 score: recovery 50 · governance 30 · price 20. Surveillance lists
 * (ASM / GSM) are shown as a label, insolvency (IBC) cases excluded.
 */

export const FA_LIST_KEY = "fallenangels";
export const FA_ENTRY_DATE = "2025-06-30";
export const FA_TOP_N = 10;

export const FA_RULES = {
  minMcapCr: 100,
  maxMcapCr: 5000,
  minSalesYoy: 5,
  minBoard: 5,
  minIndependentShare: 1 / 3,
  /** Price at least this far below its 3-year high. */
  minFallPct: 40,
  /** …and at least this far above its 1-year low (turning). */
  minBouncePct: 15,
} as const;

export type Surveillance = { list: "LTASM" | "STASM" | "GSM"; stage: string; desc: string };

export type ScorePart = { label: string; points: number; max: number };

export type FaStock = NanoStock & {
  surveillance: Surveillance | null;
  since_entry_pct?: number | null;
  from_high_pct?: number | null;
  from_low_pct?: number | null;
  /** "Turned profitable" / "Loss narrowed" / "+42%" — vs same quarter last year. */
  profit_trend: string | null;
  /** Quarters in a row (latest first) with profit better than a year earlier. */
  improving_quarters: number;
  score: number | null;
  score_parts: ScorePart[];
};

export type FaPage = {
  basket: "fa";
  current: FaStock[];
  /** On an NSE surveillance list today — the strategy as Lotusdew runs it. */
  on_list: FaStock[];
  /** Recovering the same way but not on a list (top N). */
  candidates: FaStock[];
  /** Shortlist (numbers pass) and how many have a fresh price check. */
  shortlist: number;
  price_checked: number;
  price_checked_at: string | null;
  surveillance_total: number;
  surveillance_at: string | null;
  rules: typeof FA_RULES;
};

const NSE = (process.env.NSE_ORIGIN || "https://www.nseindia.in").replace(/\/+$/, "");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REFRESH_MS = 12 * 3_600_000;
const PRICE_MAX_AGE_MS = 3 * 86_400_000;

function withSurvDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS nse_surveillance (
      symbol TEXT PRIMARY KEY,
      list TEXT NOT NULL,
      stage TEXT,
      descr TEXT,
      fetched_at TEXT NOT NULL
    )`);
    return fn(db);
  } finally {
    db.close();
  }
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${NSE}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: `${NSE}/reports/asm` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`NSE ${path} ${res.status}`);
  return res.json();
}

/** Today's NSE ASM (long / short term) and GSM lists; cached 12h in metrics.db. */
export async function loadSurveillance(): Promise<{ map: Map<string, Surveillance>; at: string | null }> {
  const cached = withSurvDb((db) =>
    db.prepare(`SELECT symbol, list, stage, descr, fetched_at FROM nse_surveillance`).all() as Array<{
      symbol: string;
      list: Surveillance["list"];
      stage: string | null;
      descr: string | null;
      fetched_at: string;
    }>,
  );
  const at = cached[0]?.fetched_at ?? null;
  if (!at || Date.now() - Date.parse(at) > REFRESH_MS) {
    try {
      type Row = { symbol?: string; survCode?: string; survDesc?: string; asmSurvIndicator?: string; gsmStage?: string };
      const asm = (await getJson("/api/reportASM")) as { longterm?: { data?: Row[] }; shortterm?: { data?: Row[] } };
      const gsm = (await getJson("/api/reportGSM")) as Row[];
      const rows: Array<[string, Surveillance]> = [];
      for (const r of asm.longterm?.data ?? []) {
        if (r.symbol) rows.push([r.symbol, { list: "LTASM", stage: r.asmSurvIndicator || "", desc: r.survDesc || "" }]);
      }
      for (const r of asm.shortterm?.data ?? []) {
        if (r.symbol) rows.push([r.symbol, { list: "STASM", stage: r.asmSurvIndicator || "", desc: r.survDesc || "" }]);
      }
      for (const r of Array.isArray(gsm) ? gsm : []) {
        if (r.symbol) rows.push([r.symbol, { list: "GSM", stage: r.survCode || r.gsmStage || "", desc: r.survDesc || "" }]);
      }
      if (rows.length > 20) {
        const now = new Date().toISOString();
        withSurvDb((db) => {
          const tx = db.transaction(() => {
            db.prepare(`DELETE FROM nse_surveillance`).run();
            const ins = db.prepare(
              `INSERT OR REPLACE INTO nse_surveillance (symbol, list, stage, descr, fetched_at) VALUES (?, ?, ?, ?, ?)`,
            );
            for (const [sym, s] of rows) ins.run(sym.toUpperCase(), s.list, s.stage, s.desc, now);
            // Daily snapshot so "came off the list" can be told later.
            db.exec(`CREATE TABLE IF NOT EXISTS nse_surveillance_history (
              day TEXT NOT NULL, symbol TEXT NOT NULL, list TEXT NOT NULL, stage TEXT,
              PRIMARY KEY (day, symbol)
            )`);
            const day = now.slice(0, 10);
            const hist = db.prepare(
              `INSERT OR REPLACE INTO nse_surveillance_history (day, symbol, list, stage) VALUES (?, ?, ?, ?)`,
            );
            for (const [sym, s] of rows) hist.run(day, sym.toUpperCase(), s.list, s.stage);
          });
          tx();
        });
        return { map: new Map(rows.map(([sym, s]) => [sym.toUpperCase(), s])), at: now };
      }
    } catch {
      /* fall back to the cached list */
    }
  }
  return {
    map: new Map(cached.map((r) => [r.symbol, { list: r.list, stage: r.stage || "", desc: r.descr || "" }])),
    at,
  };
}


// ---- Price check (3-year high / 1-year low), cached in metrics.db ----------

export type PriceRow = { since: number | null; fromHigh: number | null; fromLow: number | null; at: string };

function withPriceDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS fa_price (
      ticker TEXT PRIMARY KEY,
      since_entry REAL,
      from_high REAL,
      from_low REAL,
      checked_at TEXT NOT NULL
    )`);
    return fn(db);
  } finally {
    db.close();
  }
}

export function loadPrices(): Map<string, PriceRow> {
  return withPriceDb(
    (db) =>
      new Map(
        (
          db.prepare(`SELECT ticker, since_entry, from_high, from_low, checked_at FROM fa_price`).all() as Array<{
            ticker: string;
            since_entry: number | null;
            from_high: number | null;
            from_low: number | null;
            checked_at: string;
          }>
        ).map((r) => [r.ticker, { since: r.since_entry, fromHigh: r.from_high, fromLow: r.from_low, at: r.checked_at }]),
      ),
  );
}

export async function checkPrice(t: string): Promise<PriceRow> {
  const at = new Date().toISOString();
  let row: PriceRow = { since: null, fromHigh: null, fromLow: null, at };
  try {
    const bars = (await fetchDailyBars(t, "NSE", 3)) as Array<{ date: string; close: number; high: number; low: number }>;
    if (bars.length) {
      const last = bars.at(-1)!.close;
      const entry = bars.filter((b) => b.date <= FA_ENTRY_DATE).at(-1)?.close ?? null;
      const hi = Math.max(...bars.map((b) => b.high));
      const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
      const lows = bars.filter((b) => b.date >= yearAgo).map((b) => b.low).filter((x) => x > 0);
      const lo = lows.length ? Math.min(...lows) : null;
      row = {
        since: entry ? (last / entry - 1) * 100 : null,
        fromHigh: hi > 0 ? (last / hi - 1) * 100 : null,
        fromLow: lo ? (last / lo - 1) * 100 : null,
        at,
      };
    }
  } catch {
    /* keep nulls */
  }
  withPriceDb((db) =>
    db
      .prepare(
        `INSERT INTO fa_price (ticker, since_entry, from_high, from_low, checked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ticker) DO UPDATE SET since_entry = excluded.since_entry, from_high = excluded.from_high,
           from_low = excluded.from_low, checked_at = excluded.checked_at`,
      )
      .run(t, row.since, row.fromHigh, row.fromLow, row.at),
  );
  return row;
}

// ---- Numbers: recovery evidence ---------------------------------------------

type Q = { date: string; revenue: number | null; netIncome: number | null };
const mIdx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));

/** Quarters in a row (latest first) whose profit beat the same quarter a year earlier. */
function improvingQuarters(qs: Q[] | undefined): number {
  if (!qs?.length) return 0;
  const sorted = [...qs].sort((a, b) => a.date.localeCompare(b.date));
  const byM = new Map(sorted.map((q) => [mIdx(q.date), q]));
  let n = 0;
  for (let i = sorted.length - 1; i >= 0 && n < 4; i--) {
    const q = sorted[i]!;
    const prev = byM.get(mIdx(q.date) - 12);
    if (!prev || q.netIncome == null || prev.netIncome == null || !(q.netIncome > prev.netIncome)) break;
    n += 1;
  }
  return n;
}

function profitTrend(s: NanoStock): string | null {
  const a = s.np_year_ago;
  const b = s.np_now;
  if (a == null || b == null) return s.profit_yoy != null ? `${s.profit_yoy > 0 ? "+" : ""}${Math.round(s.profit_yoy)}%` : null;
  if (a < 0 && b > 0) return "Turned profitable";
  if (a < 0 && b < 0) return b > a ? "Loss narrowed" : "Loss widened";
  if (a >= 0 && b < 0) return "Turned to loss";
  if (a > 0) {
    const p = (b / a - 1) * 100;
    return `${p > 0 ? "+" : ""}${p > 999 ? ">999" : Math.round(p)}%`;
  }
  return null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** Linear 0..max between a (0 points) and b (full points). */
const ramp = (x: number | null | undefined, a: number, b: number, max: number) =>
  x == null || !Number.isFinite(x) ? 0 : Math.round(clamp((x - a) / (b - a), 0, 1) * max);

/** 0–100: recovery 50 · governance 30 · price 20. */
function scoreStock(s: FaStock): { score: number; parts: ScorePart[] } {
  const trend = s.profit_trend || "";
  // Recovery 50 — checked against Lotusdew's picks: the winners were the ones
  // whose results had turned; a strong board alone did not save the losers.
  const turnPts =
    trend === "Turned profitable"
      ? 16
      : trend === "Loss narrowed"
        ? 8
        : /^\+/.test(trend)
          ? ramp(trend.startsWith("+>") ? 999 : s.profit_yoy, 0, 100, 16)
          : 0;
  const parts: ScorePart[] = [
    { label: "Sales growth", points: ramp(s.sales_yoy, 5, 50, 18), max: 18 },
    { label: "Profit turn", points: turnPts, max: 16 },
    { label: "Quarters improving", points: Math.round((Math.min(s.improving_quarters, 3) * 16) / 3), max: 16 },
    // Governance 30
    {
      label: "Independent board",
      points: s.board ? ramp(s.independent / s.board, 1 / 3, 2 / 3, 15) : 0,
      max: 15,
    },
    { label: "Well-connected directors", points: ramp(s.linked_boards, 0, 8, 10), max: 10 },
    { label: "Board size", points: s.board >= 8 ? 5 : s.board >= 6 ? 3 : s.board >= 5 ? 2 : 0, max: 5 },
    // Price 20
    { label: "Depth of fall", points: ramp(-(s.from_high_pct ?? 0), 40, 80, 10), max: 10 },
    { label: "Bounce off low", points: ramp(s.from_low_pct, 15, 60, 10), max: 10 },
  ];
  return { score: parts.reduce((n, p) => n + p.points, 0), parts };
}

function toFa(t: string, ctx: Ctx, surv: Map<string, Surveillance>, price?: PriceRow): FaStock {
  const s = buildStock(t, ctx);
  const fa: FaStock = {
    ...s,
    surveillance: surv.get(t) ?? null,
    since_entry_pct: price?.since ?? null,
    from_high_pct: price?.fromHigh ?? null,
    from_low_pct: price?.fromLow ?? null,
    profit_trend: profitTrend(s),
    improving_quarters: improvingQuarters(ctx.quarters.get(t) as Q[] | undefined),
    score: null,
    score_parts: [],
  };
  if (price) {
    const sc = scoreStock(fa);
    fa.score = sc.score;
    fa.score_parts = sc.parts;
  }
  return fa;
}

const isIbc = (s: Surveillance | undefined | null) => !!s && /ibc|insolvency/i.test(`${s.stage} ${s.desc}`);

/** Stage 1 — numbers only (fast): size, board, real recovery in the results. */
function shortlist(ctx: Ctx, surv: Map<string, Surveillance>, exclude: Set<string>): string[] {
  const inactive = inactiveListingTickers();
  const out: string[] = [];
  for (const [t, co] of ctx.cos) {
    if (co.market !== "NSE" || inactive.has(t) || exclude.has(t) || isIbc(surv.get(t))) continue;
    const m = ctx.mcap.get(t);
    if (m == null || m < FA_RULES.minMcapCr || m > FA_RULES.maxMcapCr) continue;
    const s = buildStock(t, ctx);
    if (s.sales_yoy == null || s.sales_yoy < FA_RULES.minSalesYoy) continue;
    if (s.np_now == null || s.np_year_ago == null || !(s.np_now > s.np_year_ago)) continue;
    if (!recentQuarter(s.latest_quarter)) continue;
    if (s.board < FA_RULES.minBoard || s.independent >= s.board) continue;
    if (s.independent / s.board < FA_RULES.minIndependentShare) continue;
    out.push(t);
  }
  return out;
}

export async function buildFaPage(): Promise<FaPage> {
  const ctx = loadCtx();
  const { map: surv, at } = await loadSurveillance();
  const prices = loadPrices();
  const current = loadCurrent(FA_LIST_KEY);
  const currentSet = new Set(current);

  // Holdings: always fresh price (8 names, cached in memory by the bar loader).
  const holdings: FaStock[] = [];
  for (const t of current) {
    const p = await checkPrice(t);
    holdings.push(toFa(t, ctx, surv, p));
  }
  holdings.sort((a, b) => (b.since_entry_pct ?? -999) - (a.since_entry_pct ?? -999));

  const short = shortlist(ctx, surv, currentSet);
  const fresh = (t: string) => {
    const p = prices.get(t);
    return p && Date.now() - Date.parse(p.at) < PRICE_MAX_AGE_MS ? p : undefined;
  };
  const checked = short.filter((t) => fresh(t));
  const ranked = checked
    .map((t) => toFa(t, ctx, surv, fresh(t)))
    .filter(
      (s) =>
        s.from_high_pct != null &&
        s.from_high_pct <= -FA_RULES.minFallPct &&
        s.from_low_pct != null &&
        s.from_low_pct >= FA_RULES.minBouncePct,
    )
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const onList = ranked.filter((s) => s.surveillance);
  const candidates = ranked.filter((s) => !s.surveillance).slice(0, FA_TOP_N);
  const lastAt = checked.map((t) => fresh(t)!.at).sort().at(-1) ?? null;

  return {
    basket: "fa",
    current: holdings,
    on_list: onList,
    candidates,
    shortlist: short.length,
    price_checked: checked.length,
    price_checked_at: lastAt,
    surveillance_total: surv.size,
    surveillance_at: at,
    rules: FA_RULES,
  };
}

/** Background job: price-check the shortlist (bars for 3-year high / 1-year low). */
export async function runFaPriceCheck(onProgress?: Progress): Promise<FillResult> {
  const ctx = loadCtx();
  const { map: surv } = await loadSurveillance();
  const prices = loadPrices();
  const todo = shortlist(ctx, surv, new Set(loadCurrent(FA_LIST_KEY))).filter((t) => {
    const p = prices.get(t);
    return !p || Date.now() - Date.parse(p.at) >= PRICE_MAX_AGE_MS;
  });
  let done = 0;
  let filled = 0;
  onProgress?.(0, todo.length, 0);
  for (let i = 0; i < todo.length; i += 4) {
    const wave = await Promise.all(todo.slice(i, i + 4).map((t) => checkPrice(t)));
    for (const r of wave) {
      done += 1;
      if (r.fromHigh != null) filled += 1;
    }
    onProgress?.(done, todo.length, filled);
  }
  return { tried: todo.length, filled, left: 0, not_found: todo.length - filled };
}
