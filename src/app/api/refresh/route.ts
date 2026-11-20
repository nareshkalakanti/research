import { NextResponse } from "next/server";
import { invalidateMetricsCache } from "@/lib/metrics";
import { clearReviewScores } from "@/lib/portfolio-review";
import { clearScannerCache } from "@/lib/scanner";
import { invalidateRotationRank } from "@/lib/sector-rotation-board";
import { clearValueCaches } from "@/lib/value-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST: drop the server's in-memory caches (stock list, prices, value tools,
 * rotation ranks) so the next load reads the databases again. Used by the
 * Refresh button in the top bar. Fetches nothing from outside.
 */
export async function POST() {
  clearScannerCache();
  clearValueCaches();
  invalidateMetricsCache();
  invalidateRotationRank();
  clearReviewScores();
  return NextResponse.json({ ok: true, at: new Date().toISOString() });
}
