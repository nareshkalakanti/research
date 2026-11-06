/**
 * Yahoo quarterly income — PEAD2-style field picks + stub trim.
 * Uses yahoo-finance2 `fundamentalsTimeSeries` (JS stand-in for
 * `yf.Ticker(...).quarterly_income_stmt`).
 */
import YahooFinance from "yahoo-finance2";
import {
  mergeQuarterFill,
  missingSalesOrProfit,
  trimReportedQuarters,
  type QuarterPoint,
} from "./quarter-panel";
import { fetchNseQuarterlyFundamentals } from "./nse-quarters";
import { fetchBseQuarterlyByTicker } from "./bse-quarters";
import { fetchScreenerQuarterlyFundamentals, mergeScreenerQuarterOverlay } from "./screener-quarters";
import { fetchGrowwQuarterlyFundamentals } from "./groww-quarters";
import { fetchDailyBars } from "./ohlc";
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

async function fetchYahooQuarterSeries(
  symbolCandidates: string[],
): Promise<{
  quarters: QuarterPoint[];
  usedSymbol: string | null;
}> {
  let best: QuarterPoint[] = [];
  let usedSymbol: string | null = null;
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
        netIncome:
          pickField(row, NET_INCOME_FIELDS) ?? prev?.netIncome ?? null,
        eps: pickField(row, EPS_FIELDS) ?? prev?.eps ?? null,
        otherIncome:
          pickField(row, OTHER_INCOME_FIELDS) ?? prev?.otherIncome ?? null,
      });
    }

    const candidate = trimReportedQuarters(
      [...byDate.values()].filter(
        (q) =>
          q.revenue != null ||
          q.netIncome != null ||
          q.eps != null ||
          q.ebit != null,
      ),
    );
    if (candidate.length >= 2) {
      return { quarters: candidate, usedSymbol: sym };
    }
    if (candidate.length > best.length) {
      best = candidate;
      usedSymbol = sym;
    }
  }
  return { quarters: best, usedSymbol };
}

