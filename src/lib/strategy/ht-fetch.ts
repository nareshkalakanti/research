import YahooFinance from "yahoo-finance2";
import { toYfinanceSymbol, yfSymbolCandidates } from "../yfinance";
import type { HtCachedRow } from "./ht-types";

const yf = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
  validation: { logErrors: false, logOptionsErrors: false },
});

type FinRow = Record<string, unknown> & { date?: Date | string };
type BsRow = Record<string, unknown> & { date?: Date | string };

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowDate(r: { date?: Date | string }): number {
  if (!r.date) return 0;
  const t = r.date instanceof Date ? r.date.getTime() : Date.parse(String(r.date));
  return Number.isFinite(t) ? t : 0;
}

function sortAsc<T extends { date?: Date | string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => rowDate(a) - rowDate(b));
}

function isRateLimitError(msg: string): boolean {
  return /too many requests|rate.?limit|429|temporarily unavailable/i.test(msg);
}

/** Prefer primary board symbol; avoid alias thrash on the hot path. */
function primarySymbols(ticker: string, market?: string | null): string[] {
  const primary = toYfinanceSymbol(ticker, market);
  if (!primary) return yfSymbolCandidates(ticker, market).slice(0, 2);
  const mk = (market || "").trim().toUpperCase();
  if (mk === "NSE SME" || mk === "SME" || mk === "EMERGE") {
    return yfSymbolCandidates(ticker, market).slice(0, 2);
  }
  // Mainboard: .NS only unless that fails hard.
  return [primary];
}

/** 3-year revenue CAGR: latest vs period 3 years earlier (need ≥4 annuals). */
export function salesGrowth3yCagr(financials: FinRow[]): number | null {
  const rows = sortAsc(
    financials.filter((r) => num(r.totalRevenue ?? r.operatingRevenue) != null),
  );
  if (rows.length < 4) return null;
  const latest = num(rows[rows.length - 1]!.totalRevenue ?? rows[rows.length - 1]!.operatingRevenue);
  const prior = num(rows[rows.length - 4]!.totalRevenue ?? rows[rows.length - 4]!.operatingRevenue);
  if (latest == null || prior == null || latest <= 0 || prior <= 0) return null;
  return Math.round((((latest / prior) ** (1 / 3) - 1) * 100) * 100) / 100;
}

/** 3-year net-income (earnings) CAGR. */
export function earningsGrowth3yCagr(financials: FinRow[]): number | null {
  const rows = sortAsc(
    financials.filter(
      (r) =>
        num(
          r.netIncome ??
            r.NetIncome ??
            r.normalizedIncome ??
            r.continuingIncome,
        ) != null,
    ),
  );
  if (rows.length < 4) return null;
  const pick = (r: FinRow) =>
    num(
      r.netIncome ?? r.NetIncome ?? r.normalizedIncome ?? r.continuingIncome,
    );
  const latest = pick(rows[rows.length - 1]!);
  const prior = pick(rows[rows.length - 4]!);
  if (latest == null || prior == null || latest <= 0 || prior <= 0) return null;
  return Math.round((((latest / prior) ** (1 / 3) - 1) * 100) * 100) / 100;
}

