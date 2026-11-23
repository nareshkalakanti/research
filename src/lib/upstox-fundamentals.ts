/**
 * Upstox Fundamentals (Analytics Token — free, read-only).
 * Sales 3Y CAGR + ROCE 3Y (Yahoo-style: op / (assets − current liab)) + P/B.
 * Polite pacing under documented standard API limits (50/s · 500/min · 2000/30m).
 */
import { openSqliteNamed } from "./sqlite-utils";
import type { HtCachedRow } from "./strategy/ht-types";
import { upsertHtIvRows } from "./strategy/ht-store";

const BASE = "https://api.upstox.com/v2/fundamentals";
/** Stay well under 50/s and leave headroom for other callers. */
const MIN_GAP_MS = 350;
/** Cap per fill run so 30‑min budget (~2000) stays free-safe (~3 calls/stock). */
export const UPSTOX_STOCKS_PER_RUN = 120;

type StmtType = "consolidated" | "standalone";
type PeriodVal = { period: string; value: number };

export class UpstoxRateLimitError extends Error {
  constructor(message = "Upstox rate-limited") {
    super(message);
    this.name = "UpstoxRateLimitError";
  }
}

function token(): string {
  return (process.env.UPSTOX_ACCESS_TOKEN || "").trim();
}

export function upstoxConfigured(): boolean {
  return token().length > 0;
}

