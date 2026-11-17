import fs from "fs";
import path from "path";
import { loadGovernanceFamilyMap } from "./governance-map";
import { inactiveListingTickers } from "./listing-sync";
import { fetchScreenerTopRatios, loadScreenerRatiosMap } from "./screener-ratios";
import { fetchScreenerQuarterlyFundamentals } from "./screener-quarters";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Nanocap Champs page: current holdings (named watchlist "nanocapchamps"),
 * past holdings (data/nanocap_champs_history.json) and NSE main-board stocks
 * that fit what the basket buys now — small, cheap, mostly independent board,
 * sales and profit up on last year's quarter.
 */

export const NANO_LIST_KEY = "nanocapchamps";
export const NANO_RULES = {
  minMcapCr: 100,
  maxMcapCr: 2000,
  maxPe: 12,
  minBoard: 4,
  minIndependentShare: 0.5,
  minLinkedBoards: 2,
  /** Latest reported quarter must end within this many days (about two quarters). */
  maxQuarterAgeDays: 200,
} as const;

/** Second kind of holding: larger, steady, group-backed, strong board (RPG Life type). */
export const QUALITY_RULES = {
  minMcapCr: 500,
  maxMcapCr: 5000,
  minBoard: 5,
  minIndependentShare: 0.5,
  minRoce: 0.15,
} as const;

type Quarter = { date: string; revenue: number | null; netIncome: number | null };

export type NanoStock = {
  ticker: string;
  name: string;
  market: string;
  mcap_cr: number | null;
  pe: number | null;
  roce: number | null;
  sales_yoy: number | null;
  profit_yoy: number | null;
  latest_quarter: string | null;
  board: number;
  independent: number;
  linked_boards: number;
  momentum_12m: number | null;
  group?: string | null;
  /** Latest quarter's net profit and the same quarter a year earlier (₹ Cr). */
  np_now?: number | null;
  np_year_ago?: number | null;
};

export type NanoStage = { label: string; in: string[]; out: string[] };

export type NanoPage = {
  basket: "nano";
  current: NanoStock[];
  past: Array<NanoStock & { sold_at: string }>;
  stages: NanoStage[];
  candidates: NanoStock[];
  coverage: { universe: number; with_quarters: number; missing: number; to_try: number };
  rules: typeof NANO_RULES;
  quality: NanoStock[];
  quality_coverage: { universe: number; with_roce: number; missing: number; to_try: number };
  quality_rules: typeof QUALITY_RULES;
};

const HISTORY_PATH = path.join(process.cwd(), "data", "nanocap_champs_history.json");

function readStages(): NanoStage[] {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) as { stages?: NanoStage[] };
    return raw.stages ?? [];
  } catch {
    return [];
  }
}

function pct(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return (a / b - 1) * 100;
}

/** Month index (year*12 + month) of a YYYY-MM-DD quarter end. */
function monthIdx(d: string): number {
  return Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
}

/**
 * Sales / profit YoY (latest quarter vs the same quarter a year earlier,
 * matched by date — stored quarters can have gaps) and TTM profit from four
 * consecutive quarters.
 */
function quarterStats(qs: Quarter[]) {
  const sorted = [...qs].sort((a, b) => a.date.localeCompare(b.date));
  const n = sorted.length;
  if (!n) {
    return { sales_yoy: null, profit_yoy: null, ttm_np: null, latest: null, np_now: null, np_year_ago: null };
  }
  const last = sorted[n - 1];
  const lastM = monthIdx(last.date);
  const yearAgo = sorted.find((q) => monthIdx(q.date) === lastM - 12) ?? null;
  const last4 = sorted.slice(-4);
  const consecutive =
    last4.length === 4 && monthIdx(last4[3].date) - monthIdx(last4[0].date) === 9;
  const ttm =
    consecutive && last4.every((q) => q.netIncome != null)
      ? last4.reduce((s, q) => s + (q.netIncome as number), 0)
      : null;
  return {
    sales_yoy: yearAgo ? pct(last.revenue, yearAgo.revenue) : null,
    profit_yoy: yearAgo ? pct(last.netIncome, yearAgo.netIncome) : null,
    ttm_np: ttm,
    latest: last.date,
    np_now: last.netIncome ?? null,
    np_year_ago: yearAgo?.netIncome ?? null,
  };
}

