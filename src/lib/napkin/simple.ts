import { napkinAnalysis, type NapkinScreenVerdict } from "./engine";
import { napkinDataStatus, type NapkinDataStatus } from "./status";
import type { NapkinStockJson } from "./types";

function n(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v;
}

function pctPoints(v: number | null | undefined): number | null {
  const x = n(v);
  return x == null ? null : Math.round(x * 1000) / 10;
}

export type NapkinSimplePayload = {
  ticker: string;
  companyName: string | null;
  yfSymbol: string | null;
  price: number | null;
  marketCap: number | null;
  sector: string | null;
  fetchedAt: string | null;
  revenue: number | null;
  revenueCagr3y: number | null;
  revenueCagr5y: number | null;
  netProfit: number | null;
  profitCagr3y: number | null;
  profitCagr5y: number | null;
  eps: number | null;
  epsCagr3y: number | null;
  epsCagr5y: number | null;
  netMargin: number | null;
  roe: number | null;
  roce: number | null;
  pe: number | null;
  requiredCagr: number | null;
  historicalEpsCagr: number | null;
  growthGap: number | null;
  verdict: NapkinScreenVerdict;
  verdictNote: string;
  dataStatus: NapkinDataStatus;
  sources: string[];
  cagrSource: "yahoo" | "screener" | "groww" | null;
};

export function napkinSimpleFromStock(row: NapkinStockJson): NapkinSimplePayload {
  const math = napkinAnalysis({
    current_pe: row.pe,
    historical_eps_cagr_3y: row.cagr.eps_3y,
    historical_eps_cagr_5y: row.cagr.eps_5y,
  });
  const hist =
    math.historical_eps_cagr_5y != null
      ? math.historical_eps_cagr_5y
      : math.historical_eps_cagr_3y;
  const gap =
    math.historical_eps_cagr_5y != null
      ? math.growth_gap_5y
      : math.growth_gap_3y;
  const dq = row.data_quality;
  const cagrSrc = dq?.cagr_5y_source ?? null;
  const sources = ["Yahoo Finance", "Screener"];
  if (cagrSrc === "groww") sources.push("Groww");

  return {
    ticker: (row.ticker || "").toUpperCase(),
    companyName: row.company_name,
    yfSymbol: row.yf_symbol,
    price: n(row.price),
    marketCap: n(row.market_cap),
    sector: row.sector ?? null,
    fetchedAt: row.fetched_at ?? null,
    revenue: n(row.revenue),
    revenueCagr3y: pctPoints(row.cagr.revenue_3y),
    revenueCagr5y: pctPoints(row.cagr.revenue_5y),
    netProfit: n(row.net_income),
    profitCagr3y: pctPoints(row.cagr.profit_3y),
    profitCagr5y: pctPoints(row.cagr.profit_5y),
    eps: n(row.eps),
    epsCagr3y: pctPoints(row.cagr.eps_3y),
    epsCagr5y: pctPoints(row.cagr.eps_5y),
    netMargin: pctPoints(row.margin.current),
    roe: pctPoints(row.roe),
    roce: pctPoints(row.roce),
    pe: n(row.pe),
    requiredCagr: pctPoints(math.basic_required_cagr),
    historicalEpsCagr: pctPoints(hist),
    growthGap: pctPoints(gap),
    verdict: math.screen_verdict,
    verdictNote: math.screen_note,
    dataStatus: napkinDataStatus({
      pe: row.pe,
      requiredCagr: math.basic_required_cagr,
      price: row.price,
      revenue: row.revenue,
      netProfit: row.net_income,
      eps: row.eps,
      threeYearCagrAvailable: Boolean(dq?.threeYearCagrAvailable),
      fiveYearCagrAvailable: Boolean(dq?.fiveYearCagrAvailable),
    }),
    sources,
    cagrSource: cagrSrc,
  };
}
