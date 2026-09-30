import { NextRequest, NextResponse } from "next/server";
import { runHoldingsMeanVariance } from "@/lib/holdings-mv";

export const runtime = "nodejs";
export const maxDuration = 180;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const lambda = Number(req.nextUrl.searchParams.get("lambda") || 8);
  const maxW = Number(req.nextUrl.searchParams.get("maxW") || 0);
  try {
    const result = await runHoldingsMeanVariance({
      lambda,
      maxW: maxW > 0 ? maxW : undefined,
    });
    return NextResponse.json({ ok: true as const, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Mean-variance failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
