import { NextRequest, NextResponse } from "next/server";
import { buildScannerData } from "@/lib/scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: every active stock with name, industry, size, price and ratios (filtered in the browser). */
export async function GET(req: NextRequest) {
  try {
    return NextResponse.json({ ok: true, ...buildScannerData({ fresh: req.nextUrl.searchParams.get("fresh") === "1" }) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
