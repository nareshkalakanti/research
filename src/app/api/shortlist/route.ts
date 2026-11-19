import { NextRequest, NextResponse } from "next/server";
import { nanoFillJob, startNanoFill } from "@/lib/nanocap-champs";
import { buildShortlist, fillShortlist, stopShortlistFill } from "@/lib/shortlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: Shortlist page data. GET ?job=1: progress of the tax & debt fill. */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("job") === "1") {
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  try {
    const page = buildShortlist({ fresh: req.nextUrl.searchParams.get("fresh") === "1" });
    return NextResponse.json({ ok: true, ...page, job: nanoFillJob() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** POST {stop?, themes?}: start (or stop) the tax & debt fill; returns at once. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { stop?: boolean; themes?: string[] };
  if (body.stop) {
    stopShortlistFill();
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  const job = startNanoFill("shortlist", (p) => fillShortlist(p, { themes: body.themes }));
  return NextResponse.json({ ok: true, job });
}
