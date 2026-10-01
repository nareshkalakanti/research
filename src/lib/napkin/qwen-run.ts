import { napkinAnalysis } from "./engine";
import { getStockData } from "./financials";
import type { NapkinFilingRow } from "./filings";
import { getCachedExtract } from "./pdf";
import { askQwen, napkinQwenModel, QWEN_DOWN, splitQwenSections } from "./qwen";
import { buildNapkinQwenUser, NAPKIN_QWEN_SYSTEM } from "./qwen-prompt";

export type NapkinQwenSection = { heading: string; body: string };

export async function runNapkinQwen(
  ticker: string,
  picked: NapkinFilingRow[],
): Promise<{
  model: string | null;
  sections: NapkinQwenSection[];
  error: string | null;
}> {
  const model = napkinQwenModel();
  const order = [
    "RESULT",
    "INVESTOR_PRESENTATION",
    "ANNUAL_REPORT",
    "CONCALL_TRANSCRIPT",
  ];
  const filings = [...picked]
    .sort(
      (a, b) =>
        order.indexOf(a.document_type) - order.indexOf(b.document_type),
    )
    .map((row) => {
    const doc = getCachedExtract(row.url);
    return {
      title: row.document_title,
      kind: row.document_type,
      url: row.url,
      pages: (doc?.pages || []).map((p) => ({
        page_number: p.page_number,
        text: p.text.slice(0, 6000),
      })),
    };
  });

  let stock;
  try {
    stock = await getStockData(ticker);
  } catch (e) {
    return {
      model,
      sections: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const nap = napkinAnalysis({
    current_pe: stock.pe,
    historical_eps_cagr_3y: stock.cagr.eps_3y,
    historical_eps_cagr_5y: stock.cagr.eps_5y,
  });
  const user = buildNapkinQwenUser({
    company_name: stock.company_name,
    ticker: stock.ticker,
    yf_symbol: stock.yf_symbol,
    financials: {
      price: stock.price,
      market_cap: stock.market_cap,
      pe: stock.pe,
      eps: stock.eps,
      revenue: stock.revenue,
      net_income: stock.net_income,
      ebitda: stock.ebitda,
      free_cash_flow: stock.free_cash_flow,
      total_debt: stock.total_debt,
      cash: stock.cash,
      shares_outstanding: stock.shares_outstanding,
      roe: stock.roe,
      roce: stock.roce,
      cagr: stock.cagr,
      margin: stock.margin,
      warnings: stock.warnings,
    },
    napkin: nap,
    filings,
  });

  try {
    const text = await askQwen(user, NAPKIN_QWEN_SYSTEM);
    return { model, sections: splitQwenSections(text), error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      model,
      sections: [],
      error: msg.includes("not running") ? QWEN_DOWN : msg,
    };
  }
}
