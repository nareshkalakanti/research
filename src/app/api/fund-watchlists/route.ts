import { NextRequest, NextResponse } from "next/server";
import { invalidateCompanyCache } from "@/lib/db";
import { holdingsTickerSet } from "@/lib/holdings";
import {
  createFundList,
  deleteFundList,
  deleteFundWatchlistTicker,
  ensureFundWatchlistInCompanyAbout,
  fundLabelForKey,
  fundOverlapStats,
  invalidateFundWatchlistCache,
  listFundCatalog,
  loadFundHoldings,
  upsertFundWatchlistRows,
} from "@/lib/fund-watchlists";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const listKey = (req.nextUrl.searchParams.get("list") || "").trim();
  if (!listKey) {
    const stats = fundOverlapStats();
    return NextResponse.json({
      ok: true,
      lists: listFundCatalog(),
      all: stats.all,
      hold: holdingsTickerSet().size,
      unique: stats.unique,
      overlap: stats.overlap,
      sme: stats.sme,
    });
  }
  const holdings = loadFundHoldings(listKey);
  return NextResponse.json({
    ok: true,
    list: listKey,
    label: fundLabelForKey(listKey),
    holdings,
  });
}

export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    label?: string;
    list?: string;
    ticker?: string;
    name?: string;
    market?: string;
    tickers?: Array<{ ticker: string; name?: string; market?: string }>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const action = (body.action || "add").toLowerCase();

  if (action === "create") {
    try {
      const entry = createFundList(String(body.label || ""));
      return NextResponse.json({ ok: true, list: entry });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : "Create failed" },
        { status: 400 },
      );
    }
  }

  if (action === "delete-list" || action === "delete_fund") {
    const key = String(body.list || "").trim();
    if (!key) {
      return NextResponse.json({ ok: false, error: "list required" }, { status: 400 });
    }
    try {
      const deleted = deleteFundList(key);
      const stats = fundOverlapStats();
      invalidateCompanyCache();
      return NextResponse.json({
        ok: true,
        deleted,
        lists: listFundCatalog(),
        all: stats.all,
        unique: stats.unique,
        overlap: stats.overlap,
        sme: stats.sme,
        hold: holdingsTickerSet().size,
      });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : "Delete failed" },
        { status: 400 },
      );
    }
  }

  const listKey = String(body.list || "").trim();
  if (!listKey) {
    return NextResponse.json({ ok: false, error: "list required" }, { status: 400 });
  }

  if (action === "remove") {
    const ticker = String(body.ticker || "").trim().toUpperCase();
    if (!ticker) {
      return NextResponse.json(
        { ok: false, error: "ticker required" },
        { status: 400 },
      );
    }
    const removed = deleteFundWatchlistTicker(listKey, ticker);
    invalidateCompanyCache();
    return NextResponse.json({
      ok: true,
      removed,
      holdings: loadFundHoldings(listKey),
      lists: listFundCatalog(),
    });
  }

  const rows =
    Array.isArray(body.tickers) && body.tickers.length
      ? body.tickers
      : body.ticker
        ? [
            {
              ticker: body.ticker,
              name: body.name,
              market: body.market,
            },
          ]
        : [];

  if (!rows.length) {
    return NextResponse.json(
      { ok: false, error: "ticker(s) required" },
      { status: 400 },
    );
  }

  const normalized = rows.map((r) => ({
    ticker: String(r.ticker || "").trim().toUpperCase(),
    name: r.name?.trim() || null,
    market: r.market?.trim() || "NSE",
    change_type: "new" as const,
  }));

  const added = upsertFundWatchlistRows(listKey, normalized);
  const aboutAdded = ensureFundWatchlistInCompanyAbout(
    normalized.map((r) => ({
      ...r,
      name: r.name || r.ticker,
      list_key: listKey,
    })),
  );
  invalidateFundWatchlistCache();
  invalidateCompanyCache();

  return NextResponse.json({
    ok: true,
    added,
    aboutAdded,
    holdings: loadFundHoldings(listKey),
    lists: listFundCatalog(),
  });
}
