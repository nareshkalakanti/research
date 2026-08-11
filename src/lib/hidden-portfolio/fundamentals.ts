/**
 * Fundamentals filter — Yahoo Finance quotes for SME universe.
 */
import YahooFinance from "yahoo-finance2";
import { toYfinanceSymbol } from "@/lib/yfinance";
import {
  MARKET_CAP_RANGE_INR,
  MIN_AVG_VOLUME,
  type HiddenUniverseRow,
} from "./config";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export type FundamentalRow = {
  symbol: string;
  name: string;
  sector: string | null;
  market: string | null;
  price: number | null;
  mcap_cr: number | null;
  pe: number | null;
  avg_volume: number | null;
  revenue_growth: number | null;
  profit_margin: number | null;
  passed: boolean;
  skip_reason?: string;
};

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mcapToCr(mcap: number | null): number | null {
  if (mcap == null) return null;
  return Math.round((mcap / 1e7) * 10) / 10;
}

function stripYahooSuffix(symbol: string): string {
  return symbol.replace(/-SM\.NS$/i, "").replace(/\.(NS|BO)$/i, "");
}

/**
 * Fetch fundamentals for one universe row. Never throws.
 * Set applyFilter=false for explicit symbol smoke scans (still returns data).
 */
export async function fetchFundamentals(
  row: HiddenUniverseRow,
  opts?: { applyFilter?: boolean },
): Promise<FundamentalRow> {
  const applyFilter = opts?.applyFilter !== false;
  const base = toYfinanceSymbol(
    stripYahooSuffix(row.symbol),
    row.market ??
      (row.symbol.toUpperCase().includes("-SM") ? "NSE SME" : "NSE"),
  );
  const trySyms = [base];
  if (base.endsWith(".NS")) {
    trySyms.push(base.replace(/\.NS$/i, ".BO"));
  }
  if (base.includes("-SM.NS")) {
    trySyms.push(base.replace(/-SM\.NS$/i, ".NS"));
  }

  let price: number | null = null;
  let mcap: number | null = null;
  let pe: number | null = null;
  let avgVol: number | null = null;
  let revenueGrowth: number | null = null;
  let profitMargin: number | null = null;
  let sector: string | null = row.sector || null;

  for (const sym of trySyms) {
    try {
      const q = await yf.quote(sym);
      if (q) {
        price = price ?? num(q.regularMarketPrice);
        mcap = mcap ?? num(q.marketCap);
        pe =
          pe ??
          num(q.trailingPE) ??
          num((q as { forwardPE?: number }).forwardPE);
        avgVol =
          avgVol ??
          num(q.averageDailyVolume3Month) ??
          num(q.averageDailyVolume10Day) ??
          num(q.regularMarketVolume);
      }
    } catch {
      /* try next */
    }

    try {
      const qs = await yf.quoteSummary(sym, {
        modules: [
          "price",
          "summaryDetail",
          "defaultKeyStatistics",
          "financialData",
          "summaryProfile",
        ],
      });
      price =
        price ??
        num(qs.price?.regularMarketPrice) ??
        num(qs.summaryDetail?.regularMarketPrice);
      mcap =
        mcap ??
        num(qs.price?.marketCap) ??
        num(qs.summaryDetail?.marketCap);
      pe =
        pe ??
        num(qs.summaryDetail?.trailingPE) ??
        num(qs.summaryDetail?.forwardPE) ??
        num(qs.defaultKeyStatistics?.trailingPE) ??
        num(qs.defaultKeyStatistics?.forwardPE);
      avgVol =
        avgVol ??
        num(qs.summaryDetail?.averageVolume) ??
        num(qs.summaryDetail?.averageVolume10days) ??
        num(qs.price?.averageDailyVolume3Month);
      revenueGrowth =
        revenueGrowth ?? num(qs.financialData?.revenueGrowth);
      profitMargin =
        profitMargin ??
        num(qs.financialData?.profitMargins) ??
        num(qs.financialData?.operatingMargins);
      const sp = qs.summaryProfile as { sector?: string } | undefined;
      if (!sector && sp?.sector) sector = sp.sector.trim();
    } catch {
      /* try next */
    }

    if (price != null && mcap != null) break;
  }

  const mcapCr = mcapToCr(mcap);
  const [loInr, hiInr] = MARKET_CAP_RANGE_INR;
  const loCr = loInr / 1e7;
  const hiCr = hiInr / 1e7;

  const baseOut: FundamentalRow = {
    symbol: row.symbol.toUpperCase(),
    name: row.name,
    sector,
    market: row.market ?? null,
    price: price != null ? Math.round(price * 100) / 100 : null,
    mcap_cr: mcapCr,
    pe,
    avg_volume: avgVol != null ? Math.round(avgVol) : null,
    revenue_growth: revenueGrowth,
    profit_margin: profitMargin,
    passed: false,
  };

  if (price == null && mcapCr == null) {
    return { ...baseOut, skip_reason: "no quote" };
  }

  if (!applyFilter) {
    return { ...baseOut, passed: true };
  }

  if (mcapCr == null || mcapCr < loCr || mcapCr > hiCr) {
    return {
      ...baseOut,
      skip_reason: `mcap ${mcapCr ?? "n/a"} Cr outside ₹${loCr}–${hiCr} Cr`,
    };
  }
  if (avgVol == null || avgVol < MIN_AVG_VOLUME) {
    return {
      ...baseOut,
      skip_reason: `avg volume ${avgVol ?? "n/a"} < ${MIN_AVG_VOLUME}`,
    };
  }

  return { ...baseOut, passed: true };
}
