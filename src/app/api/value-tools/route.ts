import { NextRequest, NextResponse } from "next/server";
import { nanoFillJob, startNanoFill, triedWithin } from "@/lib/nanocap-champs";
import { lastBasketsRefresh } from "@/lib/baskets-refresh";
import { screenerBudgetLeft } from "@/lib/momentum";
import { screenerPausedUntil } from "@/lib/screener-fetch";
import { buildHeadwinds, buildIndustryCycle, buildSectorValuation, VAL, buildValueUniverse, CYCLE, fillValueQuality, stopValueFill, WIND } from "@/lib/value-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?kind=universe (ranking data) | winds (industry Headwind / Tailwind). */
export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("kind") || "universe";
  if (kind === "job") return NextResponse.json({ ok: true, job: nanoFillJob() });
  if (kind === "auto") {
    // Background fill status (30-min job, Value-tab gaps): last 24 h.
    const tried = triedWithin("valq", 86_400_000);
    const ranked = new Set(buildValueUniverse().rows.filter((r) => r.sales3y != null).map((r) => r.t.toUpperCase()));
    const last = lastBasketsRefresh();
    return NextResponse.json({
      ok: true,
      last_run: last,
      next_run: last ? new Date(Date.parse(last) + 30 * 60_000).toISOString() : null,
      tried_24h: tried.length,
      filled_24h: tried.filter((t) => ranked.has(t.toUpperCase())).length,
      screener_paused_until: screenerPausedUntil(),
      pages_left_this_hour: screenerBudgetLeft(),
      job: nanoFillJob(),
    });
  }
  try {
    if (kind === "valuation") {
      const data = await buildSectorValuation({ fresh: req.nextUrl.searchParams.get("fresh") === "1" });
      return NextResponse.json({ ok: true, rules: VAL, ...data });
    }
    if (kind === "cycle") {
      const data = await buildIndustryCycle({ fresh: req.nextUrl.searchParams.get("fresh") === "1" });
      return NextResponse.json({ ok: true, rules: CYCLE, ...data });
    }
    if (kind === "winds") {
      const data = await buildHeadwinds({ fresh: req.nextUrl.searchParams.get("fresh") === "1" });
      return NextResponse.json({ ok: true, rules: WIND, ...data });
    }
    return NextResponse.json({ ok: true, ...buildValueUniverse() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** POST {stop?}: fetch missing Sales growth / ROCE / P/B from Yahoo in the background. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { stop?: boolean };
  if (body.stop) {
    stopValueFill();
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  return NextResponse.json({ ok: true, job: startNanoFill("rotqy", (p) => fillValueQuality(p)) });
}
