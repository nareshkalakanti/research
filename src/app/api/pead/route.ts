import { NextRequest, NextResponse } from "next/server";
import { loadAllCompanies } from "@/lib/db";
import {
  peadFillCoverage,
  pendingPeadFillTickers,
  runPeadFillBatch,
} from "@/lib/pead-fill";
import { loadPead2Rows, type Pead2Row } from "@/lib/pead2-table";
import { refreshPeadReturns } from "@/lib/pead2-returns";
import { refreshPagePrices } from "@/lib/metrics";
import { filterCompaniesByScanList } from "@/lib/scan-lists-server";
import {
  parsePeadSeasonParam,
  peadSeasonBounds,
  resultDateInPeadSeason,
} from "@/lib/pead-season";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type SortKey = keyof Pead2Row;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function filterByMarket(all: Pead2Row[], market: string): Pead2Row[] {
  if (!market || market === "All") return all;
  const companies = loadAllCompanies();
  const pool = filterCompaniesByScanList(companies, market, companies);
  const want = new Set(pool.map((c) => c.ticker.toUpperCase()));
  return all.filter((r) => want.has(r.ticker.toUpperCase()));
}

function filterRows(
  all: Pead2Row[],
  sp: URLSearchParams,
): {
  rows: Pead2Row[];
  stats: { scored: number };
  coverage: ReturnType<typeof peadFillCoverage>;
  season: ReturnType<typeof peadSeasonBounds>;
} {
  const market = (sp.get("market") || "All").trim() || "All";
  const q = (sp.get("q") || "").trim().toLowerCase();
  const mcapMin = num(sp.get("mcapMin"));
  const mcapMax = num(sp.get("mcapMax"));
  const signal = (sp.get("signal") || "all").trim().toLowerCase();
  const incompleteOnly = sp.get("incomplete") === "1";
  const season = peadSeasonBounds(parsePeadSeasonParam(sp.get("season")));
  // Optional explicit ISO bounds override the season chip.
  const fromOverride = (sp.get("resultFrom") || "").slice(0, 10);
  const toOverride = (sp.get("resultTo") || "").slice(0, 10);
  const bounds = {
    from: /^\d{4}-\d{2}-\d{2}$/.test(fromOverride) ? fromOverride : season.from,
    to: /^\d{4}-\d{2}-\d{2}$/.test(toOverride) ? toOverride : season.to,
  };
  let rows = filterByMarket(all, market);
  const stats = { scored: rows.filter((r) => r.pead_score != null).length };
  const coverage = peadFillCoverage({ market, season: season.id });
  if (bounds.from || bounds.to) {
    rows = rows.filter((r) => resultDateInPeadSeason(r.result_date, bounds));
  }
  if (q) {
    rows = rows.filter((r) => {
      const hay = `${r.ticker} ${r.name} ${r.sector || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }
  if (mcapMin != null && mcapMin > 0) {
    rows = rows.filter((r) => r.mcap_cr != null && r.mcap_cr >= mcapMin);
  }
  if (mcapMax != null) {
    rows = rows.filter((r) => r.mcap_cr != null && r.mcap_cr <= mcapMax);
  }
  if (signal === "tq") {
    rows = rows.filter((r) => r.has_tq);
  } else if (signal === "bb") {
    rows = rows.filter((r) => r.has_bb);
  } else if (signal === "both") {
    rows = rows.filter((r) => r.has_tq && r.has_bb);
  }
  if (incompleteOnly) {
    rows = rows.filter(
      (r) =>
        !r.result_date ||
        r.returns_pct == null ||
        r.forward_pe == null ||
        (r.sales_yoy == null && r.np_yoy == null && r.ebidt_yoy == null),
    );
  }
  return { rows, stats, coverage, season: { ...season, ...bounds, id: season.id } };
}

function sortRows(rows: Pead2Row[], sort: string, dir: 1 | -1): Pead2Row[] {
  const key = (sort || "pead_score") as SortKey;
  const copy = [...rows];
  copy.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const aMissing = av == null || av === "";
    const bMissing = bv == null || bv === "";
    if (aMissing && bMissing) return a.ticker.localeCompare(b.ticker);
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      if (av !== bv) return (av < bv ? -1 : 1) * dir;
    } else {
      const cmp = String(av).localeCompare(String(bv));
      if (cmp) return cmp * dir;
    }
    return a.ticker.localeCompare(b.ticker);
  });
  return copy;
}

function pageSlice(req: NextRequest, rows: Pead2Row[]) {
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get("page") || 1));
  const pageSize = Math.min(100, Math.max(10, Number(sp.get("pageSize") || 40)));
  const sort = sp.get("sort") || "result_date";
  const dir = sp.get("dir") === "asc" ? (1 as const) : (-1 as const);
  const sorted = sortRows(rows, sort, dir);
  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return { total, page, pages, rows: sorted.slice(start, start + pageSize) };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const market = (sp.get("market") || "All").trim() || "All";
  const season = parsePeadSeasonParam(sp.get("season"));
  if (sp.get("coverage") === "1") {
    return NextResponse.json({
      ok: true,
      coverage: peadFillCoverage({ market, season }),
      pending: pendingPeadFillTickers({ market, season }).slice(0, 20),
      season: peadSeasonBounds(season),
    });
  }
  // GET stays snappy: soft/force Yahoo quotes only. Returns/NSE = POST Refresh Returns.
  const forcePrices = sp.get("refresh") === "1";
  let all = loadPead2Rows();
  let filtered = filterRows(all, sp);
  let slice = pageSlice(req, filtered.rows);
  if (slice.rows.length) {
    try {
      const updated = await refreshPagePrices(
        slice.rows.map((r) => ({ ticker: r.ticker, market: r.market })),
        { force: forcePrices, concurrency: 8 },
      );
      if (updated > 0 || forcePrices) {
        all = loadPead2Rows();
        filtered = filterRows(all, sp);
        slice = pageSlice(req, filtered.rows);
      }
    } catch (err) {
      console.warn("[api/pead] price refresh skipped:", err);
    }
  }
  return NextResponse.json({
    stats: filtered.stats,
    coverage: filtered.coverage,
    season: filtered.season,
    ...slice,
  });
}

export async function POST(req: NextRequest) {
  let body: {
    tickers?: string[];
    action?: string;
    market?: string;
    limit?: number;
    concurrency?: number;
    season?: string;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const action = (body.action || "returns").trim().toLowerCase();
  const market =
    (body.market || req.nextUrl.searchParams.get("market") || "All").trim() ||
    "All";
  const season = parsePeadSeasonParam(
    body.season || req.nextUrl.searchParams.get("season"),
  );

  if (action === "scan" || action === "fill") {
    try {
      const result = await runPeadFillBatch({
        market,
        tickers: Array.isArray(body.tickers) ? body.tickers : undefined,
        limit: body.limit,
        concurrency: body.concurrency,
        season,
      });
      // Progress-only payload — avoid rebuilding the full PEAD table each round.
      return NextResponse.json({
        ...result,
        stats: { scored: result.coverage.scored },
        coverage: result.coverage,
        season: peadSeasonBounds(season),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "PEAD scan failed";
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  }

  const all = loadPead2Rows();
  const want = new Set(
    (body.tickers || []).map((t) => t.trim().toUpperCase()).filter(Boolean),
  );
  const filtered = filterRows(all, req.nextUrl.searchParams);
  const targets = want.size
    ? filtered.rows.filter((r) => want.has(r.ticker))
    : filtered.rows.slice(0, 40);
  const { updated } = await refreshPeadReturns(targets);
  const fresh = loadPead2Rows();
  const next = filterRows(fresh, req.nextUrl.searchParams);
  const slice = pageSlice(req, next.rows);
  return NextResponse.json({
    stats: next.stats,
    coverage: next.coverage,
    season: next.season,
    updated,
    ...slice,
  });
}