export async function fetchQuarterlyFundamentals(
  ticker: string,
  market?: string | null,
  opts?: {
    skipChart?: boolean;
    screenerForce?: boolean;
    /** Skip Screener live/cache overlay (bulk Fill Quarters — avoid throttle hangs). */
    skipScreener?: boolean;
    /** PEAD bulk: Yahoo first; Groww tip-extend; skip Screener when skipScreener. */
    yahooFirst?: boolean;
  },
): Promise<{
  quarters: QuarterPoint[];
  price: number | null;
  ret_3m_pct: number | null;
  symbol: string;
  source: "yahoo" | "nse" | "bse" | "screener" | "yahoo+screener" | "groww" | "none";
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
  let source: "yahoo" | "nse" | "bse" | "screener" | "yahoo+screener" | "groww" | "none" =
    "none";

  /** NSE often stalls; don't block BSE/Screener behind a multi-minute hang. */
  const withBudget = async <T>(
    p: Promise<T>,
    ms: number,
    fallback: T,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // stocks-ai PEAD path: Yahoo first, then deepen only if empty.
  if (opts?.yahooFirst) {
    const yfHit = await fetchYahooQuarterSeries(symbolCandidates);
    if (yfHit.quarters.length >= 2) {
      quarters = yfHit.quarters;
      usedSymbol = yfHit.usedSymbol || symbol;
      source = "yahoo";
    }
  }

  // Screener disk cache first — instant when warm; avoids NSE hangs (ADFFOODS
  // spent ~144s on empty NSE before BSE/Screener could answer).
  if (quarters.length < 2 && !opts?.skipScreener) {
    try {
      const screenerCache = await fetchScreenerQuarterlyFundamentals(ticker, {
        cacheOnly: true,
        consolidated: true,
      });
      if (screenerCache.length >= 2) {
        quarters = screenerCache;
        source = "screener";
      }
    } catch {
      /* try filings */
    }
  }

  // Filings: race budgeted NSE with BSE (don't serialize behind a stuck host).
  if (quarters.length < 2) {
    const nseP = withBudget(
      fetchNseQuarterlyFundamentals(ticker, { maxQuarters: 6 }).catch(
        () => [] as QuarterPoint[],
      ),
      12_000,
      [] as QuarterPoint[],
    );
    const bseP = fetchBseQuarterlyByTicker(ticker).catch(
      () => [] as QuarterPoint[],
    );
    const [nse, bse] = await Promise.all([nseP, bseP]);
    if (nse.length >= 2) {
      quarters = nse;
      source = "nse";
    } else if (bse.length >= 2) {
      quarters = bse;
      source = "bse";
    }
  }

  // Screener — backup / OP+YoY depth overlay (cached when Screener is blocked).
  if (!opts?.skipScreener) {
    const needYoyDepth = quarters.length > 0 && quarters.length < 5;
    if (quarters.length >= 2 || needYoyDepth || quarters.length < 2) {
      let screener = await fetchScreenerQuarterlyFundamentals(ticker, {
        cacheOnly: !opts?.screenerForce && !needYoyDepth && quarters.length >= 2,
        force: opts?.screenerForce || needYoyDepth,
        consolidated: true,
      });
      if (!screener.length && !opts?.screenerForce) {
        screener = await fetchScreenerQuarterlyFundamentals(ticker, {
          consolidated: true,
          force: needYoyDepth || quarters.length < 2,
        });
      }
      if (screener.length >= 2) {
        const before = quarters.length;
        quarters =
          before >= 2
            ? mergeScreenerQuarterOverlay(quarters, screener)
            : screener;
        if (before < 2) source = "screener";
        else if (quarters.length > before) source = "screener";
      }
    }
  }

  // Groww — empty/PnL gaps, or tip-extend (Screener cache often lags new results).
  const tipIso = (qs: QuarterPoint[]) =>
    (qs.at(-1)?.date || "").slice(0, 10);
  const wantGrowwTip = quarters.length >= 2;
  if (
    quarters.length < 2 ||
    missingSalesOrProfit(quarters) ||
    wantGrowwTip
  ) {
    try {
      const groww = await fetchGrowwQuarterlyFundamentals(ticker);
      if (groww.length) {
        const beforeTip = tipIso(quarters);
        const merged = mergeQuarterFill(quarters, groww);
        const filledPnl =
          missingSalesOrProfit(quarters) && !missingSalesOrProfit(merged);
        const tipNewer =
          Boolean(beforeTip) && tipIso(merged) > beforeTip;
        if (
          filledPnl ||
          (quarters.length < 1 && merged.length >= 1) ||
          tipNewer ||
          merged.length > quarters.length
        ) {
          quarters = merged;
          if (source === "none") source = "groww";
          else if (tipNewer && source === "yahoo") source = "yahoo";
        }
      }
    } catch {
      /* keep prior source */
    }
  }

  // Yahoo — last resort when filings + Screener + Groww still thin.
  if (quarters.length < 2 && !opts?.yahooFirst) {
    const yfHit = await fetchYahooQuarterSeries(symbolCandidates);
    if (yfHit.quarters.length) {
      quarters = yfHit.quarters;
      usedSymbol = yfHit.usedSymbol || usedSymbol;
      source = yfHit.quarters.length >= 2 ? "yahoo" : source;
    }
  }

  let price: number | null = null;
  let ret_3m_pct: number | null = null;
  if (!opts?.skipChart) {
    try {
      // App-wide OHLC path (Yahoo + Groww when thin) — not raw Yahoo chart.
      const bars = await fetchDailyBars(ticker, market, 1);
      const closes = bars
        .filter((q) => Number.isFinite(q.close) && q.close > 0)
        .map((q) => ({ date: q.date.slice(0, 10), close: q.close }))
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
