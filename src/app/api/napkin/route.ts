import { NextRequest, NextResponse } from "next/server";
import { napkinLog } from "@/lib/napkin/log";
import { getStockData, StockDataError } from "@/lib/napkin/financials";
import { researchFromYahoo } from "@/lib/napkin/map";
import { napkinSimpleFromStock } from "@/lib/napkin/simple";

export const runtime = "nodejs";
export const maxDuration = 60;

const ERROR_HINT: Record<string, string> = {
  invalid_ticker: "That ticker is not valid on Yahoo as .NS",
  yahoo_unavailable: "Yahoo Finance is unavailable. Try again.",
  missing_financial_data: "Yahoo has no usable financials for this ticker.",
};

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "").trim();
  if (!ticker) {
    return NextResponse.json(
      { ok: false, error: "Enter an NSE ticker", error_code: "invalid_ticker" },
      { status: 400 },
    );
  }
  const t0 = Date.now();
  napkinLog("GET /api/napkin start", { ticker, source: "yahoo-finance2" });
  try {
    const row = await getStockData(ticker);
    const yahoo_ms = Date.now() - t0;
    napkinLog("GET /api/napkin yahoo done", {
      ticker,
      yahoo_ms,
      ok: row.ok,
      symbol: row.yf_symbol,
    });
    const simple = napkinSimpleFromStock(row);
    return NextResponse.json({
      ok: true,
      ...simple,
      research: researchFromYahoo(row, []),
      raw: row,
      debug: {
        yahoo_ms,
        source: "yahoo-finance2",
        filings: "deferred",
      },
    });
  } catch (e) {
    const yahoo_ms = Date.now() - t0;
    const code = e instanceof StockDataError ? e.code : "yahoo_unavailable";
    const msg = e instanceof Error ? e.message : String(e);
    napkinLog("GET /api/napkin fail", { ticker, yahoo_ms, code, error: msg });
    return NextResponse.json(
      {
        ok: false,
        error: msg || ERROR_HINT[code] || "Could not load data",
        error_code: code,
        debug: { yahoo_ms, source: "yahoo-finance2" },
      },
      { status: code === "invalid_ticker" ? 422 : 503 },
    );
  }
}
