import { NextRequest, NextResponse } from "next/server";
import { blankFixStatus, startArFill, startBlankFix, stopArFill, stopBlankFix } from "@/lib/governance-blank-fix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: status of the blank-director-category fix. */
export async function GET() {
  return NextResponse.json({ ok: true, ...blankFixStatus() });
}

/** POST {} starts the NSE fetch; {mode:"ar"} the annual-report fill; add stop:true to stop. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { stop?: boolean; mode?: string };
  if (body.mode === "ar") {
    if (body.stop) stopArFill();
    else startArFill();
  } else if (body.stop) stopBlankFix();
  else startBlankFix();
  return NextResponse.json({ ok: true, ...blankFixStatus() });
}
