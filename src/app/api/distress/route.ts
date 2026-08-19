import { NextRequest, NextResponse } from "next/server";
import { loadAllCompanies } from "@/lib/db";
import {
  DISTRESS_DISCOVERY_GATES,
  DISTRESS_FLAG_LABELS,
  fetchDistressMetricsBatch,
  scoreDistressTurnaround,
} from "@/lib/distress";
import {
  DISTRESS_LISTS,
  distressSeedSet,
  isDistressScanList,
  tickersForDistressList,
  type DistressListId,
} from "@/lib/distress/tickers";
import { loadTurnaroundHoldings } from "@/lib/turnaround-holdings";
import { isNegen, isNiveshaay } from "@/lib/fund-watchlists";
import {
  countFreshDistressCache,
  listCachedDistress,
  tickersNeedingDistressScan,
  upsertDistressScores,
} from "@/lib/distress/cache";
import { researchLinks } from "@/lib/links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function buildRow(
  s: ReturnType<typeof scoreDistressTurnaround>,
  ctx: {
    holdMap: Map<string, { name?: string | null; market?: string; sector?: string | null }>;
    companyMap: Map<
      string,
      {
        name: string;
        market: string;
        sector: string | null;
        website: string | null;
        mcap_cr: number | null;
        price: number | null;
      }
    >;
    seeds: Set<string>;
  },
) {
  const t = s.metrics.ticker;
  const h = ctx.holdMap.get(t);
  const c = ctx.companyMap.get(t);
  const market = c?.market ?? h?.market ?? "NSE";
  const links = researchLinks(t, market, c?.website ?? null);
  return {
    ticker: t,
    name: h?.name ?? c?.name ?? null,
    market,
    sector: h?.sector ?? c?.sector ?? null,
    web: links.web,
    sc: links.sc,
    tv: links.tv,
    has_hold: !!h,
    has_niveshaay: isNiveshaay(t),
    has_negen: isNegen(t),
    has_distress: ctx.seeds.has(t),
    distress_score: s.distress_score,
    distress_flags: s.distress_flags,
    flag_labels: s.distress_flags.map((f) => DISTRESS_FLAG_LABELS[f] ?? f),
    distress_reason: s.distress_reason,
    drawdown_pct: s.metrics.drawdown_pct,
    bounce_pct: s.metrics.bounce_pct,
    eps_yoy: s.metrics.eps_yoy,
    sales_yoy: s.metrics.sales_yoy,
    pe: s.metrics.pe,
    mcap_cr: s.metrics.mcap_cr ?? c?.mcap_cr ?? null,
    price: s.metrics.price ?? c?.price ?? null,
    returns_pct: s.metrics.returns_pct,
  };
}

function buildRowFromCache(
  cached: Awaited<ReturnType<typeof listCachedDistress>>[number],
  ctx: Parameters<typeof buildRow>[1],
) {
  return buildRow(
    {
      distress_score: cached.distress_score,
      distress_flags: cached.distress_flags,
      distress_reason: cached.distress_reason ?? "",
      is_seed: ctx.seeds.has(cached.ticker),
      metrics: {
        ticker: cached.ticker,
        yf_symbol: "",
        price: cached.price,
        mcap_cr: cached.mcap_cr,
        pe: cached.pe,
        pb: null,
        eps_yoy: cached.eps_yoy,
        sales_yoy: cached.sales_yoy,
        returns_pct: cached.returns_pct,
        w52_high: null,
        w52_low: null,
        drawdown_pct: cached.drawdown_pct,
        bounce_pct: cached.bounce_pct,
        surv_type: ctx.seeds.has(cached.ticker) ? "SEED" : "—",
        surv_stage: null,
      },
    },
    ctx,
  );
}

/** GET — distress screen: pick a list, return scored stocks. */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const list = (sp.get("list") || "seeds") as DistressListId;
    const scan = sp.get("scan") === "1";
    const limit = Math.min(50, Math.max(1, Number(sp.get("limit") || 25)));
    const minScore = Math.max(0, Number(sp.get("minScore") || 40));

    if (!DISTRESS_LISTS.some((l) => l.id === list)) {
      return NextResponse.json(
        { ok: false, error: `Unknown list: ${list}` },
        { status: 400 },
      );
    }

    const holdings = loadTurnaroundHoldings();
    const holdMap = new Map(
      holdings.map((h) => [h.ticker.toUpperCase(), h]),
    );
    const companies = loadAllCompanies();
    const companyMap = new Map(
      companies.map((c) => [c.ticker.toUpperCase(), c]),
    );
    const seeds = distressSeedSet();
    const ctx = { holdMap, companyMap, seeds };

    const universeTickers = tickersForDistressList(list);
    let scanned = 0;

    if (isDistressScanList(list)) {
      if (scan) {
        const batch = tickersNeedingDistressScan(universeTickers, limit);
        if (batch.length) {
          const metrics = await fetchDistressMetricsBatch(
            batch.map((t) => {
              const c = companyMap.get(t);
              return {
                ticker: t,
                market: c?.market ?? "NSE",
                isSeed: seeds.has(t),
              };
            }),
          );
          const scored = metrics.map((m) => scoreDistressTurnaround(m));
          upsertDistressScores(scored);
          scanned = batch.length;
        }
      }

      const cached = listCachedDistress(universeTickers, { minScore });
      const rows = cached.map((c) => buildRowFromCache(c, ctx));
      const fresh = countFreshDistressCache(universeTickers);

      return NextResponse.json({
        ok: true,
        list,
        lists: DISTRESS_LISTS,
        scan,
        minScore,
        universe_total: universeTickers.length,
        scanned,
        cache_fresh: fresh,
        remaining: Math.max(0, universeTickers.length - fresh),
        hits: rows.length,
        count: rows.length,
        discovery_gates: DISTRESS_DISCOVERY_GATES,
        flag_labels: DISTRESS_FLAG_LABELS,
        rows,
      });
    }

    const tickers = universeTickers;
    const metrics = await fetchDistressMetricsBatch(
      tickers.map((t) => {
        const h = holdMap.get(t);
        const c = companyMap.get(t);
        return {
          ticker: t,
          market: c?.market ?? h?.market ?? "NSE",
          isSeed: true,
        };
      }),
    );

    const scored = metrics.map((m) => scoreDistressTurnaround(m));
    upsertDistressScores(scored);

    const rows = scored
      .map((s) => buildRow(s, ctx))
      .sort((a, b) => b.distress_score - a.distress_score);

    return NextResponse.json({
      ok: true,
      list,
      lists: DISTRESS_LISTS,
      universe_total: tickers.length,
      scanned: tickers.length,
      remaining: 0,
      hits: rows.length,
      count: rows.length,
      discovery_gates: DISTRESS_DISCOVERY_GATES,
      flag_labels: DISTRESS_FLAG_LABELS,
      rows,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
