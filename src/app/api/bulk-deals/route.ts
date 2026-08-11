import { NextRequest, NextResponse } from "next/server";
import { listDeals, dealStats } from "@/lib/bulk-deals/store";
import { syncBulkDeals } from "@/lib/bulk-deals/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET — list cached deals from DB. */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const days = Number(sp.get("days") || "90") || 90;
    const limit = Math.min(1000, Number(sp.get("limit") || "200") || 200);
    const smartOnly = sp.get("smart") === "1";
    const symbol = sp.get("symbol") || undefined;
    const dealType = sp.get("type") as "bulk" | "block" | null;

    const deals = listDeals({
      days,
      limit,
      smartOnly,
      symbol,
      dealType: dealType ?? undefined,
    });
    const stats = dealStats();

    return NextResponse.json({
      ok: true,
      stats,
      count: deals.length,
      deals,
    });
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

/** POST — sync from NSE (last N days). Body: { days?: number } */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { days?: number };
    const days = Math.min(90, Math.max(1, body.days ?? 30));
    const result = await syncBulkDeals({ days });
    const smartDeals = listDeals({ days, smartOnly: true, limit: 100 });

    return NextResponse.json({
      ok: true,
      ...result,
      smart_deals: smartDeals.slice(0, 50),
    });
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
