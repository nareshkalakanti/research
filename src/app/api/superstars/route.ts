import { NextRequest, NextResponse } from "next/server";
import { loadAllHoldings, loadConsensus } from "@/lib/superstars/store";
import { listScanInvestors, scanInvestorBatch } from "@/lib/superstars/scan";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const view = (sp.get("view") || "portfolio").toLowerCase();
  const investor = sp.get("investor");
  const change = sp.get("change");
  const q = sp.get("q");
  const sector = sp.get("sector");
  const curated = sp.get("curated") !== "0";
  const limit = Math.min(Number(sp.get("limit") || 400) || 400, 2000);
  const minInvestors = Math.max(2, Number(sp.get("min") || 2) || 2);
  const minPct = sp.get("minPct") ? Number(sp.get("minPct")) : null;
  const minValue = sp.get("minValue") ? Number(sp.get("minValue")) : null;
  const minPrice = sp.get("minPrice") ? Number(sp.get("minPrice")) : null;
  const maxPrice = sp.get("maxPrice") ? Number(sp.get("maxPrice")) : null;

  if (view === "scan-status") {
    return NextResponse.json({
      ok: true,
      total: listScanInvestors().length,
    });
  }

  try {
    if (view === "consensus") {
      const data = loadConsensus({
        minInvestors,
        curatedOnly: curated,
        q,
        sector,
        minPct: Number.isFinite(minPct) ? minPct : null,
        minValue: Number.isFinite(minValue) ? minValue : null,
        minPrice: Number.isFinite(minPrice) ? minPrice : null,
        maxPrice: Number.isFinite(maxPrice) ? maxPrice : null,
        limit,
      });
      return NextResponse.json({ ok: true, view: "consensus", ...data });
    }

    const data = loadAllHoldings({
      investor: investor || null,
      curatedOnly: curated && !investor,
      change: change || null,
      q,
      sector,
      minPct: Number.isFinite(minPct) ? minPct : null,
      minValue: Number.isFinite(minValue) ? minValue : null,
      minPrice: Number.isFinite(minPrice) ? minPrice : null,
      maxPrice: Number.isFinite(maxPrice) ? maxPrice : null,
      limit,
    });
    return NextResponse.json({ ok: true, view: "portfolio", ...data });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      offset?: number;
      limit?: number;
      includeFunds?: boolean;
    };
    const result = await scanInvestorBatch({
      offset: body.offset ?? 0,
      limit: body.limit ?? 4,
      includeFunds: body.includeFunds !== false,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
