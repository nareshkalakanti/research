/**
 * Yahoo market + annual statements via yahoo-finance2 (JS). No Python. No Qwen.
 */
import YahooFinance from "yahoo-finance2";
import { growwCompanyData } from "@/lib/web-mcap";
import { parseGrowwYearlyFinancialStatement } from "@/lib/groww-quarters";
import { fetchScreenerAnnualPl } from "@/lib/screener-annual";
import { toYfinanceSymbol } from "@/lib/yfinance";
import { growwAnnualPairs, screenerPlPairs } from "./cagr-history";
import type { NapkinCagr, NapkinStockJson } from "./types";

const yf = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
  validation: { logErrors: false, logOptionsErrors: false },
});

const TICKER_RE = /^[A-Z0-9][A-Z0-9.&-]{0,20}$/;

const REV = ["totalRevenue", "operatingRevenue", "revenue"] as const;
const NI = [
  "netIncome",
  "netIncomeCommonStockholders",
  "netIncomeFromContinuingOperationNetMinorityInterest",
] as const;
const EPS = ["dilutedEPS", "basicEPS"] as const;
const EBIT = ["EBIT", "operatingIncome"] as const;
const EBITDA = ["EBITDA", "ebitda"] as const;
const FCF = ["freeCashFlow"] as const;
const EQUITY = [
  "stockholdersEquity",
  "commonStockEquity",
  "totalEquityGrossMinorityInterest",
] as const;
const ASSETS = ["totalAssets"] as const;
const CL = ["currentLiabilities"] as const;
const DEBT = ["totalDebt"] as const;
const SHARES = [
  "dilutedAverageShares",
  "basicAverageShares",
  "ordinarySharesNumber",
  "shareIssued",
] as const;

export const REQUIRED_ANNUAL_POINTS_3Y = 4;
export const REQUIRED_ANNUAL_POINTS_5Y = 6;

export const REASON_NO_ANNUAL =
  "Yahoo Finance returned no annual income-statement data.";
export const REASON_SHORT_5Y =
  "Yahoo Finance provides insufficient annual history for a true 5Y CAGR.";
export const REASON_SHORT_3Y =
  "Yahoo Finance provides insufficient annual history for a true 3Y CAGR.";
export const REASON_SHORT_1Y =
  "Insufficient annual history for a true 1Y EPS CAGR.";
export const REASON_NONPOSITIVE =
  "Start or end annual value is zero or negative; CAGR is not defined.";
export const REASON_NO_EPS =
  "Yahoo did not supply usable annual EPS (or net income and diluted shares).";
const CASH = [
  "cashAndCashEquivalents",
  "cashCashEquivalentsAndShortTermInvestments",
  "cashFinancial",
] as const;

export class StockDataError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function nseYahooSymbol(ticker: string): string {
  const t = (ticker || "").trim().toUpperCase().replace(/\.(NS|BO)$/i, "").replace(/\s+/g, "");
  if (!TICKER_RE.test(t)) {
    throw new StockDataError("invalid_ticker", "Enter a valid NSE ticker");
  }
  return toYfinanceSymbol(t, "NSE");
}

