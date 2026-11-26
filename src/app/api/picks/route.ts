import { NextRequest, NextResponse } from "next/server";
import { addPick, addSource, readPicks, removePick, removeSource } from "@/lib/picks-tracker";

export const runtime = "nodejs";

/** GET /api/picks → all sources and the stocks entered per quarter (with sector / industry). */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, ...readPicks() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}

/**
 * POST /api/picks
 *   { action: "source", name }                               → add a source
 *   { action: "remove-source", name }                        → delete a source and all its picks
 *   { action: "add", source, quarter, ticker, market?, name? } → add a stock to a source's quarter
 *   { action: "remove", source, quarter, ticker }            → remove it
 * Returns the updated data.
 */
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, string>;
    if (b.action === "source") addSource(b.name ?? "");
    else if (b.action === "remove-source") removeSource(b.name ?? "");
    else if (b.action === "add") addPick({ source: b.source ?? "", quarter: b.quarter ?? "", ticker: b.ticker ?? "", market: b.market, name: b.name });
    else if (b.action === "remove") removePick({ source: b.source ?? "", quarter: b.quarter ?? "", ticker: b.ticker ?? "" });
    else return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
    return NextResponse.json({ ok: true, ...readPicks() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
