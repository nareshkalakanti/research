import { napkinAnalysis } from "./engine";
import type { NapkinFilingRow } from "./filings";
import { napkinSimpleFromStock } from "./simple";
import type { NapkinMetric, NapkinResearch, NapkinStockJson } from "./types";

const NA = "N/A";
const CR = 10_000_000;

function num(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v;
}

function inr(v: number | null | undefined): string {
  const n = num(v);
  if (n == null) return NA;
  const abs = Math.abs(n);
  if (abs >= CR) {
    const cr = n / CR;
    const digits = Math.abs(cr) >= 100 ? 0 : 1;
    return `₹${cr.toLocaleString("en-IN", { maximumFractionDigits: digits })} Cr`;
  }
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function pct(v: number | null | undefined, signed = false): string {
  const n = num(v);
  if (n == null) return NA;
  const core = `${(n * 100).toFixed(1)}%`;
  if (signed && n > 0) return `+${core}`;
  return core;
}

function pe(v: number | null | undefined): string {
  const n = num(v);
  if (n == null) return NA;
  return n.toFixed(1);
}

function multiple(v: number | null | undefined): string {
  const n = num(v);
  if (n == null) return NA;
  return `${n.toFixed(2)}x`;
}

function shares(v: number | null | undefined): string {
  const n = num(v);
  if (n == null) return NA;
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} cr`;
  return n.toLocaleString("en-IN");
}

function metric(key: string, label: string, value: string): NapkinMetric {
  return { key, label, value };
}

export function researchFromYahoo(
  row: NapkinStockJson,
  filings: NapkinFilingRow[] = [],
): NapkinResearch {
  const ticker = (row.ticker || "").toUpperCase();
  const name = row.company_name?.trim() || ticker;
  const warnings = row.warnings ?? [];
  const cagr = row.cagr;
  const risks = [
    ...(row.data_quality?.reason ? [row.data_quality.reason] : []),
    ...warnings.map((w) => {
      if (w === "negative_eps") return "EPS is negative; EPS CAGR is N/A.";
      if (w === row.data_quality?.reason) return "";
      if (w === "insufficient_history") return "";
      return w;
    }).filter(Boolean),
  ];

  const n = napkinAnalysis({
    current_pe: row.pe,
    historical_eps_cagr_3y: cagr.eps_3y,
    historical_eps_cagr_5y: cagr.eps_5y,
  });
  const simple = napkinSimpleFromStock(row);

  return {
    ticker,
    name,
    exchange: "NSE",
    yf_symbol: row.yf_symbol,
    mock: false,
    overview: [
      metric("price", "Price", inr(row.price)),
      metric("mcap", "Market Cap", inr(row.market_cap)),
      metric("pe", "P/E", pe(row.pe)),
      metric("eps", "EPS", inr(row.eps)),
      metric("revenue", "Revenue", inr(row.revenue)),
      metric("roce", "ROCE", pct(row.roce)),
      metric("roe", "ROE", pct(row.roe)),
      metric("debt", "Debt", inr(row.total_debt)),
      metric("fcf", "Free Cash Flow", inr(row.free_cash_flow)),
    ],
    financials: [
      metric("ni", "Net income", inr(row.net_income)),
      metric("ebitda", "EBITDA", inr(row.ebitda)),
      metric("cash", "Cash", inr(row.cash)),
      metric("shares", "Shares outstanding", shares(row.shares_outstanding)),
      metric("rev3", "Revenue CAGR 3Y", pct(cagr.revenue_3y)),
      metric("rev5", "Revenue CAGR 5Y", pct(cagr.revenue_5y)),
      metric("eps3", "EPS CAGR 3Y", pct(cagr.eps_3y)),
      metric("eps5", "EPS CAGR 5Y", pct(cagr.eps_5y)),
      metric("p3", "Profit CAGR 3Y", pct(cagr.profit_3y)),
      metric("p5", "Profit CAGR 5Y", pct(cagr.profit_5y)),
      metric("mnow", "Margin current", pct(row.margin.current)),
      metric("m3", "Margin 3Y", pct(row.margin["3y"])),
      metric("m5", "Margin 5Y", pct(row.margin["5y"])),
    ],
    napkin: {
      current_pe: pe(n.current_pe),
      near_term_value: multiple(n.near_term_value),
      adjusted_value: multiple(n.adjusted_value),
      basic_required_cagr: pct(n.basic_required_cagr),
      adjusted_required_cagr: pct(n.adjusted_required_cagr),
      eps_cagr_3y: pct(n.historical_eps_cagr_3y),
      eps_cagr_5y: pct(n.historical_eps_cagr_5y),
      growth_gap_3y: pct(n.growth_gap_3y, true),
      growth_gap_5y: pct(n.growth_gap_5y, true),
      growth_gap_hist_adjusted_5y: pct(n.growth_gap_hist_adjusted_5y, true),
      expected_eps_cagr: pct(n.expected_eps_cagr),
      growth_gap_expected_basic: pct(n.growth_gap_expected_basic, true),
      growth_gap_expected_adjusted: pct(n.growth_gap_expected_adjusted, true),
      verdict: n.screen_verdict,
      verdict_note: n.screen_note,
    },
    filings: filings.map((f) => ({
      title: f.document_title,
      period: f.date ? f.date.slice(0, 10) : "N/A",
      kind: f.document_type,
      source: f.source,
      url: f.url,
    })),
    concall: [],
    qwen: [],
    risks,
    data_quality: row.data_quality,
    data_status: simple.dataStatus,
    sources: simple.sources,
    fetched_at: row.fetched_at ?? simple.fetchedAt,
    sector: row.sector ?? simple.sector,
    card: {
      headline: `${name} · ${ticker}`,
      body: `Yahoo ${row.yf_symbol || `${ticker}.NS`} · P/E ${pe(n.current_pe)} · basic required CAGR ${pct(n.basic_required_cagr)} · 5Y growth gap ${pct(n.growth_gap_5y)}.`,
    },
  };
}