function bag(o: object | null | undefined): Record<string, unknown> {
  return (o ?? {}) as Record<string, unknown>;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function cagr(
  start: number | null,
  end: number | null,
  years: number,
): number | null {
  if (years <= 0) return null;
  if (start == null || end == null || start <= 0 || end <= 0) return null;
  return (end / start) ** (1 / years) - 1;
}

/** True n-year CAGR needs n+1 annual points. Never stretch a shorter span. */
export function annualCagr(
  values: number[],
  years: number,
): { value: number | null; reason: string | null } {
  const need = years + 1;
  if (values.length < need) {
    return {
      value: null,
      reason:
        years >= 5 ? REASON_SHORT_5Y : years >= 3 ? REASON_SHORT_3Y : REASON_SHORT_1Y,
    };
  }
  const start = values[values.length - need]!;
  const end = values[values.length - 1]!;
  const value = cagr(start, end, years);
  if (value == null) return { value: null, reason: REASON_NONPOSITIVE };
  return { value, reason: null };
}

function yearOf(row: Record<string, unknown>): string {
  const d = row.date;
  const x = d instanceof Date ? d : new Date(String(d ?? ""));
  if (!Number.isFinite(x.getTime())) return "";
  return String(x.getFullYear());
}

function pick(row: Record<string, unknown>, fields: readonly string[]): number | null {
  for (const f of fields) {
    const v = num(row[f]);
    if (v != null) return v;
  }
  return null;
}

function series(
  rows: Array<Record<string, unknown>>,
  fields: readonly string[],
): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const row of rows) {
    const y = yearOf(row);
    const v = pick(row, fields);
    if (!y || v == null) continue;
    out.push([y, v]);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}

function windowCagr(
  s: Array<[string, number]>,
  years: number,
): { value: number | null; reason: string | null } {
  return annualCagr(s.map(([, v]) => v), years);
}

function epsByYear(
  income: Array<Record<string, unknown>>,
): Array<[string, number]> {
  const niS = Object.fromEntries(series(income, NI));
  const shS = Object.fromEntries(series(income, SHARES));
  const out: Array<[string, number]> = [];
  const years = new Set<string>();
  for (const row of income) {
    const y = yearOf(row);
    if (y) years.add(y);
  }
  for (const y of [...years].sort()) {
    const reported = series(
      income.filter((r) => yearOf(r) === y),
      EPS,
    );
    let eps = reported[0]?.[1] ?? null;
    if (eps == null) {
      const ni = niS[y];
      const sh = shS[y];
      if (ni != null && sh != null && sh !== 0) eps = ni / sh;
    }
    if (eps != null) out.push([y, eps]);
  }
  return out;
}

function meanRatio(
  numS: Array<[string, number]>,
  denS: Array<[string, number]>,
  years: number,
): number | null {
  const dmap = new Map(denS);
  const ratios: number[] = [];
  for (const [y, n] of numS) {
    const d = dmap.get(y);
    if (d == null || d === 0) continue;
    ratios.push(n / d);
  }
  if (years <= 0) return ratios.at(-1) ?? null;
  if (ratios.length < years) return null;
  const take = ratios.slice(-years);
  return take.reduce((a, b) => a + b, 0) / take.length;
}

