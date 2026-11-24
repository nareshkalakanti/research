/**
 * IndianAPI (stock.indianapi.in) → Sales 3Y / ROCE 3Y / P/B for Value fill.
 * Uses historical_stats (yoy + P&L stats + balance sheet) + /stock keyMetrics for P/B.
 */
import { openSqliteNamed } from "./sqlite-utils";
import type { HtCachedRow } from "./strategy/ht-types";
import { upsertHtIvRows } from "./strategy/ht-store";
import { roce3yFromAnnual, sales3yFromAnnual } from "./value-legs-math";

const BASE = "https://stock.indianapi.in";
const MIN_GAP_MS = 280;
export const INDIANAPI_STOCKS_PER_RUN = 100;
export const INDIANAPI_FILL_CONCURRENCY = 3;

const SALES3Y_MAX = 150;
const SALES3Y_MIN = -90;
const ROCE3Y_MAX = 150;
const ROCE3Y_MIN = -100;
const PB_MAX = 80;

export class IndianApiRateLimitError extends Error {
  constructor(message = "IndianAPI rate-limited") {
    super(message);
    this.name = "IndianApiRateLimitError";
  }
}

function apiKey(): string {
  return (process.env.STOCK_PRICE_API_KEY || "").trim();
}

export function indianApiConfigured(): boolean {
  return apiKey().length > 0;
}

