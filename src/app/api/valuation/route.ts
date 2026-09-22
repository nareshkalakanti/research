import { NextRequest, NextResponse } from "next/server";
import { loadAllCompanies } from "@/lib/db";
import { getMetrics } from "@/lib/metrics";
import { fetchScreenerAnnualPl } from "@/lib/screener-annual";
import { listLatestConcallPassByTickers } from "@/lib/concall-screen";
import type { ValuationHistSeries } from "@/lib/valuation-model";

export const runtime = "nodejs";
export const maxDuration = 120;

function taxPctFromAbs(
  tax: Array<number | null>,
  pbt: Array<number | null>,
): Array<number | null> {
  return tax.map((t, i) => {
    if (t != null && Number.isFinite(t) && Math.abs(t) <= 100) return t;
    const p = pbt[i];
    if (t == null || p == null || !Number.isFinite(p) || p === 0) return null;
    // Screener Tax row is often ₹ Cr; convert to %.
    return Math.round((t / p) * 1000) / 10;
  });
}

function sharesFromEpsPat(
  eps: Array<number | null>,
  pat: Array<number | null>,
): Array<number | null> {
  return eps.map((e, i) => {
    const p = pat[i];
    if (e == null || p == null || !Number.isFinite(e) || e === 0) return null;
    return Math.round((p / e) * 100) / 100;
  });
}

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "")
    .trim()
    .toUpperCase();
  const force = req.nextUrl.searchParams.get("force") === "1";
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }

  const companies = loadAllCompanies();
  const company = companies.find((c) => c.ticker.toUpperCase() === ticker);
  const metrics = getMetrics(ticker);
  const pl = await fetchScreenerAnnualPl(ticker, { force });

  const tax_pct = taxPctFromAbs(pl.tax, pl.pbt);
  const shares_cr = pl.shares_cr.some((s) => s != null)
    ? pl.shares_cr
    : sharesFromEpsPat(pl.eps, pl.pat);

  const series: ValuationHistSeries = {
    dates: pl.dates,
    revenue: pl.revenue,
    expenses: pl.expenses,
    operating_profit: pl.operating_profit,
    other_income: pl.other_income,
    interest: pl.interest,
    depreciation: pl.depreciation,
    pbt: pl.pbt,
    tax_pct,
    pat: pl.pat,
    shares_cr,
    eps: pl.eps,
  };

  const price = metrics?.price ?? company?.price ?? null;
  const lastEps = [...pl.eps].reverse().find((e) => e != null && e > 0) ?? null;
  const pe =
    price != null && lastEps != null && lastEps > 0
      ? Math.round((price / lastEps) * 10) / 10
      : null;

  const pass = listLatestConcallPassByTickers([ticker]).get(ticker) ?? null;
  const concall = pass
    ? {
        period: pass.period,
        call_date: pass.call_date,
        result_quality: pass.result_quality,
        mgmt_sentiment: pass.mgmt_sentiment,
        sentiment_score: pass.sentiment_score,
        revenue_cr: pass.revenue_cr,
        revenue_yoy_pct: pass.revenue_yoy_pct,
        ebitda_margin_pct: pass.ebitda_margin_pct,
        guidance_label: pass.guidance_label,
        drift_pct: pass.drift_pct,
        highlights: pass.highlights,
        why_own: pass.why_own,
        risk: pass.risk,
        next_catalyst: pass.next_catalyst,
        valuation_anchor: pass.valuation_anchor,
      }
    : null;

  return NextResponse.json({
    ok: true,
    ticker,
    name: company?.name || ticker,
    market: company?.market || metrics?.market || null,
    price,
    pe,
    mcap_cr: metrics?.market_cap_cr ?? company?.mcap_cr ?? null,
    change_pct: null as number | null,
    series,
    concall,
    source: "screener",
  });
}
