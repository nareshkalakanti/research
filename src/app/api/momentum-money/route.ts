import { NextRequest, NextResponse } from "next/server";
import { buildMomentumMoney } from "@/lib/momentum-money";

export const runtime = "nodejs";

/** GET /api/momentum-money?year=2025 → that year's winners with the study measures. */
export async function GET(req: NextRequest) {
  try {
    const year = Number(req.nextUrl.searchParams.get("year")) || undefined;
    return NextResponse.json({ ok: true, ...(await buildMomentumMoney(year)) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