function loadQuarters(): Map<string, Quarter[]> {
  const out = new Map<string, Quarter[]>();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const rows = db
      .prepare(`SELECT ticker, quarters_json FROM screener_quarters_cache`)
      .all() as Array<{ ticker: string; quarters_json: string }>;
    for (const r of rows) {
      try {
        const qs = JSON.parse(r.quarters_json) as Quarter[];
        if (Array.isArray(qs) && qs.length) out.set(r.ticker.toUpperCase(), qs);
      } catch {
        /* skip bad row */
      }
    }
  } finally {
    db.close();
  }
  return out;
}

/** Market cap (₹ Cr): the fresher of the quote cache and Screener's top ratios. */
function loadMcap(): Map<string, number> {
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const best = new Map<string, { v: number; at: string }>();
    const take = (t: string, v: number, at: string) => {
      const k = t.toUpperCase();
      const cur = best.get(k);
      if (!cur || at > cur.at) best.set(k, { v, at });
    };
    for (const r of db
      .prepare(`SELECT ticker, market_cap_cr, fetched_at FROM stock_metrics WHERE market_cap_cr > 0`)
      .all() as Array<{ ticker: string; market_cap_cr: number; fetched_at: string }>) {
      take(r.ticker, r.market_cap_cr, r.fetched_at || "");
    }
    for (const r of db
      .prepare(`SELECT ticker, ratios_json, fetched_at FROM screener_ratios_cache`)
      .all() as Array<{ ticker: string; ratios_json: string; fetched_at: string }>) {
      try {
        const v = (JSON.parse(r.ratios_json) as { market_cap_cr?: number | null }).market_cap_cr;
        if (v != null && v > 0) take(r.ticker, v, r.fetched_at || "");
      } catch {
        /* skip */
      }
    }
    return new Map([...best].map(([k, x]) => [k, x.v]));
  } finally {
    db.close();
  }
}

