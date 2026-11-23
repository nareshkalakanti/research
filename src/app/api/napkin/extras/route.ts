import { NextRequest, NextResponse } from "next/server";
import { buildNapkinExtras } from "@/lib/napkin/extras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?ticker= — corp actions, other-income %, promoter, OCF, analyst (if useful). */
export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "").trim();
  if (!ticker) return NextResponse.json({ ok: false, error: "Need ticker" }, { status: 400 });
  try {
    const data = await buildNapkinExtras(ticker);
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
