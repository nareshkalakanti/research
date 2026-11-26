import { NextRequest, NextResponse } from "next/server";
import { addPick, addPicks, addSource, readPicks, removePick, removeSource, renameSource } from "@/lib/picks-tracker";

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
 *   { action: "rename-source", name, to }                    → rename a source (its picks move with it)
 *   { action: "add", source, quarter, ticker, market?, name? } → add a stock to a source's quarter
 *   { action: "add-many", source, quarter, items: [{ ticker, market?, name? }] }
 *                                                            → add a list of stocks (also returns { result: { added, already } })
 *   { action: "remove", source, quarter, ticker }            → remove it
 * Returns the updated data.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (body.action === "add-many") {
      const items = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
      const result = addPicks({ source: String(body.source ?? ""), quarter: String(body.quarter ?? ""), items });
      return NextResponse.json({ ok: true, result, ...readPicks() });
    }
    const b = body as Record<string, string>;
    if (b.action === "source") addSource(b.name ?? "");
    else if (b.action === "remove-source") removeSource(b.name ?? "");
    else if (b.action === "rename-source") renameSource(b.name ?? "", b.to ?? "");
    else if (b.action === "add") addPick({ source: b.source ?? "", quarter: b.quarter ?? "", ticker: b.ticker ?? "", market: b.market, name: b.name });
    else if (b.action === "remove") removePick({ source: b.source ?? "", quarter: b.quarter ?? "", ticker: b.ticker ?? "" });
    else return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
    return NextResponse.json({ ok: true, ...readPicks() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