let lastCallAt = 0;
async function throttle(): Promise<void> {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** Shared GET for other Upstox Fundamentals callers (Napkin extras, etc.). */
export async function upstoxGet(path: string, query?: Record<string, string>): Promise<unknown> {
  const t = token();
  if (!t) throw new Error("UPSTOX_ACCESS_TOKEN missing");
  await throttle();
  const url = new URL(`${BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", Authorization: `Bearer ${t}` },
    cache: "no-store",
  });
  if (res.status === 429) throw new UpstoxRateLimitError(`429 ${path}`);
  const body = (await res.json().catch(() => null)) as {
    status?: string;
    data?: unknown;
    errors?: Array<{ message?: string; errorCode?: string }>;
  } | null;
  if (res.status === 401 || res.status === 403) {
    throw new Error(body?.errors?.[0]?.message || `Upstox auth ${res.status}`);
  }
  if (!res.ok || body?.status === "error") {
    const msg = body?.errors?.map((e) => e.message).filter(Boolean).join("; ") || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body?.data;
}

/** ISIN from governance companies (listing sync). */
export function isinForTicker(ticker: string): string | null {
  const t = ticker.trim().toUpperCase();
  if (!t) return null;
  try {
    const db = openSqliteNamed("governance.db", { readonly: true, wal: true });
    try {
      const row = db
        .prepare(
          `SELECT TRIM(isin) AS isin FROM companies
           WHERE UPPER(ticker) = ? AND isin IS NOT NULL AND TRIM(isin) <> ''`,
        )
        .get(t) as { isin: string } | undefined;
      const isin = row?.isin?.trim() || null;
      return isin && /^INE/i.test(isin) ? isin.toUpperCase() : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function parseYear(period: string): number | null {
  const m = /(\d{4})\s*$/.exec(period.trim());
  return m ? Number(m[1]) : null;
}

/** True when the newest year is older than ~18 months (same idea as Screener stale). */
function periodsStale(periods: string[]): boolean {
  const years = periods.map(parseYear).filter((y): y is number => y != null);
  if (!years.length) return true;
  const latest = Math.max(...years);
  const now = new Date();
  const fyNow = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return latest < fyNow - 1;
}

function historyFromCategory(
  income: { category?: string; history?: Array<{ period?: string; value?: number }> }[],
  category: string,
): PeriodVal[] {
  const cat = income.find((c) => c.category === category);
  const out: PeriodVal[] = [];
  for (const h of cat?.history || []) {
    if (!h.period || h.value == null || !Number.isFinite(h.value)) continue;
    out.push({ period: h.period, value: h.value });
  }
  return out;
}

function lineSeries(
  full: Array<{ particular?: string; history?: Array<{ period?: string; value?: number }> }> | undefined,
  particular: string,
): Map<string, number> {
  const map = new Map<string, number>();
  const row = (full || []).find((x) => (x.particular || "").trim() === particular);
  for (const h of row?.history || []) {
    if (!h.period || h.value == null || !Number.isFinite(h.value)) continue;
    map.set(h.period, h.value);
  }
  return map;
}

/** Reject tiny base years that explode CAGR (₹cr). */
const MIN_REV_CR = 1;
/** Ranking-safe bounds — outside → treat as unusable, not "ok". */
const SALES3Y_MAX = 150;
const SALES3Y_MIN = -90;
const ROCE3Y_MAX = 150;
const ROCE3Y_MIN = -100;
const PB_MAX = 80;

function sales3yCagr(rev: PeriodVal[]): number | null {
  const vals = rev.filter((r) => r.value > 0);
  if (vals.length < 2) return null;
  const latest = vals[0]!;
  const span = Math.min(3, vals.length - 1);
  const prior = vals[span]!;
  if (!prior || prior.value < MIN_REV_CR || latest.value < MIN_REV_CR) return null;
  // Cap absurd multiples (e.g. 0→something mis-scaled).
  if (latest.value / prior.value > 20 || prior.value / latest.value > 20) return null;
  const cagr = Math.round(((latest.value / prior.value) ** (1 / span) - 1) * 10000) / 100;
  if (cagr < SALES3Y_MIN || cagr > SALES3Y_MAX) return null;
  return cagr;
}

/** Same as Yahoo ht-fetch: mean of op / (assets − current liabilities) over up to 3 years. */
function roce3yFromStatements(
  op: PeriodVal[],
  assets: Map<string, number>,
  currLiab: Map<string, number>,
): number | null {
  const vals: number[] = [];
  for (const row of op.slice(0, 3)) {
    const a = assets.get(row.period);
    const cl = currLiab.get(row.period);
    if (a == null || cl == null) continue;
    const capital = a - cl;
    if (capital <= 0) continue;
    const roce = (row.value / capital) * 100;
    if (!Number.isFinite(roce) || roce < ROCE3Y_MIN || roce > ROCE3Y_MAX) continue;
    vals.push(roce);
  }
  if (!vals.length) return null;
  return Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 100) / 100;
}

function parsePb(raw: string | undefined): number | null {
  if (!raw || raw === "-" || raw === "—") return null;
  const n = Number(String(raw).replace(/%/g, "").replace(/,/g, "").trim());
  if (!Number.isFinite(n) || n <= 0 || n > PB_MAX) return null;
  return Math.round(n * 100) / 100;
}

/** True when all three legs are finite and inside ranking-safe bounds. */
export function upstoxLegsSane(
  sales3y: number | null,
  roce3y: number | null,
  pb: number | null,
): boolean {
  return (
    sales3y != null &&
    roce3y != null &&
    pb != null &&
    sales3y >= SALES3Y_MIN &&
    sales3y <= SALES3Y_MAX &&
    roce3y >= ROCE3Y_MIN &&
    roce3y <= ROCE3Y_MAX &&
    pb > 0 &&
    pb <= PB_MAX
  );
}

async function fetchIncome(isin: string, type: StmtType) {
  return (await upstoxGet(`/${encodeURIComponent(isin)}/income-statement`, {
    type,
    time_period: "yearly",
  })) as {
    income_statement?: Array<{ category?: string; history?: Array<{ period?: string; value?: number }> }>;
  };
}

async function fetchBalance(isin: string, type: StmtType) {
  return (await upstoxGet(`/${encodeURIComponent(isin)}/balance-sheet`, {
    type,
    fs: "true",
  })) as {
    full_statement?: Array<{ particular?: string; history?: Array<{ period?: string; value?: number }> }>;
  };
}

async function fetchKeyRatios(isin: string) {
  const data = (await upstoxGet(`/${encodeURIComponent(isin)}/key-ratios`)) as
    | Array<{ name?: string; company_value?: string }>
    | null;
  const map = new Map<string, string>();
  for (const r of data || []) {
    if (r.name && r.company_value != null) map.set(r.name, r.company_value);
  }
  return map;
}

async function legsFromType(
  isin: string,
  type: StmtType,
): Promise<{
  sales3y: number | null;
  roce3y: number | null;
  pb: number | null;
  pe: number | null;
  periods: string[];
  type: StmtType;
} | null> {
  // Sequential — shared throttle must not race under free-tier limits.
  const inc = await fetchIncome(isin, type);
  const bs = await fetchBalance(isin, type);
  const rev = historyFromCategory(inc.income_statement || [], "revenue");
  const op = historyFromCategory(inc.income_statement || [], "operating_profit");
  if (!rev.length) return null;
  const periods = rev.map((r) => r.period);
  const assets = lineSeries(bs.full_statement, "Total Assets");
  const currLiab = lineSeries(bs.full_statement, "Current Liabilities");
  const sales3y = sales3yCagr(rev);
  const roce3y = roce3yFromStatements(op, assets, currLiab);
  let pb: number | null = null;
  let pe: number | null = null;
  try {
    const kr = await fetchKeyRatios(isin);
    pb = parsePb(kr.get("P/B"));
    pe = parsePb(kr.get("P/E"));
  } catch {
    /* ratios optional — Sales/ROCE still useful */
  }
  return { sales3y, roce3y, pb, pe, periods, type };
}

/**
 * Prefer consolidated when recent; else standalone (demergers / stale cons).
 */
export async function fetchUpstoxHtLegs(opts: {
  ticker: string;
  market?: string | null;
  name?: string | null;
  knownMcapCr?: number | null;
  isin?: string | null;
}): Promise<HtCachedRow> {
  const ticker = opts.ticker.toUpperCase();
  const now = new Date().toISOString();
  const isin = (opts.isin || isinForTicker(ticker) || "").trim().toUpperCase();
  if (!isin) {
    return {
      ticker,
      market: opts.market ?? null,
      name: opts.name ?? null,
      price: null,
      market_cap_cr: opts.knownMcapCr ?? null,
      sales_growth_3y: null,
      earnings_growth_3y: null,
      roce_3y: null,
      pb: null,
      pe_ratio: null,
      status: "failed",
      detail: "upstox:no-isin",
      fetched_at: now,
    };
  }

  try {
    let legs = await legsFromType(isin, "consolidated");
    const consWeak =
      !legs ||
      periodsStale(legs.periods) ||
      legs.sales3y == null ||
      legs.roce3y == null;
    if (consWeak) {
      const stand = await legsFromType(isin, "standalone").catch(() => null);
      if (stand) {
        const standBetter =
          !legs ||
          (periodsStale(legs.periods) && !periodsStale(stand.periods)) ||
          ((legs.sales3y == null || legs.roce3y == null) &&
            stand.sales3y != null &&
            stand.roce3y != null);
        if (standBetter) legs = stand;
      }
    }

    if (!legs || (legs.sales3y == null && legs.roce3y == null && (legs.pb == null || legs.pb <= 0))) {
      return {
        ticker,
        market: opts.market ?? null,
        name: opts.name ?? null,
        price: null,
        market_cap_cr: opts.knownMcapCr ?? null,
        sales_growth_3y: null,
        earnings_growth_3y: null,
        roce_3y: null,
        pb: null,
        pe_ratio: null,
        status: "empty",
        detail: `upstox:${isin}:empty`,
        fetched_at: now,
      };
    }

    const sales =
      legs.sales3y != null && legs.sales3y >= SALES3Y_MIN && legs.sales3y <= SALES3Y_MAX
        ? legs.sales3y
        : null;
    const roce =
      legs.roce3y != null && legs.roce3y >= ROCE3Y_MIN && legs.roce3y <= ROCE3Y_MAX ? legs.roce3y : null;
    const pb = legs.pb != null && legs.pb > 0 && legs.pb <= PB_MAX ? legs.pb : null;
    const ok = upstoxLegsSane(sales, roce, pb);
    const any = sales != null || roce != null || pb != null;
    return {
      ticker,
      market: opts.market ?? null,
      name: opts.name ?? null,
      price: null,
      market_cap_cr: opts.knownMcapCr ?? null,
      // Persist per-leg when in bounds — Value merges Screener + HT per field.
      sales_growth_3y: sales,
      earnings_growth_3y: null,
      roce_3y: roce,
      pb,
      pe_ratio: ok ? legs.pe : null,
      status: ok ? "ok" : any ? "partial" : "empty",
      detail: ok
        ? `upstox:${isin}:${legs.type}`
        : any
          ? `upstox:${isin}:partial`
          : `upstox:${isin}:bad-legs`,
      fetched_at: now,
    };
  } catch (e) {
    if (e instanceof UpstoxRateLimitError) throw e;
    const msg = e instanceof Error ? e.message.slice(0, 160) : "fetch failed";
    if (/429|rate.?limit|too many/i.test(msg)) throw new UpstoxRateLimitError(msg);
    return {
      ticker,
      market: opts.market ?? null,
      name: opts.name ?? null,
      price: null,
      market_cap_cr: opts.knownMcapCr ?? null,
      sales_growth_3y: null,
      earnings_growth_3y: null,
      roce_3y: null,
      pb: null,
      pe_ratio: null,
      status: "failed",
      detail: `upstox:${isin}:${msg}`,
      fetched_at: now,
    };
  }
}

function rankable(row: HtCachedRow): boolean {
  return row.status === "ok" && upstoxLegsSane(row.sales_growth_3y, row.roce_3y, row.pb);
}

function hasAnyLeg(row: HtCachedRow): boolean {
  return row.sales_growth_3y != null || row.roce_3y != null || (row.pb != null && row.pb > 0);
}

/** Fill one stock into ht_iv_cache from Upstox. Throws on rate limit. */
export async function fillHtIvFromUpstox(m: {
  ticker: string;
  market?: string | null;
  name?: string | null;
  knownMcapCr?: number | null;
}): Promise<boolean> {
  if (!upstoxConfigured()) return false;
  const row = await fetchUpstoxHtLegs(m);
  if (rankable(row)) {
    upsertHtIvRows([row]);
    return true;
  }
  // Remember soft fails / partials so we don't re-hit soon — never clobber a prior rankable row.
  if (row.status === "failed" || row.status === "empty" || row.status === "partial") {
    try {
      const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
      try {
        const prev = db
          .prepare(
            `SELECT status, sales_growth_3y, roce_3y, pb FROM ht_iv_cache WHERE UPPER(ticker) = ?`,
          )
          .get(m.ticker.toUpperCase()) as
          | { status: string; sales_growth_3y: number | null; roce_3y: number | null; pb: number | null }
          | undefined;
        if (
          prev?.status === "ok" &&
          prev.sales_growth_3y != null &&
          prev.roce_3y != null &&
          prev.pb != null &&
          prev.pb > 0
        ) {
          return false;
        }
      } finally {
        db.close();
      }
    } catch {
      /* write fail marker anyway */
    }
    upsertHtIvRows([row]);
    return hasAnyLeg(row);
  }
  return false;
}
