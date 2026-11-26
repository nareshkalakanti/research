import { NextRequest, NextResponse } from "next/server";
import { fundDashboard } from "@/lib/fund-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/fund-dashboard?a=niveshaay&b=kacholia → two followed investors compared by sector. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const keys = [sp.get("a") || "niveshaay", sp.get("b") || "kacholia"];
  try {
    return NextResponse.json({ ok: true, ...fundDashboard(keys) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
