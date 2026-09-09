import { NextRequest, NextResponse } from "next/server";
import { listScanInvestors, scanInvestorBatch } from "@/lib/superstars/scan";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Scan status / investor count. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    total: listScanInvestors().length,
  });
}

/** Batch-pull latest Trendlyne superstar holdings → superstar_holdings.db */
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
    return NextResponse.json(result, {
      status: result.ok ? 200 : 503,
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