function loadMomentum(): Map<string, number> {
  try {
    const db = openSqliteNamed("signals.db", { readonly: true, wal: true });
    try {
      const rows = db
        .prepare(
          `SELECT ticker, momentum_pct FROM mom_signals
           WHERE timeframe = 'daily' AND momentum_pct IS NOT NULL`,
        )
        .all() as Array<{ ticker: string; momentum_pct: number }>;
      return new Map(rows.map((r) => [r.ticker.toUpperCase(), r.momentum_pct]));
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}

type Board = { board: number; independent: number; linked: number };

function loadBoards(): Map<string, Board> {
  const out = new Map<string, Board>();
  const db = openSqliteNamed("governance.db", { readonly: true, wal: true });
  try {
    const seats = db
      .prepare(
        `SELECT UPPER(ticker) AS t, COUNT(*) AS n,
                -- Role text decides ("Non Independent" with space or hyphen);
                -- the category column only counts when the role is a plain title.
                SUM(CASE
                      WHEN LOWER(designation) LIKE '%non independent%'
                        OR LOWER(designation) LIKE '%non-independent%' THEN 0
                      WHEN LOWER(designation) LIKE '%independent%' THEN 1
                      WHEN LOWER(COALESCE(category, '')) = 'independent' THEN 1
                      ELSE 0 END) AS ind
         FROM board_seats
         WHERE NOT (LOWER(COALESCE(category, '') || ' ' || designation) LIKE '%kmp%'
                 OR LOWER(COALESCE(category, '') || ' ' || designation) LIKE '%cfo%'
                 OR LOWER(designation) LIKE '%chief financial%'
                 OR LOWER(designation) LIKE '%company secretary%'
                 OR LOWER(TRIM(COALESCE(category, ''))) = 'cs'
                 OR LOWER(TRIM(designation)) = 'cs')
         GROUP BY UPPER(ticker)`,
      )
      .all() as Array<{ t: string; n: number; ind: number }>;
    for (const s of seats) out.set(s.t, { board: s.n, independent: s.ind, linked: 0 });
    const linked = db
      .prepare(
        `SELECT UPPER(a.ticker) AS t, COUNT(DISTINCT b.ticker) AS n
         FROM board_seats a
         JOIN board_seats b ON b.person_id = a.person_id AND b.ticker <> a.ticker
         GROUP BY UPPER(a.ticker)`,
      )
      .all() as Array<{ t: string; n: number }>;
    for (const l of linked) {
      const cur = out.get(l.t);
      if (cur) cur.linked = l.n;
    }
  } finally {
    db.close();
  }
  return out;
}

function loadCompanies(): Map<string, { name: string; market: string }> {
  const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
  try {
    const rows = db
      .prepare(`SELECT UPPER(ticker) AS t, name, market FROM company_about`)
      .all() as Array<{ t: string; name: string | null; market: string | null }>;
    return new Map(rows.map((r) => [r.t, { name: r.name || r.t, market: r.market || "" }]));
  } finally {
    db.close();
  }
}

function loadCurrent(listKey: string = NANO_LIST_KEY): string[] {
  const db = openSqliteNamed("named_watchlists.db", { readonly: true, wal: true });
  try {
    return (
      db
        .prepare(`SELECT UPPER(ticker) AS t FROM named_watchlists WHERE list_key = ? ORDER BY ticker`)
        .all(listKey) as Array<{ t: string }>
    ).map((r) => r.t);
  } finally {
    db.close();
  }
}

export type Ctx = {
  quarters: Map<string, Quarter[]>;
  mcap: Map<string, number>;
  mom: Map<string, number>;
  boards: Map<string, Board>;
  cos: Map<string, { name: string; market: string }>;
  ratios: ReturnType<typeof loadScreenerRatiosMap>;
  groups: Map<string, string>;
};

export function buildStock(t: string, ctx: Ctx): NanoStock {
  const r = ctx.ratios.get(t);
  const mcap = ctx.mcap.get(t) ?? r?.market_cap_cr ?? null;
  const q = quarterStats(ctx.quarters.get(t) ?? []);
  const calc =
    mcap != null && q.ttm_np != null && q.ttm_np > 0 ? mcap / q.ttm_np : null;
  // P/E under 2 means the stored quarters are in a different unit (lakh rows).
  const pe = calc != null && calc >= 2 ? calc : r?.stock_pe ?? null;
  const b = ctx.boards.get(t);
  const co = ctx.cos.get(t);
  return {
    ticker: t,
    name: co?.name ?? t,
    market: co?.market ?? "",
    mcap_cr: mcap,
    pe: pe != null && Number.isFinite(pe) ? pe : null,
    roce: r?.roce ?? null,
    sales_yoy: q.sales_yoy,
    profit_yoy: q.profit_yoy,
    np_now: q.np_now,
    np_year_ago: q.np_year_ago,
    latest_quarter: q.latest,
    board: b?.board ?? 0,
    independent: b?.independent ?? 0,
    linked_boards: b?.linked ?? 0,
    momentum_12m: ctx.mom.get(t) ?? null,
    group: ctx.groups.get(t) ?? null,
  };
}

export function loadCtx(): Ctx {
  return {
    quarters: loadQuarters(),
    mcap: loadMcap(),
    mom: loadMomentum(),
    boards: loadBoards(),
    cos: loadCompanies(),
    ratios: loadScreenerRatiosMap(),
    groups: loadGroups(),
  };
}

/** Ticker → business group name (groups with 2+ listed companies). */
function loadGroups(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const g of loadGovernanceFamilyMap()) {
      if ((g.companies?.length ?? 0) < 2) continue;
      for (const c of g.companies) {
        const t = (c.ticker || "").trim().toUpperCase();
        if (t && !out.has(t)) out.set(t, g.family_name);
      }
    }
  } catch {
    /* groups optional */
  }
  return out;
}