let lastCallAt = 0;
async function throttle(): Promise<void> {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** Paced GET to IndianAPI (throws IndianApiRateLimitError on 429 / out of credits). */
export async function indianGet(path: string, query: Record<string, string>): Promise<unknown> {
  const key = apiKey();
  if (!key) throw new Error("STOCK_PRICE_API_KEY missing");
  await throttle();
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", "X-Api-Key": key },
    cache: "no-store",
  });
  if (res.status === 429) throw new IndianApiRateLimitError(`429 ${path}`);
  if (res.status === 401 || res.status === 403) {
    throw new Error(`IndianAPI auth ${res.status}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error || res.status)
        : `HTTP ${res.status}`;
    if (/rate.?limit|too many/i.test(msg)) throw new IndianApiRateLimitError(msg);
    throw new Error(msg);
  }
  return body;
}

type YearMap = Record<string, number | null | undefined>;

function fyEntries(series: YearMap | null | undefined): Array<{ period: string; value: number }> {
  if (!series || typeof series !== "object") return [];
  const out: Array<{ period: string; value: number }> = [];
  for (const [period, raw] of Object.entries(series)) {
    if (!/^(Mar|Jun|Sep|Dec) \d{4}$/i.test(period)) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    out.push({ period, value });
  }
  // Chronological by year then month order Mar→Jun→Sep→Dec.
  const monthRank: Record<string, number> = { Mar: 1, Jun: 2, Sep: 3, Dec: 4 };
  out.sort((a, b) => {
    const ya = Number(a.period.slice(-4));
    const yb = Number(b.period.slice(-4));
    if (ya !== yb) return ya - yb;
    return (monthRank[a.period.slice(0, 3)] ?? 0) - (monthRank[b.period.slice(0, 3)] ?? 0);
  });
  return out;
}

/** Prefer March FY columns (most common Indian year-end). */
function marchValues(series: YearMap | null | undefined): number[] {
  return fyEntries(series)
    .filter((e) => e.period.startsWith("Mar "))
    .map((e) => e.value);
}

function parsePct(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === "%" || s === "-" || s === "—") return null;
  const n = Number(s.replace(/%/g, "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function metricValue(
  groups: Record<string, Array<{ key?: string; value?: string }> | undefined> | null | undefined,
  key: string,
): number | null {
  if (!groups) return null;
  for (const rows of Object.values(groups)) {
    if (!Array.isArray(rows)) continue;
    const hit = rows.find((r) => (r.key || "") === key);
    if (hit) return parsePct(hit.value);
  }
  return null;
}

function sales3yFromPls(pls: Record<string, Record<string, string>> | null | undefined): number | null {
  const raw = pls?.["Compounded Sales Growth"]?.["3 Years:"];
  const n = parsePct(raw);
  if (n == null || n < SALES3Y_MIN || n > SALES3Y_MAX) return null;
  return n;
}

function sales3yFromYoy(yoy: Record<string, YearMap> | null | undefined): number | null {
  const sales = marchValues(yoy?.Sales ?? yoy?.Revenue);
  return sales3yFromAnnual(sales);
}

/**
 * ROCE ≈ Operating Profit / (Equity + Reserves + Borrowings), mean of last ≤3 FY.
 * Skip years with non-positive capital (negative equity names).
 */
function roce3yFromYoyBs(
  yoy: Record<string, YearMap> | null | undefined,
  bs: Record<string, YearMap> | null | undefined,
): number | null {
  const opSeries = yoy?.["Operating Profit"] ?? yoy?.["Financing Profit"];
  if (!opSeries || !bs) return null;
  const equity = bs["Equity Capital"];
  const reserves = bs.Reserves;
  const borrow = bs.Borrowings ?? bs.Borrowing;
  if (!equity || !reserves) return null;

  const years = fyEntries(opSeries)
    .filter((e) => e.period.startsWith("Mar "))
    .map((e) => e.period);
  const last = years.slice(-3);
  const vals: number[] = [];
  for (const y of last) {
    const op = Number(opSeries[y]);
    const e = Number(equity[y]);
    const r = Number(reserves[y]);
    const b = borrow?.[y] != null ? Number(borrow[y]) : 0;
    if (!Number.isFinite(op) || !Number.isFinite(e) || !Number.isFinite(r)) continue;
    const capital = e + r + (Number.isFinite(b) ? b : 0);
    if (capital <= 0) continue;
    const roce = (op / capital) * 100;
    if (!Number.isFinite(roce) || roce < ROCE3Y_MIN || roce > ROCE3Y_MAX) continue;
    vals.push(roce);
  }
  return roce3yFromAnnual(vals);
}

function pbFromKeyMetrics(keyMetrics: Record<string, unknown> | null | undefined): number | null {
  const n = metricValue(keyMetrics as Record<string, Array<{ key?: string; value?: string }>>, "priceToBookMostRecentFiscalYear");
  if (n == null || n <= 0 || n > PB_MAX) return null;
  return Math.round(n * 100) / 100;
}

function bookFromBs(bs: Record<string, YearMap> | null | undefined): number | null {
  if (!bs) return null;
  const equity = marchValues(bs["Equity Capital"]);
  const reserves = marchValues(bs.Reserves);
  if (!equity.length || !reserves.length) return null;
  const e = equity[equity.length - 1]!;
  const r = reserves[reserves.length - 1]!;
  const book = e + r;
  return book > 0 ? book : null;
}

export async function fetchIndianApiHtLegs(opts: {
  ticker: string;
  market?: string | null;
  name?: string | null;
  knownMcapCr?: number | null;
}): Promise<HtCachedRow> {
  const ticker = opts.ticker.toUpperCase();
  const now = new Date().toISOString();
  try {
    const stats = (await indianGet("/historical_stats", {
      stock_name: ticker,
      stats: "all",
    })) as {
      yoy_results?: Record<string, YearMap>;
      balancesheet?: Record<string, YearMap>;
      profit_loss_stats?: Record<string, Record<string, string>>;
      error?: string;
    };

    if (stats?.error) {
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
        detail: `indianapi:${stats.error}`.slice(0, 160),
        fetched_at: now,
      };
    }

    let sales = sales3yFromPls(stats.profit_loss_stats) ?? sales3yFromYoy(stats.yoy_results);
    let roce = roce3yFromYoyBs(stats.yoy_results, stats.balancesheet);
    let pb: number | null = null;
    let pe: number | null = null;
    let mcap = opts.knownMcapCr ?? null;

    // P/B + sanity cross-check from /stock when legs still thin.
    if (sales == null || roce == null || pb == null) {
      try {
        const stock = (await indianGet("/stock", { name: ticker })) as {
          keyMetrics?: Record<string, unknown>;
          stockDetailsReusableData?: { marketCap?: number | string };
        };
        pb = pbFromKeyMetrics(stock.keyMetrics);
        const mc = Number(stock.stockDetailsReusableData?.marketCap);
        if (Number.isFinite(mc) && mc > 0) mcap = mc;
        if (pb == null && mcap != null && mcap > 0) {
          const book = bookFromBs(stats.balancesheet);
          if (book != null && book > 0) {
            const computed = mcap / book;
            if (computed > 0 && computed <= PB_MAX) pb = Math.round(computed * 100) / 100;
          }
        }
        pe = metricValue(
          stock.keyMetrics as Record<string, Array<{ key?: string; value?: string }>>,
          "pPerEBasicExcludingExtraordinaryItemsTTM",
        );
      } catch (e) {
        if (e instanceof IndianApiRateLimitError) throw e;
      }
    }

    if (sales != null && (sales < SALES3Y_MIN || sales > SALES3Y_MAX)) sales = null;
    if (roce != null && (roce < ROCE3Y_MIN || roce > ROCE3Y_MAX)) roce = null;
    if (pb != null && (pb <= 0 || pb > PB_MAX)) pb = null;

    const ok = sales != null && roce != null && pb != null && pb > 0;
    const any = sales != null || roce != null || pb != null;
    return {
      ticker,
      market: opts.market ?? null,
      name: opts.name ?? null,
      price: null,
      market_cap_cr: mcap,
      sales_growth_3y: sales,
      earnings_growth_3y: null,
      roce_3y: roce,
      pb,
      pe_ratio: pe != null && pe > 0 ? pe : null,
      status: ok ? "ok" : any ? "partial" : "empty",
      detail: ok ? "indianapi:ok" : any ? "indianapi:partial" : "indianapi:empty",
      fetched_at: now,
    };
  } catch (e) {
    if (e instanceof IndianApiRateLimitError) throw e;
    const msg = e instanceof Error ? e.message.slice(0, 140) : "fetch failed";
    if (/429|rate.?limit|too many/i.test(msg)) throw new IndianApiRateLimitError(msg);
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
      detail: `indianapi:${msg}`,
      fetched_at: now,
    };
  }
}

function hasAnyLeg(row: HtCachedRow): boolean {
  return row.sales_growth_3y != null || row.roce_3y != null || (row.pb != null && row.pb > 0);
}

function rankable(row: HtCachedRow): boolean {
  return (
    row.status === "ok" &&
    row.sales_growth_3y != null &&
    row.roce_3y != null &&
    row.pb != null &&
    row.pb > 0
  );
}

/** Fill one stock into ht_iv_cache from IndianAPI. Throws on rate limit. */
export async function fillHtIvFromIndianApi(m: {
  ticker: string;
  market?: string | null;
  name?: string | null;
  knownMcapCr?: number | null;
}): Promise<boolean> {
  if (!indianApiConfigured()) return false;
  const row = await fetchIndianApiHtLegs(m);
  if (rankable(row)) {
    upsertHtIvRows([row]);
    return true;
  }
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
      /* write anyway */
    }
    upsertHtIvRows([row]);
    return hasAnyLeg(row);
  }
  return false;
}
