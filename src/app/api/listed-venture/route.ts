import { NextRequest, NextResponse } from "next/server";
import { computeListedVentureScreen } from "@/lib/listed-venture-score";
import { runQuartersFillBatch } from "@/lib/quarters-fill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET ?list=others&limit=100 — Listed Venture screen + validation vs list. */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const result = computeListedVentureScreen({
      listKey: (sp.get("list") || "others").trim(),
      limit: Number(sp.get("limit")) || 100,
      mcapMin: sp.get("mcapMin") ? Number(sp.get("mcapMin")) : null,
      mcapMax: sp.get("mcapMax") ? Number(sp.get("mcapMax")) : null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "screen failed" },
      { status: 500 },
    );
  }
}

/**
 * POST { action: "fill" } — fetch quarters for the next batch of universe
 * names missing them. Yahoo / NSE / BSE / Groww only — never Screener.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      skip?: string[];
    };
    if (body.action !== "fill") {
      return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
    }
    const skip = new Set((body.skip ?? []).map((t) => t.toUpperCase()));
    const { missing_quarters } = computeListedVentureScreen({ limit: 10 });
    const todo = missing_quarters.filter((t) => !skip.has(t));
    const batch = todo.slice(0, 24);
    if (!batch.length) {
      return NextResponse.json({ ok: true, attempted: [], saved: 0, remaining: 0 });
    }
    const res = await runQuartersFillBatch({
      tickers: batch,
      limit: batch.length,
      concurrency: 4,
      missingOnly: false,
      noScreener: true,
    });
    return NextResponse.json({
      ok: true,
      attempted: batch,
      saved: res.saved_tickers?.length ?? 0,
      remaining: todo.length - batch.length,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "fill failed" },
      { status: 500 },
    );
  }
}
