import { NextRequest, NextResponse } from "next/server";
import { resolveQuarterPanelData } from "@/lib/quarter-metrics-compute";
import { listedPriceFor } from "@/lib/listed-price";
import { loadMetricsMap } from "@/lib/metrics";
import { forwardPeFromPanel } from "@/lib/valuation";
import { quarterChecks } from "@/lib/quarter-checks";
import { fetchScreenerAnnual } from "@/lib/screener-annual";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ticker = (sp.get("ticker") || "").trim().toUpperCase();
  const market = (sp.get("market") || "").trim() || null;
  const priceOverride = Number(sp.get("price"));
  const force = sp.get("refresh") === "1";

  if (!ticker) {
    return NextResponse.json({ error: "ticker required" }, { status: 400 });
  }

  try {
    const metrics = loadMetricsMap();
    const cached = metrics.get(ticker);
    const freshest = listedPriceFor(ticker)?.price ?? null;
    const rowPrice =
      Number.isFinite(priceOverride) && priceOverride > 0
        ? priceOverride
        : (freshest ?? cached?.price ?? null);

    const result = await resolveQuarterPanelData(
      ticker,
      market,
      rowPrice,
      force ? { force: true } : undefined,
    );

    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          ticker,
          error: result.error || "fetch failed",
          quarters: null,
        },
        { status: 500 },
      );
    }

    const snapshot = result.snapshot;
    // Recompute at the request price so a cached (older-formula / older-price)
    // value never leaks through.
    const livePrice = result.price ?? rowPrice;
    const forwardPe =
      result.panel && livePrice
        ? forwardPeFromPanel(livePrice, result.panel)
        : (snapshot?.forward_pe ?? null);
    const annual = await fetchScreenerAnnual(ticker, { cacheOnly: true }).catch(() => null);
    const checks = quarterChecks(result.panel, annual?.sales);
    // Wrong-looking series: keep the chart, drop YoY (it would be wrong too).
    const yoyOk = !checks.breaks && !checks.mismatch;
    const mk = (market || "").trim().toUpperCase();
    const noPanelError = !result.panel
      ? mk === "NSE SME" || mk === "BSE SME"
        ? "No quarterly fundamentals yet (Yahoo/NSE/BSE/Screener/Groww) — common for recent SME listings"
        : "No quarterly data available"
      : undefined;

    return NextResponse.json({
      ok: true,
      ticker,
      market,
      symbol: result.symbol || undefined,
      source: result.panel ? result.source : result.source,
      price: result.price ?? rowPrice ?? undefined,
      forward_pe: forwardPe ?? undefined,
      checks,
      warning: checks.warning,
      yoy: snapshot && yoyOk
        ? {
            sales_yoy: snapshot.sales_yoy,
            np_yoy: snapshot.np_yoy,
            eps_yoy: snapshot.eps_yoy,
            ebidt_yoy: snapshot.extras?.ebidt_yoy ?? null,
          }
        : undefined,
      extras: snapshot?.extras ?? undefined,
      quarters: result.panel,
      error: noPanelError,
      cached: result.fromCache ?? false,
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
