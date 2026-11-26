import { NextRequest, NextResponse } from "next/server";
import { buildIpo2Screen } from "@/lib/ipo2-screen";

export const runtime = "nodejs";

/** GET /api/ipo2 → stocks listed in the last 4 years with stage and kept entries; ?refresh=1 rebuilds. */
export async function GET(req: NextRequest) {
  try {
    const result = await buildIpo2Screen({ refresh: req.nextUrl.searchParams.get("refresh") === "1" });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