async function annualModule(
  symbol: string,
  module: "financials" | "cash-flow" | "balance-sheet",
): Promise<Array<Record<string, unknown>>> {
  const period1 = new Date();
  period1.setFullYear(period1.getFullYear() - 8);
  try {
    const ft = await yf.fundamentalsTimeSeries(symbol, {
      period1: period1.toISOString().slice(0, 10),
      type: "annual",
      module,
    });
    return Array.isArray(ft) ? (ft as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

async function fillFiveYearFromAltSources(
  ticker: string,
  companyName: string | null,
): Promise<{
  source: "screener" | "groww" | null;
  note: string | null;
  revenue: { value: number | null };
  profit: { value: number | null };
  eps: { value: number | null };
}> {
  const empty = {
    source: null as "screener" | "groww" | null,
    note: null as string | null,
    revenue: { value: null as number | null },
    profit: { value: null as number | null },
    eps: { value: null as number | null },
  };
  try {
    const pl = await fetchScreenerAnnualPl(ticker);
    const pairs = screenerPlPairs(pl);
    const revenue = annualCagr(
      pairs.revenue.map(([, v]) => v),
      5,
    );
    const profit = annualCagr(
      pairs.profit.map(([, v]) => v),
      5,
    );
    const eps = annualCagr(
      pairs.eps.map(([, v]) => v),
      5,
    );
    if (revenue.value != null || profit.value != null || eps.value != null) {
      return {
        source: "screener",
        note: "5Y CAGR from Screener.in annual P&L (Yahoo annual history too short).",
        revenue: { value: revenue.value },
        profit: { value: profit.value },
        eps: { value: eps.value },
      };
    }
  } catch {
    /* try Groww yearly next */
  }
  try {
    const data = await growwCompanyData(ticker, companyName || ticker);
    if (!data) return empty;
    const pairs = growwAnnualPairs(parseGrowwYearlyFinancialStatement(data.company));
    const revenue = annualCagr(
      pairs.revenue.map(([, v]) => v),
      5,
    );
    const profit = annualCagr(
      pairs.profit.map(([, v]) => v),
      5,
    );
    const eps = annualCagr(
      pairs.eps.map(([, v]) => v),
      5,
    );
    if (revenue.value != null || profit.value != null || eps.value != null) {
      return {
        source: "groww",
        note: "5Y CAGR from Groww yearly statements (Yahoo annual history too short).",
        revenue: { value: revenue.value },
        profit: { value: profit.value },
        eps: { value: eps.value },
      };
    }
  } catch {
    /* leave 5Y N/A */
  }
  return empty;
}

export async function getStockData(ticker: string): Promise<NapkinStockJson> {
  const symbol = nseYahooSymbol(ticker);
  const bare = symbol.replace(/\.(NS|BO)$/i, "").replace(/-SM$/i, "");
  const warnings: string[] = [];

  let qs: Awaited<ReturnType<typeof yf.quoteSummary>>;
  try {
    qs = await yf.quoteSummary(symbol, {
      modules: [
        "price",
        "summaryDetail",
        "defaultKeyStatistics",
        "financialData",
        "assetProfile",
      ],
    });
  } catch (e) {
    throw new StockDataError(
      "yahoo_unavailable",
      `Yahoo Finance unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const priceMod = bag(qs.price);
  const stats = bag(qs.defaultKeyStatistics);
  const fin = bag(qs.financialData);
  const det = bag(qs.summaryDetail);
  const profile = bag(
    (qs as { assetProfile?: object }).assetProfile ??
      (qs as { summaryProfile?: object }).summaryProfile,
  );
  const sector =
    String(profile.sector || profile.industry || "").trim() || null;

  const name =
    String(priceMod.longName || priceMod.shortName || "").trim() || null;
  const price = num(priceMod.regularMarketPrice) ?? num(fin.currentPrice);
  if (!name && price == null) {
    throw new StockDataError("invalid_ticker", `No Yahoo quote for ${symbol}`);
  }

  const [income, cashflow, balance, screenerPl] = await Promise.all([
    annualModule(symbol, "financials"),
    annualModule(symbol, "cash-flow"),
    annualModule(symbol, "balance-sheet"),
    fetchScreenerAnnualPl(bare).catch(() => null),
  ]);

  const revenueS = series(income, REV);
  const niS = series(income, NI);
  const epsS = epsByYear(income);
  const ebitS = series(income, EBIT);
  const ebitdaS = series(income, EBITDA);
  const fcfS = series(cashflow, FCF);
  const equityS = series(balance, EQUITY);
  const assetsS = series(balance, ASSETS);
  const clS = series(balance, CL);
  const debtS = series(balance, DEBT);
  const cashS = series(balance, CASH);

  const trailingEps = num(stats.trailingEps);
  const rev3 = windowCagr(revenueS, 3);
  const rev5 = windowCagr(revenueS, 5);
  const profit3 = windowCagr(niS, 3);
  const profit5 = windowCagr(niS, 5);
  const eps3 = windowCagr(epsS, 3);
  const eps5 = windowCagr(epsS, 5);

  const annualPeriods = new Set(income.map(yearOf).filter(Boolean)).size;
  const reasons: Record<string, string> = {};
  if (rev3.reason) reasons.revenue_3y = rev3.reason;
  if (rev5.reason) reasons.revenue_5y = rev5.reason;
  if (profit3.reason) reasons.profit_3y = profit3.reason;
  if (profit5.reason) reasons.profit_5y = profit5.reason;
  if (eps3.reason) reasons.eps_3y = epsS.length ? eps3.reason : REASON_NO_EPS;
  if (eps5.reason) reasons.eps_5y = epsS.length ? eps5.reason : REASON_NO_EPS;

  let cagr5Source: "yahoo" | "screener" | "groww" | null =
    rev5.value != null || profit5.value != null || eps5.value != null
      ? "yahoo"
      : null;

  if (screenerPl) {
    const pairs = screenerPlPairs(screenerPl);
    const sRev3 = annualCagr(pairs.revenue.map(([, v]) => v), 3);
    const sRev5 = annualCagr(pairs.revenue.map(([, v]) => v), 5);
    const sP3 = annualCagr(pairs.profit.map(([, v]) => v), 3);
    const sP5 = annualCagr(pairs.profit.map(([, v]) => v), 5);
    const sE3 = annualCagr(pairs.eps.map(([, v]) => v), 3);
    const sE5 = annualCagr(pairs.eps.map(([, v]) => v), 5);
    if (sRev3.value != null) {
      rev3.value = sRev3.value;
      delete reasons.revenue_3y;
    }
    if (sP3.value != null) {
      profit3.value = sP3.value;
      delete reasons.profit_3y;
    }
    if (sE3.value != null) {
      eps3.value = sE3.value;
      delete reasons.eps_3y;
    }
    if (sRev5.value != null) {
      rev5.value = sRev5.value;
      delete reasons.revenue_5y;
      cagr5Source = "screener";
    }
    if (sP5.value != null) {
      profit5.value = sP5.value;
      delete reasons.profit_5y;
      cagr5Source = "screener";
    }
    if (sE5.value != null) {
      eps5.value = sE5.value;
      delete reasons.eps_5y;
      cagr5Source = "screener";
    }
  }

  const needFive =
    rev5.value == null || profit5.value == null || eps5.value == null;
  if (needFive) {
    const filled = await fillFiveYearFromAltSources(bare, name);
    if (rev5.value == null && filled.revenue.value != null) {
      rev5.value = filled.revenue.value;
      delete reasons.revenue_5y;
      cagr5Source = filled.source;
    }
    if (profit5.value == null && filled.profit.value != null) {
      profit5.value = filled.profit.value;
      delete reasons.profit_5y;
      cagr5Source = filled.source;
    }
    if (eps5.value == null && filled.eps.value != null) {
      eps5.value = filled.eps.value;
      delete reasons.eps_5y;
      cagr5Source = filled.source;
    }
    if (filled.note) warnings.push(filled.note);
  }

  if (trailingEps != null && trailingEps < 0) warnings.push("negative_eps");
  if (epsS.length && epsS[epsS.length - 1]![1] < 0 && !warnings.includes("negative_eps")) {
    warnings.push("negative_eps");
  }
  if (!income.length) warnings.push(REASON_NO_ANNUAL);
  else if (annualPeriods < REQUIRED_ANNUAL_POINTS_5Y && cagr5Source === "yahoo") {
    warnings.push(REASON_SHORT_5Y);
  } else if (annualPeriods < REQUIRED_ANNUAL_POINTS_5Y && !cagr5Source) {
    warnings.push(REASON_SHORT_5Y);
  }

  const latestNi = niS.at(-1)?.[1] ?? num(fin.netIncomeToCommon);
  const latestRev = revenueS.at(-1)?.[1] ?? num(fin.totalRevenue);
  const latestEbit = ebitS.at(-1)?.[1] ?? null;
  const latestEq = equityS.at(-1)?.[1] ?? null;
  const latestAssets = assetsS.at(-1)?.[1] ?? null;
  const latestCl = clS.at(-1)?.[1] ?? null;

  let roce: number | null = null;
  if (latestEbit != null && latestAssets != null && latestCl != null) {
    const employed = latestAssets - latestCl;
    if (employed > 0) roce = latestEbit / employed;
  }

  let roe: number | null = null;
  if (latestNi != null && latestEq != null && latestEq > 0) {
    roe = latestNi / latestEq;
  } else {
    roe = num(fin.returnOnEquity);
  }

  let marginNow: number | null = null;
  if (latestNi != null && latestRev != null && latestRev !== 0) {
    marginNow = latestNi / latestRev;
  }

  const years = [
    ...new Set(
      [...revenueS, ...niS, ...epsS, ...ebitdaS, ...fcfS].map(([y]) => y),
    ),
  ].sort();
  const revM = Object.fromEntries(revenueS);
  const niM = Object.fromEntries(niS);
  const epsM = Object.fromEntries(epsS);
  const ebitdaM = Object.fromEntries(ebitdaS);
  const fcfM = Object.fromEntries(fcfS);
  const annuals = years.map((y) => ({
    year: y,
    revenue: revM[y] ?? null,
    net_income: niM[y] ?? null,
    eps: epsM[y] ?? null,
    ebitda: ebitdaM[y] ?? null,
    free_cash_flow: fcfM[y] ?? null,
  }));

  if (price == null && latestRev == null && latestNi == null && !annuals.length) {
    throw new StockDataError(
      "missing_financial_data",
      `Yahoo returned no usable financials for ${symbol}`,
    );
  }

  const cagrOut: NapkinCagr = {
    revenue_3y: rev3.value,
    revenue_5y: rev5.value,
    eps_3y: eps3.value,
    eps_5y: eps5.value,
    profit_3y: profit3.value,
    profit_5y: profit5.value,
  };

  const fiveYearCagrAvailable = Boolean(
    rev5.value != null || profit5.value != null || eps5.value != null,
  );
  const threeYearCagrAvailable = Boolean(
    rev3.value != null || profit3.value != null || eps3.value != null,
  );
  const data_quality = {
    annualPeriodsAvailable: annualPeriods,
    requiredFor3Y: REQUIRED_ANNUAL_POINTS_3Y,
    requiredFor5Y: REQUIRED_ANNUAL_POINTS_5Y,
    threeYearCagrAvailable,
    fiveYearCagrAvailable,
    cagr_5y_source: cagr5Source,
    reason: !income.length && !screenerPl
      ? REASON_NO_ANNUAL
      : fiveYearCagrAvailable
        ? `Data: Yahoo Finance + ${cagr5Source === "groww" ? "Groww" : "Screener"}`
        : REASON_SHORT_5Y,
    reasons,
  };

  return {
    ok: true,
    error: null,
    error_code: null,
    company_name: name,
    ticker: bare,
    yf_symbol: symbol,
    sector,
    fetched_at: new Date().toISOString(),
    price,
    market_cap: num(priceMod.marketCap) ?? num(det.marketCap),
    pe: num(det.trailingPE) ?? num(fin.trailingPE) ?? num(stats.forwardPE),
    eps: trailingEps,
    revenue: latestRev,
    net_income: latestNi ?? null,
    ebitda: ebitdaS.at(-1)?.[1] ?? num(fin.ebitda) ?? null,
    free_cash_flow: fcfS.at(-1)?.[1] ?? num(fin.freeCashflow) ?? null,
    total_debt: debtS.at(-1)?.[1] ?? num(fin.totalDebt) ?? null,
    cash: cashS.at(-1)?.[1] ?? num(fin.totalCash) ?? null,
    shares_outstanding: num(stats.sharesOutstanding) ?? num(priceMod.sharesOutstanding),
    roe,
    roce,
    cagr: cagrOut,
    margin: {
      current: marginNow,
      "3y": meanRatio(niS, revenueS, 3),
      "5y": meanRatio(niS, revenueS, 5),
    },
    annuals,
    data_quality,
    warnings: [...new Set(warnings)],
  };
}