/** Mean ROCE over latest up to 3 annual periods. ROCE = op. income / (assets − current liab). */
export function roce3yAverage(
  financials: FinRow[],
  balance: BsRow[],
): number | null {
  const fin = sortAsc(financials).reverse();
  const bs = sortAsc(balance).reverse();
  const vals: number[] = [];
  for (let i = 0; i < Math.min(3, fin.length); i += 1) {
    const f = fin[i]!;
    const op = num(f.operatingIncome ?? f.EBIT ?? f.ebit);
    const b =
      bs.find((row) => Math.abs(rowDate(row) - rowDate(f)) < 120 * 86400000) ??
      bs[i];
    if (!b || op == null) continue;
    const assets = num(b.totalAssets);
    const currLiab = num(b.currentLiabilities);
    if (assets == null || currLiab == null) continue;
    const capital = assets - currLiab;
    if (capital <= 0) continue;
    vals.push((op / capital) * 100);
  }
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

type QuoteBits = {
  price: number | null;
  mcap_cr: number | null;
  pb: number | null;
  pe: number | null;
  revenueGrowth: number | null;
  roe: number | null;
};

function quoteFromSummary(qs: {
  price?: {
    regularMarketPrice?: number | null;
    postMarketPrice?: number | null;
    marketCap?: number | null;
  } | null;
  financialData?: {
    currentPrice?: number | null;
    revenueGrowth?: number | null;
    returnOnEquity?: number | null;
  } | null;
  defaultKeyStatistics?: {
    priceToBook?: number | null;
    bookValue?: number | null;
    trailingPE?: number | null;
  } | null;
  summaryDetail?: { trailingPE?: number | null } | null;
}): QuoteBits {
  const price =
    num(qs.price?.regularMarketPrice) ??
    num(qs.price?.postMarketPrice) ??
    num(qs.financialData?.currentPrice);
  const mcap = num(qs.price?.marketCap);
  const pb =
    num(qs.defaultKeyStatistics?.priceToBook) ??
    (() => {
      const bv = num(qs.defaultKeyStatistics?.bookValue);
      if (price != null && bv != null && bv > 0) return price / bv;
      return null;
    })();
  const pe =
    num(qs.summaryDetail?.trailingPE) ??
    num(qs.defaultKeyStatistics?.trailingPE);
  return {
    price,
    mcap_cr: mcap != null && mcap > 0 ? Math.round((mcap / 1e7) * 10) / 10 : null,
    pb: pb != null && pb > 0 ? Math.round(pb * 100) / 100 : null,
    pe: pe != null && pe > 0 ? Math.round(pe * 10) / 10 : null,
    revenueGrowth: num(qs.financialData?.revenueGrowth),
    roe: num(qs.financialData?.returnOnEquity),
  };
}

async function loadQuote(symbol: string): Promise<QuoteBits> {
  const qs = await yf.quoteSummary(symbol, {
    modules: ["price", "defaultKeyStatistics", "financialData", "summaryDetail"],
  });
  return quoteFromSummary(qs as Parameters<typeof quoteFromSummary>[0]);
}

async function loadAnnuals(symbol: string): Promise<{
  financials: FinRow[];
  balance: BsRow[];
}> {
  const period1 = "2018-01-01";
  const [finRaw, bsRaw] = await Promise.all([
    yf.fundamentalsTimeSeries(symbol, {
      period1,
      type: "annual",
      module: "financials",
    }) as Promise<FinRow[]>,
    yf.fundamentalsTimeSeries(symbol, {
      period1,
      type: "annual",
      module: "balance-sheet",
    }) as Promise<BsRow[]>,
  ]);
  return {
    financials: Array.isArray(finRaw) ? finRaw : [],
    balance: Array.isArray(bsRaw) ? bsRaw : [],
  };
}

function okRow(opts: {
  ticker: string;
  market?: string | null;
  name?: string | null;
  knownMcapCr?: number | null;
  quote: QuoteBits;
  growth: number;
  earningsGrowth: number | null;
  roce: number;
  symbol: string;
  now: string;
}): HtCachedRow {
  return {
    ticker: opts.ticker,
    market: opts.market ?? null,
    name: opts.name ?? null,
    price: opts.quote.price,
    market_cap_cr:
      opts.knownMcapCr != null && opts.knownMcapCr > 0
        ? opts.knownMcapCr
        : opts.quote.mcap_cr,
    sales_growth_3y: opts.growth,
    earnings_growth_3y: opts.earningsGrowth,
    roce_3y: opts.roce,
    pb: opts.quote.pb,
    pe_ratio: opts.quote.pe,
    status: "ok",
    detail: opts.symbol,
    fetched_at: opts.now,
  };
}

export async function fetchHtIvForTicker(opts: {
  ticker: string;
  market?: string | null;
  name?: string | null;
  knownMcapCr?: number | null;
}): Promise<HtCachedRow> {
  const ticker = opts.ticker.toUpperCase();
  const now = new Date().toISOString();
  const candidates = primarySymbols(ticker, opts.market);
  if (!candidates.length) {
    candidates.push(toYfinanceSymbol(ticker, opts.market));
  }

  let lastErr = "no symbol";
  for (let i = 0; i < candidates.length; i += 1) {
    const symbol = candidates[i];
    if (!symbol) continue;
    try {
      // Fast path: one quoteSummary — enough when Yahoo already has growth/ROE/P/B.
      const quote = await loadQuote(symbol);
      let growth: number | null =
        quote.revenueGrowth != null
          ? Math.round(quote.revenueGrowth * 10000) / 100
          : null;
      let earningsGrowth: number | null = null;
      let roce: number | null =
        quote.roe != null ? Math.round(quote.roe * 10000) / 100 : null;

      const quoteComplete =
        growth != null &&
        roce != null &&
        quote.pb != null &&
        quote.pb > 0 &&
        quote.price != null &&
        quote.price > 0;

      // Prefer annuals when we need earnings CAGR even if quote is complete.
      const { financials, balance } = await loadAnnuals(symbol).catch(() => ({
        financials: [] as FinRow[],
        balance: [] as BsRow[],
      }));
      if (financials.length) {
        growth = salesGrowth3yCagr(financials) ?? growth;
        earningsGrowth = earningsGrowth3yCagr(financials);
        roce = roce3yAverage(financials, balance) ?? roce;
      }

      if (
        growth != null &&
        roce != null &&
        quote.pb != null &&
        quote.pb > 0 &&
        quote.price != null &&
        quote.price > 0
      ) {
        return okRow({
          ticker,
          market: opts.market,
          name: opts.name,
          knownMcapCr: opts.knownMcapCr,
          quote,
          growth,
          earningsGrowth,
          roce,
          symbol: financials.length ? symbol : `${symbol}:quote`,
          now,
        });
      }

      if (quoteComplete && !financials.length) {
        return okRow({
          ticker,
          market: opts.market,
          name: opts.name,
          knownMcapCr: opts.knownMcapCr,
          quote,
          growth: growth!,
          earningsGrowth: null,
          roce: roce!,
          symbol: `${symbol}:quote`,
          now,
        });
      }

      lastErr = `incomplete (g=${growth} e=${earningsGrowth} roce=${roce} pb=${quote.pb} px=${quote.price})`;
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message.slice(0, 120) : "fetch failed";
      if (isRateLimitError(lastErr)) break;
      // Hard miss on primary → try one alias; otherwise stop.
      if (i === 0 && candidates.length > 1) continue;
      break;
    }
  }

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
    detail: lastErr,
    fetched_at: now,
  };
}
