import { NextRequest, NextResponse } from "next/server";
import { buildMicrocapDistribution } from "@/lib/microcap-distribution";
import {
  buildMicrocapSectorReturns,
  fillMicrocapDivYields,
  listMicrocapMissingDivYields,
  listMicrocapStocks,
  type MicrocapBoardFilter,
} from "@/lib/microcap-sector-returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function parseBoard(raw: string): MicrocapBoardFilter {
  const v = raw.toLowerCase();
  return v === "main" || v === "sme" ? v : "all";
}

function parseMinN(raw: string | null): number {
  const n = Number(raw || "2");
  return Number.isFinite(n) ? Math.max(1, Math.min(50, Math.floor(n))) : 2;
}

function parseMaxMcap(raw: string | null): number {
  const n = Number(raw || "1000");
  return Number.isFinite(n) ? Math.max(100, Math.min(100_000, Math.floor(n))) : 1000;
}

/**
 * GET /api/microcap              → cumulative mcap distribution (Main vs SME)
 * GET /api/microcap?view=sectors → avg 12M returns by sector › industry / sub_sector
 * GET /api/microcap?view=stocks&sector=…&industry=… → names in that pocket / sector
 * GET /api/microcap?view=missing-div → board-wide names missing cached div yield
 *   &board=all|main|sme &minN=2 &maxMcap=1000 (Cr; default 1000)
 *
 * POST /api/microcap
 *   { action: "fill-div", board?, maxMcap?, tickers?: [...] }
 *   → if tickers omitted, fills all missing on the board (batched server-side up to 200 / call)
 */
export async function GET(req: NextRequest) {
  try {
    const view = (req.nextUrl.searchParams.get("view") || "").trim().toLowerCase();
    const board = parseBoard(req.nextUrl.searchParams.get("board") || "all");
    const minIndustryN = parseMinN(req.nextUrl.searchParams.get("minN"));
    const maxMcapCr = parseMaxMcap(req.nextUrl.searchParams.get("maxMcap"));

    if (view === "sectors") {
      return NextResponse.json({ ok: true, ...buildMicrocapSectorReturns({ board, minIndustryN, maxMcapCr }) });
    }
    if (view === "stocks") {
      const sector = (req.nextUrl.searchParams.get("sector") || "").trim();
      if (!sector) {
        return NextResponse.json({ ok: false, error: "sector is required" }, { status: 400 });
      }
      const industryRaw = req.nextUrl.searchParams.get("industry");
      const industry = industryRaw == null || industryRaw === "" ? null : industryRaw;
      return NextResponse.json({
        ok: true,
        ...listMicrocapStocks({ sector, industry, board, minIndustryN, maxMcapCr }),
      });
    }
    if (view === "missing-div") {
      return NextResponse.json({ ok: true, ...listMicrocapMissingDivYields({ board, maxMcapCr }) });
    }
    return NextResponse.json({ ok: true, ...buildMicrocapDistribution() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action?: string;
      board?: string;
      maxMcap?: number | string;
      /** Optional explicit list; otherwise fill next batch of board-wide missing. */
      tickers?: Array<{ ticker?: string; name?: string | null }>;
      /** Max names to pull this request (default 60). */
      limit?: number;
    };
    if ((body.action || "").trim().toLowerCase() !== "fill-div") {
      return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
    }

    const board = parseBoard(body.board || "all");
    const maxMcapCr = parseMaxMcap(body.maxMcap != null ? String(body.maxMcap) : "1000");
    // Keep batches small — Tickertape + long scans trip proxies / browser fetch.
    const limitRaw = Number(body.limit ?? 15);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(40, Math.floor(limitRaw))) : 15;

    let items = (body.tickers || [])
      .map((t) => ({ ticker: (t.ticker || "").trim().toUpperCase(), name: t.name ?? null }))
      .filter((t) => t.ticker);

    let remaining_after = 0;
    if (!items.length) {
      const miss = listMicrocapMissingDivYields({ board, maxMcapCr });
      items = miss.missing.slice(0, limit).map((m) => ({ ticker: m.ticker, name: m.name }));
      remaining_after = Math.max(0, miss.missing.length - items.length);
    }
    if (!items.length) {
      return NextResponse.json({
        ok: true,
        tried: 0,
        filled: 0,
        failed: 0,
        still_missing: 0,
        remaining: 0,
      });
    }

    const result = await fillMicrocapDivYields(items);
    // Only re-scan the board when the client did not send an explicit ticker list
    // (board-wide auto-batch). Explicit batches already know remaining client-side.
    const remaining =
      body.tickers && body.tickers.length
        ? remaining_after
        : listMicrocapMissingDivYields({ board, maxMcapCr }).missing.length;
    return NextResponse.json({
      ok: true,
      ...result,
      remaining,
      remaining_queued: remaining_after,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
