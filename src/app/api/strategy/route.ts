import { NextRequest, NextResponse } from "next/server";
import { invalidateCompanyCache } from "@/lib/db";
import { syncNseBuybackActions } from "@/lib/strategy/buyback-scan";
import { runBuybackScanBatch } from "@/lib/strategy/buyback-scan";
import {
  buybackFilterCounts,
  buybackStats,
  loadBuybackSummaries,
  loadLiquidityScores,
  liquidityStats,
  pendingBuybackTickers,
  pendingLiquidityTickers,
  strategyCapCounts,
} from "@/lib/strategy/buyback-store";
import { runLiquidityScanBatch } from "@/lib/strategy/liquidity-scan";
import {
  parseStrategyTagFilters,
  strategyTagCounts,
} from "@/lib/strategy/strategy-tags";
import type { CapTier } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  kind?: "buyback" | "liquidity";
  market?: string;
  tickers?: string[];
  limit?: number;
  missingOnly?: boolean;
  syncActions?: boolean;
};

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const market = sp.get("market") || "All";
  const kind = sp.get("kind") || "buyback";
  const cap = (sp.get("cap") || "All") as CapTier | "All";
  const minScore = Number(sp.get("minScore") || "0");
  const onlyMatches = sp.get("onlyMatches") === "1";
  const openOnly = sp.get("open") === "1";
  const tenderOnly = sp.get("tender") === "1";
  const minSpreadPct = sp.get("spread8") === "1" ? 8 : undefined;
  const buyableOnly = sp.get("buy") === "1";
  const tags = parseStrategyTagFilters(sp);
  const refresh = sp.get("refresh") === "1";

  if (refresh) {
    invalidateCompanyCache();
    if (kind === "buyback") {
      try {
        await syncNseBuybackActions();
      } catch {
        /* best-effort — still return cached rows */
      }
    }
  }

  if (kind === "liquidity") {
    const allRows = loadLiquidityScores({
      market,
      minScore: 0,
      onlyMatches: false,
      limit: 5000,
    });
    const rows = loadLiquidityScores({
      market,
      cap,
      minScore,
      onlyMatches,
      limit: 500,
      tags,
    });
    return NextResponse.json({
      ok: true,
      kind,
      market,
      cap,
      stats: liquidityStats(),
      pending: pendingLiquidityTickers({ market }).length,
      cap_counts: strategyCapCounts(allRows),
      tag_counts: strategyTagCounts(
        allRows.map((r) => ({ ticker: r.ticker, market: r.market })),
      ),
      all_count: allRows.length,
      rows,
    });
  }

  const allRows = loadBuybackSummaries({ market, limit: 10000 });
  const rows = loadBuybackSummaries({
    market,
    cap,
    limit: 500,
    tags,
    openOnly,
    tenderOnly,
    buyableOnly,
    minSpreadPct,
  });
  const filterCounts = buybackFilterCounts(allRows);
  return NextResponse.json({
    ok: true,
    kind,
    market,
    cap,
    stats: buybackStats(),
    pending: pendingBuybackTickers({ market }).length,
    cap_counts: strategyCapCounts(allRows),
    tag_counts: strategyTagCounts(
      allRows.map((r) => ({ ticker: r.ticker, market: r.market })),
    ),
    open_count: filterCounts.open,
    tender_count: filterCounts.tender,
    spread8_count: filterCounts.spread8,
    buy_count: filterCounts.buy,
    history_count: filterCounts.history,
    all_count: allRows.length,
    rows,
  });
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const kind = body.kind || "buyback";
  const market = body.market || "All";
  const limit = Math.min(24, Math.max(1, Number(body.limit) || 8));
  const missingOnly = body.missingOnly !== false;

  try {
    if (kind === "liquidity") {
      const result = await runLiquidityScanBatch({
        market,
        tickers: body.tickers,
        limit,
        missingOnly,
      });
      return NextResponse.json({
        ok: true,
        kind,
        ...result,
        message:
          result.tried === 0
            ? "Nothing left to scan"
            : `Scored ${result.saved} · ${result.failed} failed · ${result.remaining.toLocaleString()} left`,
      });
    }

    const result = await runBuybackScanBatch({
      market,
      tickers: body.tickers,
      limit,
      missingOnly,
      syncActions: body.syncActions === true,
    });
    return NextResponse.json({
      ok: true,
      kind,
      ...result,
      message:
        result.tried === 0
          ? "Nothing left to scan"
          : `Synced ${result.synced_actions} actions · detailed ${result.saved} · ${result.remaining.toLocaleString()} left`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Strategy scan failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 503 });
  }
}
