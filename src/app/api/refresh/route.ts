import { NextResponse } from "next/server";
import { invalidateBrutalCache } from "@/lib/brutal-scan";
import { invalidateCompanyCache } from "@/lib/db";
import { invalidateEdgeCache } from "@/lib/edge";
import { invalidateFundWatchlistCache } from "@/lib/fund-watchlists";
import { invalidateFundamentalsScanCache, invalidateQuarterOverlayCache } from "@/lib/fundamentals-scan";
import { invalidateHoldingsCache } from "@/lib/holdings";
import { invalidateListedPriceMap } from "@/lib/listed-price";
import { invalidateMetricsCache } from "@/lib/metrics";
import { clearQualityFlagsMemo } from "@/lib/napkin/quality-flags";
import { invalidateNotesCache } from "@/lib/notes";
import { invalidateOperatingMetricsCache, invalidateStableOpmCache } from "@/lib/opm-consistency";
import { clearReviewScores } from "@/lib/portfolio-review";
import { clearPriceActionCache } from "@/lib/price-action-screen";
import { clearBreakoutCache } from "@/lib/breakout-screen";
import { clearMomentumMoneyCache } from "@/lib/momentum-money";
import { invalidateQuantBasketCache } from "@/lib/quant-basket";
import { invalidateQuarterMetricsCache } from "@/lib/quarter-metrics-cache";
import { clearQuarterPanelMemo } from "@/lib/quarter-metrics-compute";
import { clearScannerCache } from "@/lib/scanner";
import { invalidateRotationRank } from "@/lib/sector-rotation-board";
import { invalidateSevenRuleScanCache } from "@/lib/seven-rule-scan";
import { invalidateBreakoutCache } from "@/lib/signals";
import { invalidateSmaStackCache } from "@/lib/sma-stack-cache";
import { clearValueCaches } from "@/lib/value-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST: drop the server's in-memory copies so every page reads the databases
 * again (stock list, prices, Value tools incl. Industry cycle, rotation ranks,
 * Evaluation and Napkin quality scores, quarters, Price Action, scan lists).
 * Used by the Refresh button in the top bar. Fetches nothing from outside.
 * Governance map is left alone: it has its own Refresh, and a forced rebuild
 * can race governance writes.
 */
export async function POST() {
  clearScannerCache();
  clearValueCaches();
  invalidateMetricsCache();
  invalidateListedPriceMap();
  invalidateRotationRank();
  clearReviewScores();
  clearQualityFlagsMemo();
  clearPriceActionCache();
  clearBreakoutCache();
  clearMomentumMoneyCache();
  clearQuarterPanelMemo();
  invalidateQuarterMetricsCache();
  invalidateQuarterOverlayCache();
  invalidateFundamentalsScanCache();
  invalidateSevenRuleScanCache();
  invalidateQuantBasketCache();
  invalidateStableOpmCache();
  invalidateOperatingMetricsCache();
  invalidateSmaStackCache();
  invalidateBreakoutCache();
  invalidateBrutalCache();
  invalidateHoldingsCache();
  invalidateFundWatchlistCache();
  invalidateEdgeCache();
  invalidateNotesCache();
  invalidateCompanyCache();
  return NextResponse.json({ ok: true, at: new Date().toISOString() });
}
