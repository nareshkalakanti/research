import { NextRequest, NextResponse } from "next/server";
import { nanoFillJob, startNanoFill } from "@/lib/nanocap-champs";
import {
  crawlScreenerIndustries,
  listScreenerIndustryTickers,
  listScreenerLeaves,
  refreshScreenerLeafResultCounts,
  refreshScreenerMarketOverview,
  screenerIndustryCrawlPending,
  screenerIndustryStatus,
  screenerMarketOverviewStale,
  stopScreenerIndustryCrawl,
} from "@/lib/screener-industries";
import { ScreenerPausedError } from "@/lib/screener-fetch";
import { hasScreenerLogin } from "@/lib/screener-people";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET: status, or view=leaves / view=tickers to browse the DB. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const view = (sp.get("view") || "").trim();
  if (view === "leaves") {
    const forceOverview = sp.get("refresh") === "1" || sp.get("overview") === "1";
    let overviewError: string | null = null;
    if (forceOverview || screenerMarketOverviewStale()) {
      try {
        await refreshScreenerMarketOverview();
      } catch (e) {
        if (e instanceof ScreenerPausedError) {
          overviewError = e.message;
        } else {
          overviewError = e instanceof Error ? e.message : String(e);
        }
      }
    }
    return NextResponse.json({
      ok: true,
      leaves: listScreenerLeaves(sp.get("q") || ""),
      overview_error: overviewError,
    });
  }
  if (view === "tickers") {
    const { rows, total } = listScreenerIndustryTickers({
      q: sp.get("q") || "",
      sector: sp.get("sector") || "",
      industry: sp.get("industry") || "",
      sub_sector: sp.get("sub") || "",
      market_path: sp.get("path") || "",
      limit: Number(sp.get("limit") || 500) || 500,
    });
    return NextResponse.json({ ok: true, rows, total });
  }
  return NextResponse.json({
    ok: true,
    login: hasScreenerLogin(),
    status: screenerIndustryStatus(),
    pending: screenerIndustryCrawlPending(),
    job: nanoFillJob(),
  });
}

/**
 * POST {stop?} | {continue?} | {force?}
 * - start / force: crawl (force redoes every leaf)
 * - continue: resume only if a crawl was left incomplete (for background pings)
 * - stop: halt and clear the active flag
 *
 * Job runs in the Node process — leaving the Screener.in tab is fine; keep the
 * app server running. Background pings resume if you walked away mid-crawl.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    stop?: boolean;
    continue?: boolean;
    force?: boolean;
    overview?: boolean;
    /** Refresh leaf "results found" counts only (incl. SME). */
    counts?: boolean;
  };
  if (body.stop) {
    stopScreenerIndustryCrawl();
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  if (body.overview) {
    try {
      const n = await refreshScreenerMarketOverview();
      return NextResponse.json({ ok: true, overview: n, job: nanoFillJob() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ ok: false, error: msg, job: nanoFillJob() }, { status: 502 });
    }
  }
  if (body.counts) {
    const cur = nanoFillJob();
    if (cur?.running) {
      return NextResponse.json({ ok: true, started: false, reason: "busy", job: cur });
    }
    return NextResponse.json({
      ok: true,
      started: true,
      job: startNanoFill("screener-ind", async (p) => {
        const r = await refreshScreenerLeafResultCounts(p);
        return { tried: r.total, filled: r.updated, left: 0, not_found: 0 };
      }),
    });
  }
  if (body.continue) {
    if (!screenerIndustryCrawlPending()) {
      return NextResponse.json({ ok: true, started: false, reason: "idle", job: nanoFillJob() });
    }
    const cur = nanoFillJob();
    if (cur?.running) {
      return NextResponse.json({ ok: true, started: false, reason: "busy", job: cur });
    }
    return NextResponse.json({
      ok: true,
      started: true,
      job: startNanoFill("screener-ind", (p) => crawlScreenerIndustries(p)),
    });
  }
  return NextResponse.json({
    ok: true,
    started: true,
    job: startNanoFill("screener-ind", (p) =>
      crawlScreenerIndustries(p, { force: body.force === true }),
    ),
  });
}
