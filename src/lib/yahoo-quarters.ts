/**
 * Yahoo quarterly income — PEAD2-style field picks + stub trim.
 * Uses yahoo-finance2 `fundamentalsTimeSeries` (JS stand-in for
 * `yf.Ticker(...).quarterly_income_stmt`).
 */
import YahooFinance from "yahoo-finance2";
import {
  trimReportedQuarters,
  type QuarterPoint,
} from "./quarter-panel";
import { fetchNseQuarterlyFundamentals } from "./nse-quarters";
import { fetchBseQuarterlyByTicker } from "./bse-quarters";
import { fetchScreenerQuarterlyFundamentals, mergeScreenerQuarterOverlay } from "./screener-quarters";
import { toYfinanceSymbol, yfSymbolCandidates } from "./yfinance";

export type { QuarterPoint };

/** PEAD REVENUE_FIELDS → Yahoo camelCase keys. */
const REVENUE_FIELDS = [
  "totalRevenue",
  "operatingRevenue",
  "revenue",
] as const;

/** PEAD EBIDT_FIELDS (+ pretax fallbacks). */
const EBIDT_FIELDS = [
  "operatingIncome",
  "EBIT",
  "EBITDA",
  "operatingIncomeOrLoss",
  "pretaxIncome",
  "netIncomeContinuousOperations",
] as const;

/** PEAD NET_INCOME_FIELDS. */
const NET_INCOME_FIELDS = [
  "netIncome",
  "netIncomeCommonStockholders",
  "netIncomeFromContinuingOperationNetMinorityInterest",
  "dilutedNIAvailtoComStockholders",
] as const;

/** PEAD EPS_FIELDS. */
const EPS_FIELDS = [
  "dilutedEPS",
  "basicEPS",
  "dilutedEPSIncludingExtraItems",
  "basicEPSIncludingExtraItems",
] as const;

const OTHER_INCOME_FIELDS = [
  "otherNonOperatingIncomeExpenses",
  "otherIncomeExpense",
  "otherIncome",
] as const;

const CFO_FIELDS = [
  "operatingCashFlow",
  "cashFlowFromContinuingOperatingActivities",
  "cashFlowFromOperations",
] as const;

const CFO_NP_FIELDS = [
  "netIncomeFromContinuingOperations",
  "netIncome",
  "netIncomeCommonStockholders",
] as const;

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

/** Allow limited parallel Yahoo calls (global mutex was ~1 req / 200ms). */
const YAHOO_MAX_CONCURRENT = 6;
const YAHOO_START_GAP_MS = 60;
let yahooActive = 0;
let lastYahooStart = 0;

async function withYahooThrottle<T>(fn: () => Promise<T>): Promise<T> {
  while (yahooActive >= YAHOO_MAX_CONCURRENT) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const now = Date.now();
  const wait = YAHOO_START_GAP_MS - (now - lastYahooStart);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastYahooStart = Date.now();
  yahooActive += 1;
  try {
    return await fn();
  } finally {
    yahooActive -= 1;
  }
}

