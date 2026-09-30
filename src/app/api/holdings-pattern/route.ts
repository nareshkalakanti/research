import { NextResponse } from "next/server";
import { holdingsTickerSet } from "@/lib/holdings";
import { loadHoldingsPattern } from "@/lib/holdings-pattern";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const pattern = await loadHoldingsPattern();
    return NextResponse.json({
      ok: true as const,
      tickers: [...holdingsTickerSet()],
      ...pattern,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false as const,
        error: e instanceof Error ? e.message : "Pattern failed",
      },
      { status: 500 },
    );
  }
}
