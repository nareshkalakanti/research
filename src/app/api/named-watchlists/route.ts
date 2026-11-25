import { NextRequest, NextResponse } from "next/server";
import {
  createNamedList,
  deleteNamedWatch,
  listNamedWatchlists,
  loadNamedWatchlist,
  renameNamedList,
  upsertNamedWatch,
} from "@/lib/named-watchlists";
import { getMetrics } from "@/lib/metrics";
import { fundWatchlistSets, listFundCatalog } from "@/lib/fund-watchlists";

/**
 * A named list and a Screener investor fund list with the same name (Niveshaay,
 * Lucky, Negen…) show as one Watchlist chip: the named list plus the fund's
 * disclosed holdings. Nothing is deleted from either list.
 */
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function withFundList<T extends { key: string; label: string; tickers: string[]; count: number }>(
  lists: T[],
): Array<T & { fund_tickers: string[] }> {
  let byName = new Map<string, Set<string>>();
  try {
    const sets = fundWatchlistSets() as unknown as Record<string, Set<string>>;
    byName = new Map(
      listFundCatalog()
        .map((f) => [normName(f.label), sets[f.key]] as const)
        .filter((x): x is readonly [string, Set<string>] => !!x[1] && x[1].size > 0),
    );
  } catch {
    /* fund lists optional */
  }
  return lists.map((l) => {
    const fund = byName.get(normName(l.label)) ?? byName.get(normName(l.key));
    if (!fund) return { ...l, fund_tickers: [] };
    const own = new Set(l.tickers.map((t) => t.toUpperCase()));
    const extra = [...fund].map((t) => t.toUpperCase()).filter((t) => !own.has(t));
    const tickers = [...l.tickers, ...extra];
    return { ...l, tickers, count: tickers.length, fund_tickers: extra };
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payload(list: string) {
  const info = listNamedWatchlists().find((l) => l.key === list);
  const rows = loadNamedWatchlist(list);
  const [merged] = withFundList([
    { key: list, label: info?.label || list, tickers: rows.map((r) => r.ticker.toUpperCase()), count: rows.length },
  ]);
  return {
    ok: true as const,
    list,
    label: merged!.label,
    tickers: merged!.tickers,
    count: merged!.count,
    fund_tickers: merged!.fund_tickers,
  };
}

function listParam(req: NextRequest): string {
  return (req.nextUrl.searchParams.get("list") || "").trim().toLowerCase();
}

export async function GET(req: NextRequest) {
  const list = listParam(req);
  if (!list) {
    return NextResponse.json({
      ok: true as const,
      lists: withFundList(listNamedWatchlists()),
    });
  }
  return NextResponse.json(payload(list));
}

export async function POST(req: NextRequest) {
  let body: {
    list?: string;
    label?: string;
    ticker?: string;
    name?: string | null;
    market?: string | null;
    sector?: string | null;
    sub_sector?: string | null;
    create?: boolean;
    rename?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  if (body.rename) {
    const renamed = renameNamedList(body.list || "", body.label || "");
    if (!renamed) {
      return NextResponse.json(
        { ok: false, error: "Could not rename that list" },
        { status: 400 },
      );
    }
    return NextResponse.json({
      ok: true as const,
      list: renamed,
      lists: withFundList(listNamedWatchlists()),
    });
  }

  if (body.create || (!body.ticker && (body.label || body.list))) {
    const created = createNamedList(body.label || body.list || "");
    if (!created) {
      return NextResponse.json(
        { ok: false, error: "Need a list name (not Watchlist, Holdings, or Common)" },
        { status: 400 },
      );
    }
    return NextResponse.json({
      ok: true as const,
      list: created,
      lists: withFundList(listNamedWatchlists()),
    });
  }

  const list = (body.list || "").trim().toLowerCase();
  const ticker = (body.ticker || "").trim().toUpperCase();
  if (!list || !ticker) {
    return NextResponse.json(
      { ok: false, error: "list and ticker required" },
      { status: 400 },
    );
  }
  const metrics = getMetrics(ticker);
  // Sector / industry always resolved from StockScans inside upsertNamedWatch.
  const row = upsertNamedWatch(list, {
    ticker,
    name: body.name,
    market: body.market || metrics?.market || null,
  });
  if (!row) {
    return NextResponse.json({ ok: false, error: "Could not save" }, { status: 400 });
  }
  return NextResponse.json({ ...payload(list), row, lists: listNamedWatchlists() });
}

export async function DELETE(req: NextRequest) {
  const list = listParam(req);
  const ticker = (req.nextUrl.searchParams.get("ticker") || "").trim().toUpperCase();
  if (!list || !ticker) {
    return NextResponse.json(
      { ok: false, error: "list and ticker required" },
      { status: 400 },
    );
  }
  deleteNamedWatch(list, ticker);
  return NextResponse.json({ ...payload(list), lists: listNamedWatchlists() });
}
