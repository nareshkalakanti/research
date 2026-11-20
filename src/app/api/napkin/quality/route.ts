import { NextRequest, NextResponse } from "next/server";
import { buildQualityFlags, QF_RULES } from "@/lib/napkin/quality-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?ticker= — 10-year quality checks and red flags for one stock. */
export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "").trim();
  if (!ticker) return NextResponse.json({ ok: false, error: "Need ticker" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, rules: QF_RULES, ...(await buildQualityFlags(ticker)) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
