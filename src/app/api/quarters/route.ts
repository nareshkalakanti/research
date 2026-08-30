import { NextRequest, NextResponse } from "next/server";
import { resolveQuarterPanelData } from "@/lib/quarter-metrics-compute";
import { loadMetricsMap } from "@/lib/metrics";

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
    const rowPrice =
      Number.isFinite(priceOverride) && priceOverride > 0
        ? priceOverride
        : (cached?.price ?? null);

    const result = await resolveQuarterPanelData(
      ticker,
      market,
      rowPrice,
      force ? { force: true } : undefined,
    );

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, ticker, error: "fetch failed", quarters: null },
        { status: 500 },
      );
    }

    const snapshot = result.snapshot;
    const mk = (market || "").trim().toUpperCase();
    const noPanelError = !result.panel
      ? mk === "NSE SME" || mk === "BSE SME"
        ? "No exchange fundamentals yet (Yahoo/NSE/BSE) — common for recent SME listings"
        : "No quarterly data available"
      : undefined;

    return NextResponse.json({
      ok: true,
      ticker,
      market,
      symbol: result.symbol || undefined,
      source: result.panel ? result.source : result.source,
      price: result.price ?? rowPrice ?? undefined,
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
