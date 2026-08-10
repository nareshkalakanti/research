import { NextRequest, NextResponse } from "next/server";
import {
  computeForwardPe,
  latestEpsFromQuarters,
  upsertForwardPe,
} from "@/lib/forward-pe";
import { buildQuarterPanel } from "@/lib/quarter-panel";
import { fetchQuarterlyFundamentals } from "@/lib/yahoo-quarters";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ticker = (sp.get("ticker") || "").trim().toUpperCase();
  const market = (sp.get("market") || "").trim() || null;

  if (!ticker) {
    return NextResponse.json({ error: "ticker required" }, { status: 400 });
  }

  try {
    const { quarters, price, symbol } = await fetchQuarterlyFundamentals(
      ticker,
      market,
    );
    const panel = buildQuarterPanel(quarters);
    const { eps, quarter_end } = latestEpsFromQuarters(quarters);
    const forward_pe = computeForwardPe(price, eps);
    if (forward_pe != null && Number.isFinite(forward_pe)) {
      upsertForwardPe([
        {
          ticker,
          market,
          forward_pe,
          latest_eps: eps,
          quarter_end,
          price,
        },
      ]);
    }

    return NextResponse.json({
      ok: true,
      ticker,
      market,
      symbol: symbol || undefined,
      source: "yahoo",
      forward_pe: forward_pe ?? undefined,
      quarters: panel,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        ticker,
        error: e instanceof Error ? e.message : "fetch failed",
        quarters: null,
      },
      { status: 500 },
    );
  }
}
