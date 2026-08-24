import { NextRequest, NextResponse } from "next/server";
import {
  computeAndCacheQuarterMetrics,
  metricsSnapshotFromPanel,
  type QuarterMetricsSnapshot,
} from "@/lib/quarter-metrics-compute";
import { buildQuarterPanel, computeCfProfit } from "@/lib/quarter-panel";
import { loadMetricsMap } from "@/lib/metrics";
import {
  isQuarterMetricsFresh,
  loadQuarterMetricsMap,
  type QuarterMetricsRow,
} from "@/lib/quarter-metrics-cache";
import { fetchQuarterlyFundamentals } from "@/lib/yahoo-quarters";

export const runtime = "nodejs";
export const maxDuration = 60;

function snapshotFromCache(row: QuarterMetricsRow): QuarterMetricsSnapshot {
  return {
    forward_pe: row.forward_pe,
    eps_yoy: row.eps_yoy,
    sales_yoy: row.sales_yoy,
    np_yoy: row.np_yoy,
    extras: {
      sales_qoq: row.sales_qoq,
      np_qoq: row.np_qoq,
      eps_qoq: row.eps_qoq,
      ebidt_yoy: row.ebidt_yoy,
      cf_profit: row.cf_profit,
    },
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ticker = (sp.get("ticker") || "").trim().toUpperCase();
  const market = (sp.get("market") || "").trim() || null;
  const priceOverride = Number(sp.get("price"));

  if (!ticker) {
    return NextResponse.json({ error: "ticker required" }, { status: 400 });
  }

  try {
    const metrics = loadMetricsMap();
    const cached = metrics.get(ticker);
    const rowPrice =
      Number.isFinite(priceOverride) && priceOverride > 0
        ? priceOverride
        : (cached?.price ?? null);

    const qm = loadQuarterMetricsMap().get(ticker);
    let snapshot: QuarterMetricsSnapshot | null = null;
    let panel = null;
    let symbol: string | undefined;
    let source: string | undefined;

    if (qm && isQuarterMetricsFresh(qm)) {
      snapshot = snapshotFromCache(qm);
      const live = await fetchQuarterlyFundamentals(ticker, market);
      panel = buildQuarterPanel(live.quarters);
      symbol = live.symbol;
      source = panel ? live.source : undefined;
      if (panel) {
        snapshot = metricsSnapshotFromPanel(
          panel,
          rowPrice,
          computeCfProfit(
            live.operating_cashflow,
            live.quarters.at(-1)?.netIncome ?? null,
          ),
        );
      }
    } else {
      const result = await computeAndCacheQuarterMetrics(
        ticker,
        market,
        rowPrice,
      );
      if (!result.ok) {
        return NextResponse.json(
          { ok: false, ticker, error: "fetch failed", quarters: null },
          { status: 500 },
        );
      }
      snapshot = result.snapshot;
      panel = result.panel;
      symbol = result.symbol;
      source = result.panel ? result.source : undefined;
    }

    return NextResponse.json({
      ok: true,
      ticker,
      market,
      symbol: symbol || undefined,
      source,
      price: rowPrice ?? undefined,
      forward_pe: snapshot?.forward_pe ?? undefined,
      yoy: snapshot
        ? {
            sales_yoy: snapshot.sales_yoy,
            np_yoy: snapshot.np_yoy,
            eps_yoy: snapshot.eps_yoy,
            ebidt_yoy: snapshot.extras?.ebidt_yoy ?? null,
          }
        : undefined,
      extras: snapshot?.extras ?? undefined,
      quarters: panel,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        ticker,
        error: e instanceof Error ? e.message : "fetch failed",
        quarters: null,
      },
      { status: 500 },
    );
  }
}
