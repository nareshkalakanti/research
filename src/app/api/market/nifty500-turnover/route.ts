import { NextResponse } from "next/server";
import { loadNifty500TurnoverSeries } from "@/lib/market/nifty500-turnover";

export const runtime = "nodejs";

export async function GET() {
  const data = loadNifty500TurnoverSeries();
  if (!data) {
    return NextResponse.json({
      ok: false,
      error: "No turnover series — run npm run build:nifty500-turnover",
      series: [],
    });
  }
  return NextResponse.json({
    ok: true,
    built_at: data.built_at,
    constituents: data.constituents,
    latest: data.latest,
    series: data.series,
  });
}