/** NSE main-board group companies in the quality size band. */
function qualityUniverse(ctx: Ctx): string[] {
  const inactive = inactiveListingTickers();
  const out: string[] = [];
  for (const [t, co] of ctx.cos) {
    if (co.market !== "NSE" || inactive.has(t) || !ctx.groups.has(t)) continue;
    const m = ctx.mcap.get(t);
    if (m == null || m < QUALITY_RULES.minMcapCr || m > QUALITY_RULES.maxMcapCr) continue;
    out.push(t);
  }
  return out;
}

function fitsQuality(s: NanoStock): boolean {
  return (
    s.roce != null &&
    s.roce >= QUALITY_RULES.minRoce &&
    s.pe != null &&
    // P/E under 3: holding company or one-off gain, not real earnings.
    s.pe >= 3 &&
    s.sales_yoy != null &&
    s.sales_yoy > 0 &&
    s.board >= QUALITY_RULES.minBoard &&
    s.independent < s.board &&
    s.independent / s.board >= QUALITY_RULES.minIndependentShare &&
    recentQuarter(s.latest_quarter)
  );
}

/** NSE main-board tickers in the nanocap band (by stored market cap). */
function universe(ctx: Ctx): string[] {
  const inactive = inactiveListingTickers();
  const out: string[] = [];
  for (const [t, co] of ctx.cos) {
    if (co.market !== "NSE" || inactive.has(t)) continue;
    const m = ctx.mcap.get(t);
    if (m == null || m < NANO_RULES.minMcapCr || m > NANO_RULES.maxMcapCr) continue;
    out.push(t);
  }
  return out;
}

