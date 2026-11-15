import { NextRequest, NextResponse } from "next/server";
import { buildNanoPage, nanoFillJob, startNanoFill } from "@/lib/nanocap-champs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: page data. GET ?job=1: progress of the background fill. */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("job") === "1") {
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  try {
    return NextResponse.json({ ok: true, ...buildNanoPage(), job: nanoFillJob() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** POST {kind}: start a background fill of 25 stocks (quarters or ROCE); returns at once. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { kind?: string };
  const job = startNanoFill(body.kind === "quality" ? "quality" : "nano");
  return NextResponse.json({ ok: true, job });
}
