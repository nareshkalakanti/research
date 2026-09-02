import { NextRequest, NextResponse } from "next/server";
import { invalidateCompanyCache } from "@/lib/db";
import {
  concallDriftFilterMeta,
  concallDriftQuarterOptions,
  concallDriftScanProgress,
  concallDriftStats,
  loadConcallDriftRows,
  pendingConcallDriftTickers,
  pruneConcallDriftJunk,
} from "@/lib/strategy/concall-drift-store";
import { runConcallDriftScanBatch, repairConcallDriftPairing } from "@/lib/strategy/concall-drift-scan";
import { checkNseFeedStatus } from "@/lib/nse-feed-status";
import type { CapTier } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  kind?: string;
  market?: string;
  tickers?: string[];
  limit?: number;
  concurrency?: number;
  missingOnly?: boolean;
  repair?: boolean;
  refreshRecent?: boolean;
  announced?: boolean;
  announcedDays?: number;
};

export async function GET(req: NextRequest) {
  try {
    return await getStrategyConcallDrift(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Strategy load failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

async function getStrategyConcallDrift(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const market = sp.get("market") || "All";
  const refresh = sp.get("refresh") === "1";

  const cap = (sp.get("cap") || "All") as CapTier | "All";
  const quarter = sp.get("quarter");
  const window = sp.get("window") || "all";
  const from = sp.get("from");
  const to = sp.get("to");
  const sort = (sp.get("sort") || "all") as "all" | "gainers" | "losers";
  const q = sp.get("q");
  const sector = sp.get("sector");
  const mcapMinRaw = sp.get("mcapMin");
  const mcapMaxRaw = sp.get("mcapMax");
  const mcapMin = mcapMinRaw != null && mcapMinRaw !== "" ? Number(mcapMinRaw) : null;
  const mcapMax = mcapMaxRaw != null && mcapMaxRaw !== "" ? Number(mcapMaxRaw) : null;

  if (refresh) {
    invalidateCompanyCache();
    try {
      pruneConcallDriftJunk();
    } catch {
      /* best-effort */
    }
  }

  const baseOpts = {
    market,
    quarter,
    window,
    from,
    to,
    onePerTicker: true as const,
  };
  const rowOpts = {
    ...baseOpts,
    cap,
    limit: 500,
    sort,
    q,
    sector,
    mcapMin: Number.isFinite(mcapMin!) ? mcapMin : null,
    mcapMax: Number.isFinite(mcapMax!) ? mcapMax : null,
  };
  const filterMeta = concallDriftFilterMeta({
    market,
    quarter,
    window,
    from,
    to,
    onePerTicker: true,
  });

  if (refresh) {
    try {
      const preview = loadConcallDriftRows(rowOpts);
      const tickers = [...new Set(preview.map((r) => r.ticker.toUpperCase()))].slice(
        0,
        30,
      );
      if (tickers.length) {
        await repairConcallDriftPairing({ tickers, limit: 40 });
      }
      const { refreshPagePrices } = await import("@/lib/metrics");
      const seen = new Set<string>();
      const batch: Array<{ ticker: string; market: string }> = [];
      for (const row of preview) {
        const key = row.ticker.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        batch.push({ ticker: row.ticker, market: row.market });
        if (batch.length >= 80) break;
      }
      if (batch.length) {
        await refreshPagePrices(batch, { force: true, concurrency: 6 });
        invalidateCompanyCache();
      }
    } catch {
      /* best-effort — still return cached rows */
    }
  }

  const rows = loadConcallDriftRows(rowOpts);

  let nse_feed = {
    live: false,
    checked_at: new Date().toISOString(),
    detail: "Feed status unavailable",
    last_scan_at: null as string | null,
  };
  try {
    nse_feed = await checkNseFeedStatus({ force: refresh });
  } catch {
    /* best-effort — still return rows */
  }

  return NextResponse.json({
    ok: true,
    kind: "concall_drift",
    market,
    cap,
    quarter,
    window,
    sort,
    sector,
    quarters: concallDriftQuarterOptions(),
    sectors: filterMeta.sectors,
    mcap_bounds: filterMeta.mcap_bounds,
    total_events: filterMeta.total_events,
    with_baseline: filterMeta.with_baseline,
    stats: concallDriftStats(),
    scan_progress: concallDriftScanProgress({ market }),
    pending: pendingConcallDriftTickers({ market }).length,
    nse_feed,
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

  const market = body.market || "All";
  const limit = Math.min(32, Math.max(1, Number(body.limit) || 24));
  const missingOnly = body.missingOnly !== false;

  try {
    if (body.repair) {
      await repairConcallDriftPairing({ limit: 40 });
    }
    const result = await runConcallDriftScanBatch({
      market,
      tickers: body.tickers,
      limit,
      concurrency: Math.min(6, Math.max(1, Number(body.concurrency) || 4)),
      missingOnly,
      refreshRecent: body.refreshRecent === true,
      announced: body.announced === true,
      announcedDays: body.announcedDays,
    });
    return NextResponse.json({
      ok: true,
      kind: "concall_drift",
      ...result,
      message:
        result.tried === 0
          ? result.announced
            ? "No new announcements to fetch"
            : "Nothing left to scan"
          : `Scanned ${result.saved} · ${result.failed} failed · ${result.remaining.toLocaleString()} left`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Concall drift scan failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 503 });
  }
}
