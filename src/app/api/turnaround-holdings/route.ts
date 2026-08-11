import { NextRequest, NextResponse } from "next/server";
import {
  loadTurnaroundHoldings,
  turnaroundScanSymbols,
  turnaroundSeedNotInHoldings,
  TURNAROUND_SEED_TICKERS,
} from "@/lib/turnaround-holdings";
import { listCachedCandidates } from "@/lib/hidden-portfolio/store";
import { symbolsMatch } from "@/lib/bulk-deals/nse";
import {
  fetchDistressMetricsBatch,
  scoreDistressTurnaround,
  DISTRESS_DISCOVERY_GATES,
  DISTRESS_FLAG_LABELS,
} from "@/lib/distress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET — turnaround holdings + distress tags + optional alpha cache. */
export async function GET(req: NextRequest) {
  try {
    const refresh = req.nextUrl.searchParams.get("refresh") === "1";
    const holdings = loadTurnaroundHoldings();
    const cached = listCachedCandidates({ limit: 500 });

    const metrics = await fetchDistressMetricsBatch(
      holdings.map((h) => ({
        ticker: h.ticker,
        market: h.market,
        isSeed: true,
      })),
    );

    const scored = metrics.map((m) => scoreDistressTurnaround(m));
    const byTicker = new Map(scored.map((s) => [s.metrics.ticker, s]));

    const rows = holdings.map((h) => {
      const cand = cached.find((c) => symbolsMatch(c.symbol, h.yahoo_symbol));
      const distress = byTicker.get(h.ticker.toUpperCase());
      return {
        ...h,
        distress: distress
          ? {
              distress_score: distress.distress_score,
              distress_flags: distress.distress_flags,
              distress_reason: distress.distress_reason,
              flag_labels: distress.distress_flags.map(
                (f) => DISTRESS_FLAG_LABELS[f] ?? f,
              ),
              drawdown_pct: distress.metrics.drawdown_pct,
              bounce_pct: distress.metrics.bounce_pct,
              eps_yoy: distress.metrics.eps_yoy,
              sales_yoy: distress.metrics.sales_yoy,
              pe: distress.metrics.pe,
              mcap_cr: distress.metrics.mcap_cr,
              price: distress.metrics.price,
              returns_pct: distress.metrics.returns_pct,
            }
          : null,
        cached: cand
          ? {
              alpha_score: cand.alpha_score,
              mcap_cr: cand.mcap_cr,
              price: cand.price,
              smart_money_flag: cand.smart_money_flag,
              top_headline: cand.top_headline,
              moat_keywords: cand.moat_keywords,
              growth_keywords: cand.growth_keywords,
              fetched_at: cand.fetched_at,
            }
          : null,
      };
    });

    rows.sort(
      (a, b) =>
        (b.distress?.distress_score ?? 0) - (a.distress?.distress_score ?? 0),
    );

    return NextResponse.json({
      ok: true,
      refreshed: refresh,
      seed_count: TURNAROUND_SEED_TICKERS.length,
      holdings_count: holdings.length,
      missing_from_portfolio: turnaroundSeedNotInHoldings(),
      scan_symbols: turnaroundScanSymbols(),
      discovery_gates: DISTRESS_DISCOVERY_GATES,
      flag_labels: DISTRESS_FLAG_LABELS,
      rows,
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
