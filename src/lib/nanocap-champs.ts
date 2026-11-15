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
  minQuarter: "2026-06-30",
} as const;

/** Second kind of holding: larger, steady, group-backed, strong board (RPG Life type). */
export const QUALITY_RULES = {
  minMcapCr: 500,
  maxMcapCr: 5000,
  minBoard: 5,
  minIndependentShare: 2 / 3,
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
};

export type NanoStage = { label: string; in: string[]; out: string[] };

export type NanoPage = {
  current: NanoStock[];
  past: Array<NanoStock & { sold_at: string }>;
  stages: NanoStage[];
  candidates: NanoStock[];
  coverage: { universe: number; with_quarters: number; missing: number };
  rules: typeof NANO_RULES;
  quality: NanoStock[];
  quality_coverage: { universe: number; with_roce: number; missing: number };
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

/** Sales / profit YoY (latest quarter vs same quarter last year) and TTM profit. */
function quarterStats(qs: Quarter[]) {
  const sorted = [...qs].sort((a, b) => a.date.localeCompare(b.date));
  const n = sorted.length;
  if (!n) return { sales_yoy: null, profit_yoy: null, ttm_np: null, latest: null };
  const last = sorted[n - 1];
  const yearAgo = n >= 5 ? sorted[n - 5] : null;
  const last4 = sorted.slice(-4);
  const ttm =
    last4.length === 4 && last4.every((q) => q.netIncome != null)
      ? last4.reduce((s, q) => s + (q.netIncome as number), 0)
      : null;
  return {
    sales_yoy: yearAgo ? pct(last.revenue, yearAgo.revenue) : null,
    profit_yoy: yearAgo ? pct(last.netIncome, yearAgo.netIncome) : null,
    ttm_np: ttm,
    latest: last.date,
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

function loadMcap(): Map<string, number> {
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const rows = db
      .prepare(`SELECT ticker, market_cap_cr FROM stock_metrics WHERE market_cap_cr > 0`)
      .all() as Array<{ ticker: string; market_cap_cr: number }>;
    return new Map(rows.map((r) => [r.ticker.toUpperCase(), r.market_cap_cr]));
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
                SUM(CASE WHEN LOWER(COALESCE(category, '') || ' ' || designation)
                         LIKE '%independent%'
                         AND LOWER(COALESCE(category, '') || ' ' || designation)
                         NOT LIKE '%non-independent%'
                    THEN 1 ELSE 0 END) AS ind
         FROM board_seats GROUP BY UPPER(ticker)`,
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

function loadCurrent(): string[] {
  const db = openSqliteNamed("named_watchlists.db", { readonly: true, wal: true });
  try {
    return (
      db
        .prepare(`SELECT UPPER(ticker) AS t FROM named_watchlists WHERE list_key = ? ORDER BY ticker`)
        .all(NANO_LIST_KEY) as Array<{ t: string }>
    ).map((r) => r.t);
  } finally {
    db.close();
  }
}

type Ctx = {
  quarters: Map<string, Quarter[]>;
  mcap: Map<string, number>;
  mom: Map<string, number>;
  boards: Map<string, Board>;
  cos: Map<string, { name: string; market: string }>;
  ratios: ReturnType<typeof loadScreenerRatiosMap>;
  groups: Map<string, string>;
};

function buildStock(t: string, ctx: Ctx): NanoStock {
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
    latest_quarter: q.latest,
    board: b?.board ?? 0,
    independent: b?.independent ?? 0,
    linked_boards: b?.linked ?? 0,
    momentum_12m: ctx.mom.get(t) ?? null,
    group: ctx.groups.get(t) ?? null,
  };
}

function loadCtx(): Ctx {
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
    (s.latest_quarter ?? "") >= NANO_RULES.minQuarter
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
    (s.latest_quarter ?? "") >= NANO_RULES.minQuarter
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
  const candSet = new Set(candidates.map((c) => c.ticker));
  const qUni = qualityUniverse(ctx);
  const quality = qUni
    .filter((t) => !currentSet.has(t) && !pastSet.has(t) && !candSet.has(t))
    .map((t) => buildStock(t, ctx))
    .filter(fitsQuality)
    .sort((a, b) => (b.roce ?? 0) - (a.roce ?? 0));
  const withRoce = qUni.filter((t) => ctx.ratios.get(t)?.roce != null).length;
  return {
    current: current.map((t) => buildStock(t, ctx)),
    past,
    stages,
    candidates,
    coverage: { universe: uni.length, with_quarters: withQ, missing: uni.length - withQ },
    rules: NANO_RULES,
    quality,
    quality_coverage: { universe: qUni.length, with_roce: withRoce, missing: qUni.length - withRoce },
    quality_rules: QUALITY_RULES,
  };
}

/** Fetch quarterly results for nanocaps that have none yet (Screener, throttled). */
type Progress = (done: number, total: number, filled: number) => void;

export async function fillNanoQuarters(
  limit = 25,
  onProgress?: Progress,
): Promise<{ tried: number; filled: number; left: number }> {
  const ctx = loadCtx();
  const missing = universe(ctx).filter((t) => (ctx.quarters.get(t)?.length ?? 0) < 5);
  const batch = missing.slice(0, limit);
  let filled = 0;
  let done = 0;
  onProgress?.(0, batch.length, 0);
  for (const t of batch) {
    try {
      const qs = await fetchScreenerQuarterlyFundamentals(t);
      if (qs.length >= 5) filled += 1;
    } catch (e) {
      if (String(e).toLowerCase().includes("paused")) throw e;
    }
    onProgress?.(++done, batch.length, filled);
  }
  return { tried: batch.length, filled, left: Math.max(0, missing.length - filled) };
}

/** Fetch ROCE (and quarters) for group companies in the quality band that lack it. */
export async function fillQualityRatios(
  limit = 25,
  onProgress?: Progress,
): Promise<{ tried: number; filled: number; left: number }> {
  const ctx = loadCtx();
  const missing = qualityUniverse(ctx).filter((t) => ctx.ratios.get(t)?.roce == null);
  const batch = missing.slice(0, limit);
  let filled = 0;
  let done = 0;
  onProgress?.(0, batch.length, 0);
  for (const t of batch) {
    try {
      const r = await fetchScreenerTopRatios(t, { force: true });
      if (r.roce != null) filled += 1;
      if ((ctx.quarters.get(t)?.length ?? 0) < 5) await fetchScreenerQuarterlyFundamentals(t);
    } catch (e) {
      if (String(e).toLowerCase().includes("paused")) throw e;
    }
    onProgress?.(++done, batch.length, filled);
  }
  return { tried: batch.length, filled, left: Math.max(0, missing.length - filled) };
}


export type NanoFillJob = {
  kind: "nano" | "quality";
  running: boolean;
  done: number;
  total: number;
  filled: number;
  left: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

// Kept on globalThis so a dev reload doesn't lose a running job.
const JOB_KEY = "__nanoFillJob";
type JobHolder = { [JOB_KEY]?: NanoFillJob };

export function nanoFillJob(): NanoFillJob | null {
  return (globalThis as JobHolder)[JOB_KEY] ?? null;
}

/** Start a background fill (25 stocks). Returns the running job if one is already going. */
export function startNanoFill(kind: "nano" | "quality"): NanoFillJob {
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
  const run = kind === "quality" ? fillQualityRatios(25, onProgress) : fillNanoQuarters(25, onProgress);
  run
    .then((res) => {
      job.left = res.left;
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