function toDateStr(d: Date | string | number): string {
  const x = new Date(d);
  if (!Number.isFinite(x.getTime())) return "";
  return x.toISOString().slice(0, 10);
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickField(
  row: Record<string, unknown>,
  fields: readonly string[],
): number | null {
  for (const f of fields) {
    const v = num(row[f]);
    if (v != null) return v;
  }
  return null;
}

export type OperatingCashflowHit = {
  cfo: number;
  /** Same-period NP from the cash-flow row (used for annual fallback). */
  netIncome: number | null;
  period: "quarterly" | "annual";
};

async function fetchCashflowSeries(
  symbol: string,
  type: "quarterly" | "annual",
): Promise<Array<Record<string, unknown>>> {
  const period1 = new Date();
  period1.setFullYear(period1.getFullYear() - 4);
  try {
    return await withYahooThrottle(async () => {
      const ft = await yf.fundamentalsTimeSeries(symbol, {
        period1: toDateStr(period1),
        type,
        module: "cash-flow",
      });
      return Array.isArray(ft) ? (ft as Array<Record<string, unknown>>) : [];
    });
  } catch {
    return [];
  }
}

function bestCashflowFromSeries(
  series: Array<Record<string, unknown>>,
  period: "quarterly" | "annual",
): OperatingCashflowHit | null {
  let best: { date: string; cfo: number; netIncome: number | null } | null =
    null;
  for (const row of series) {
    const date = toDateStr(row.date as Date);
    if (!date) continue;
    const cfo = pickField(row, CFO_FIELDS);
    if (cfo == null) continue;
    const netIncome = pickField(row, CFO_NP_FIELDS);
    if (!best || date.localeCompare(best.date) > 0) {
      best = { date, cfo, netIncome };
    }
  }
  if (!best) return null;
  return { cfo: best.cfo, netIncome: best.netIncome, period };
}

/** Latest operating cash flow — quarterly first, then annual. */
async function fetchLatestOperatingCashflow(
  symbol: string,
): Promise<OperatingCashflowHit | null> {
  if (!symbol) return null;
  const quarterly = bestCashflowFromSeries(
    await fetchCashflowSeries(symbol, "quarterly"),
    "quarterly",
  );
  if (quarterly) return quarterly;
  return bestCashflowFromSeries(
    await fetchCashflowSeries(symbol, "annual"),
    "annual",
  );
}

export async function fetchQuarterlyFundamentals(
  ticker: string,
  market?: string | null,
  opts?: {
    skipChart?: boolean;
    screenerForce?: boolean;
    /** Skip Screener live/cache overlay (bulk Fill Quarters — avoid throttle hangs). */
    skipScreener?: boolean;
  },
): Promise<{
  quarters: QuarterPoint[];
  price: number | null;
  ret_3m_pct: number | null;
  symbol: string;
  source: "yahoo" | "nse" | "bse" | "screener" | "yahoo+screener" | "none";
  /** Latest operating cash flow (Yahoo cash-flow module). */
  operating_cashflow: number | null;
  /** NP paired with CFO when annual cash-flow fallback is used (same units). */
  operating_cashflow_np: number | null;
}> {
  const symbol = toYfinanceSymbol(ticker, market);
  if (!symbol) {
    return {
      quarters: [],
      price: null,
      ret_3m_pct: null,
      symbol: "",
      source: "none",
      operating_cashflow: null,
      operating_cashflow_np: null,
    };
  }

  /** Yahoo often lists SME names as TICKER-SM.NS; some ghost as TICKER.NS only. */
  const symbolCandidates = yfSymbolCandidates(ticker, market);

  let usedSymbol = symbol;
  let quarters: QuarterPoint[] = [];
  let source: "yahoo" | "nse" | "bse" | "screener" | "yahoo+screener" | "none" = "none";

  for (const sym of symbolCandidates) {
    const period1 = new Date();
    period1.setFullYear(period1.getFullYear() - 4);

    let series: Array<Record<string, unknown>> = [];
    try {
      series = await withYahooThrottle(async () => {
        const ft = await yf.fundamentalsTimeSeries(sym, {
          period1: toDateStr(period1),
          type: "quarterly",
          module: "financials",
        });
        return Array.isArray(ft) ? (ft as Array<Record<string, unknown>>) : [];
      });
    } catch {
      series = [];
    }

    const byDate = new Map<string, QuarterPoint>();
    for (const row of series) {
      const date = toDateStr(row.date as Date);
      if (!date) continue;
      const prev = byDate.get(date);
      byDate.set(date, {
        date,
        revenue: pickField(row, REVENUE_FIELDS) ?? prev?.revenue ?? null,
        ebit: pickField(row, EBIDT_FIELDS) ?? prev?.ebit ?? null,
        netIncome: pickField(row, NET_INCOME_FIELDS) ?? prev?.netIncome ?? null,
        eps: pickField(row, EPS_FIELDS) ?? prev?.eps ?? null,
        otherIncome:
          pickField(row, OTHER_INCOME_FIELDS) ?? prev?.otherIncome ?? null,
      });
    }

    const candidate = trimReportedQuarters(
      [...byDate.values()].filter(
        (q) => q.revenue != null || q.netIncome != null || q.eps != null,
      ),
    );
    if (candidate.length >= 2) {
      quarters = candidate;
      usedSymbol = sym;
      source = "yahoo";
      break;
    }
    if (candidate.length > quarters.length) {
      quarters = candidate;
      usedSymbol = sym;
    }
  }

  source = quarters.length >= 2 ? source : "none";

  // NSE integrated filing fallback for NSE / NSE SME names.
  if (quarters.length < 2) {
    try {
      const nse = await fetchNseQuarterlyFundamentals(ticker, {
        maxQuarters: 6,
      });
      if (nse.length >= 2) {
        quarters = nse;
        source = "nse";
      }
    } catch {
      /* keep Yahoo (possibly empty) */
    }
  }

  // BSE TabResults fallback for BSE / BSE SME names.
  const mk = (market || "").trim().toUpperCase();
  if (quarters.length < 2 && (mk === "BSE SME" || mk === "BSE")) {
    try {
      const bse = await fetchBseQuarterlyByTicker(ticker);
      if (bse.length >= 2) {
        quarters = bse;
        source = "bse";
      }
    } catch {
      /* keep prior source */
    }
  }

  // Screener.in consolidated table — throttled, cached; enriches OP / other income.
  // Bulk Fill Quarters sets skipScreener to avoid multi-minute Screener queues / dropped fetches.
  if (!opts?.skipScreener) {
    if (quarters.length >= 2) {
      let screener = await fetchScreenerQuarterlyFundamentals(ticker, {
        cacheOnly: !opts?.screenerForce,
        force: opts?.screenerForce,
        consolidated: true,
      });
      if (!screener.length && !opts?.screenerForce) {
        screener = await fetchScreenerQuarterlyFundamentals(ticker, {
          consolidated: true,
        });
      }
      if (screener.length >= 2) {
        quarters = mergeScreenerQuarterOverlay(quarters, screener);
        source = source === "yahoo" ? "yahoo+screener" : source;
      }
    } else {
      // Thin Yahoo — full fallback from Screener (one page fetch, cached).
      try {
        const screener = await fetchScreenerQuarterlyFundamentals(ticker, {
          consolidated: true,
          force: opts?.screenerForce,
        });
        if (screener.length >= 2) {
          quarters = screener;
          source = "screener";
        }
      } catch {
        /* keep prior source */
      }
    }
  }

  let price: number | null = null;
  let ret_3m_pct: number | null = null;
  if (!opts?.skipChart) {
    try {
      const chart = await withYahooThrottle(() =>
        yf.chart(usedSymbol, {
          period1: toDateStr(new Date(Date.now() - 200 * 86400000)),
          interval: "1d",
        }),
      );
      const closes = (chart.quotes ?? [])
        .filter((q) => q.close != null && q.date)
        .map((q) => ({
          date: toDateStr(q.date as Date),
          close: Number(q.close),
        }))
        .filter((q) => Number.isFinite(q.close) && q.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (closes.length) {
        price = closes[closes.length - 1]!.close;
        const i = closes.length - 1;
        const j = Math.max(0, i - 63);
        const a = closes[j]!.close;
        const b = closes[i]!.close;
        if (a > 0) ret_3m_pct = Math.round((b / a - 1) * 1000) / 10;
      }
    } catch {
      /* ignore */
    }
  }

  let operating_cashflow: number | null = null;
  let operating_cashflow_np: number | null = null;
  // Screener overlay sets source to "yahoo+screener"; still use Yahoo for CFO.
  if (
    quarters.length >= 2 &&
    usedSymbol &&
    (source === "yahoo" || source === "yahoo+screener")
  ) {
    const hit = await fetchLatestOperatingCashflow(usedSymbol);
    if (hit) {
      operating_cashflow = hit.cfo;
      // Prefer same-period NP for annual CFO (quarterly NP is a different period/units).
      operating_cashflow_np =
        hit.period === "annual" ? hit.netIncome : null;
    }
  }

  return {
    quarters,
    price,
    ret_3m_pct,
    symbol: usedSymbol,
    source,
    operating_cashflow,
    operating_cashflow_np,
  };
}