/** Latest quarter end that every company should have reported by now (60-day window). */
export function expectedQuarter(now = new Date()): string {
  const d = new Date(now.getTime() - 60 * 86_400_000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const qEndMonth = m >= 12 ? 12 : m >= 9 ? 9 : m >= 6 ? 6 : m >= 3 ? 3 : 0;
  if (qEndMonth === 0) return `${y - 1}-12-31`;
  const day = qEndMonth === 6 || qEndMonth === 9 ? 30 : 31;
  return `${y}-${String(qEndMonth).padStart(2, "0")}-${day}`;
}

export function recentQuarter(d: string | null): boolean {
  if (!d) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && Date.now() - t <= NANO_RULES.maxQuarterAgeDays * 86_400_000;
}

function fits(s: NanoStock): boolean {
  return (
    s.pe != null &&
    s.pe > 0 &&
    s.pe <= NANO_RULES.maxPe &&
    s.sales_yoy != null &&
    s.sales_yoy > 0 &&
    s.profit_yoy != null &&
    s.profit_yoy > 0 &&
    s.board >= NANO_RULES.minBoard &&
    // All-independent boards are missing category data, not a real board.
    s.independent < s.board &&
    s.independent / s.board >= NANO_RULES.minIndependentShare &&
    s.linked_boards >= NANO_RULES.minLinkedBoards &&
    recentQuarter(s.latest_quarter)
  );
}

export function buildNanoPage(): NanoPage {
  const ctx = loadCtx();
  const stages = readStages();
  const current = loadCurrent();
  const currentSet = new Set(current);

  const soldAt = new Map<string, string>();
  for (const st of stages) for (const t of st.out) soldAt.set(t, st.label);
  const past = [...soldAt.keys()]
    .filter((t) => !currentSet.has(t))
    .map((t) => ({ ...buildStock(t, ctx), sold_at: soldAt.get(t) as string }));

  const pastSet = new Set(past.map((p) => p.ticker));
  const uni = universe(ctx);
  const candidates = uni
    .filter((t) => !currentSet.has(t) && !pastSet.has(t))
    .map((t) => buildStock(t, ctx))
    .filter(fits)
    .sort(
      (a, b) =>
        b.linked_boards - a.linked_boards ||
        b.independent / b.board - a.independent / a.board ||
        (a.pe ?? 99) - (b.pe ?? 99),
    );

  const withQ = uni.filter((t) => (ctx.quarters.get(t)?.length ?? 0) >= 5).length;
  const triedNano = recentlyTried("nano");
  const triedQuality = recentlyTried("quality");
  const nanoToTry = uni.filter(
    (t) => (ctx.quarters.get(t)?.length ?? 0) < 5 && !triedNano.has(t),
  ).length;
  const candSet = new Set(candidates.map((c) => c.ticker));
  const qUni = qualityUniverse(ctx);
  const quality = qUni
    .filter((t) => !currentSet.has(t) && !pastSet.has(t) && !candSet.has(t))
    .map((t) => buildStock(t, ctx))
    .filter(fitsQuality)
    .sort((a, b) => (b.roce ?? 0) - (a.roce ?? 0));
  const withRoce = qUni.filter((t) => ctx.ratios.get(t)?.roce != null).length;
  const qualityToTry = qUni.filter(
    (t) => ctx.ratios.get(t)?.roce == null && !triedQuality.has(t),
  ).length;
  return {
    basket: "nano",
    current: current.map((t) => buildStock(t, ctx)),
    past,
    stages,
    candidates,
    coverage: {
      universe: uni.length,
      with_quarters: withQ,
      missing: uni.length - withQ,
      to_try: nanoToTry,
    },
    rules: NANO_RULES,
    quality,
    quality_coverage: {
      universe: qUni.length,
      with_roce: withRoce,
      missing: qUni.length - withRoce,
      to_try: qualityToTry,
    },
    quality_rules: QUALITY_RULES,
  };
}

/** Fetch quarterly results for nanocaps that have none yet (Screener, throttled). */
export type Progress = (done: number, total: number, filled: number) => void;
export type FillKind = "nano" | "quality" | "lv" | "fa" | "auto" | "hgscan" | "hgprice" | "mom" | "momratio";
export type FillResult = { tried: number; filled: number; left: number; not_found: number };

const RETRY_AFTER_DAYS = 7;

function withAttempts<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS nano_fill_attempts (
      ticker TEXT NOT NULL,
      kind TEXT NOT NULL,
      attempted_at TEXT NOT NULL,
      PRIMARY KEY (ticker, kind)
    )`);
    return fn(db);
  } finally {
    db.close();
  }
}

/** Tickers tried within the retry window (Screener had nothing) — skip them. */
export function recentlyTried(kind: FillKind): Set<string> {
  const since = new Date(Date.now() - RETRY_AFTER_DAYS * 86_400_000).toISOString();
  return withAttempts(
    (db) =>
      new Set(
        (
          db
            .prepare(`SELECT ticker FROM nano_fill_attempts WHERE kind = ? AND attempted_at >= ?`)
            .all(kind, since) as Array<{ ticker: string }>
        ).map((r) => r.ticker),
      ),
  );
}

export function markTried(kind: FillKind, ticker: string): void {
  withAttempts((db) =>
    db
      .prepare(
        `INSERT INTO nano_fill_attempts (ticker, kind, attempted_at) VALUES (?, ?, ?)
         ON CONFLICT(ticker, kind) DO UPDATE SET attempted_at = excluded.attempted_at`,
      )
      .run(ticker, kind, new Date().toISOString()),
  );
}

/**
 * Run one batch: skip names tried in the last week (so failures don't block
 * the queue), record every attempt, report how many are left to try.
 */
export async function runFill(
  kind: FillKind,
  missing: string[],
  limit: number,
  fetchOne: (t: string) => Promise<boolean>,
  onProgress?: Progress,
  shouldStop?: () => boolean,
): Promise<FillResult> {
  const tried = recentlyTried(kind);
  const todo = missing.filter((t) => !tried.has(t));
  const batch = todo.slice(0, limit);
  let filled = 0;
  let done = 0;
  onProgress?.(0, batch.length, 0);
  for (const t of batch) {
    if (shouldStop?.()) break;
    try {
      if (await fetchOne(t)) filled += 1;
    } catch (e) {
      // Screener paused us — stop without marking, so these names are retried.
      if (String(e).toLowerCase().includes("paused")) throw e;
    }
    markTried(kind, t);
    onProgress?.(++done, batch.length, filled);
  }
  return {
    tried: batch.length,
    filled,
    left: Math.max(0, todo.length - done),
    not_found: missing.length - todo.length + (batch.length - filled),
  };
}

/** Fetch quarterly results for nanocap-band stocks that have none yet. */
export function fillNanoQuarters(limit = 25, onProgress?: Progress): Promise<FillResult> {
  const ctx = loadCtx();
  const missing = universe(ctx).filter((t) => (ctx.quarters.get(t)?.length ?? 0) < 5);
  return runFill(
    "nano",
    missing,
    limit,
    async (t) => (await fetchScreenerQuarterlyFundamentals(t)).length >= 5,
    onProgress,
  );
}

/** Fetch ROCE (and quarters) for group companies in the quality band that lack it. */
export function fillQualityRatios(limit = 25, onProgress?: Progress): Promise<FillResult> {
  const ctx = loadCtx();
  const missing = qualityUniverse(ctx).filter((t) => ctx.ratios.get(t)?.roce == null);
  return runFill(
    "quality",
    missing,
    limit,
    async (t) => {
      const r = await fetchScreenerTopRatios(t, { force: true });
      if ((ctx.quarters.get(t)?.length ?? 0) < 5) await fetchScreenerQuarterlyFundamentals(t);
      return r.roce != null;
    },
    onProgress,
  );
}

export type NanoFillJob = {
  kind: FillKind;
  running: boolean;
  done: number;
  total: number;
  filled: number;
  left: number | null;
  /** Tried within the last week with no data on Screener. */
  not_found: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

// Kept on globalThis so a dev reload doesn't lose a running job.
const JOB_KEY = "__nanoFillJob";
type JobHolder = { [JOB_KEY]?: NanoFillJob };

export { loadCurrent };

export function nanoFillJob(): NanoFillJob | null {
  return (globalThis as JobHolder)[JOB_KEY] ?? null;
}

/** Start a background fill (25 stocks). Returns the running job if one is already going. */
export function startNanoFill(
  kind: FillKind,
  runner?: (onProgress: Progress) => Promise<FillResult>,
): NanoFillJob {
  const holder = globalThis as JobHolder;
  const cur = holder[JOB_KEY];
  if (cur?.running) return cur;
  const job: NanoFillJob = {
    kind,
    running: true,
    done: 0,
    total: 0,
    filled: 0,
    left: null,
    not_found: null,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  holder[JOB_KEY] = job;
  const onProgress: Progress = (done, total, filled) => {
    job.done = done;
    job.total = total;
    job.filled = filled;
  };
  const run = runner
    ? runner(onProgress)
    : kind === "quality"
      ? fillQualityRatios(25, onProgress)
      : fillNanoQuarters(25, onProgress);
  run
    .then((res) => {
      job.left = res.left;
      job.not_found = res.not_found;
    })
    .catch((e) => {
      job.error = String(e).toLowerCase().includes("paused")
        ? "Screener paused fetching for a while (too many requests). Try again later."
        : e instanceof Error
          ? e.message
          : String(e);
    })
    .finally(() => {
      job.running = false;
      job.finished_at = new Date().toISOString();
    });
  return job;
}
