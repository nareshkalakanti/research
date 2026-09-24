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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payload(list: string) {
  const info = listNamedWatchlists().find((l) => l.key === list);
  const rows = loadNamedWatchlist(list);
  return {
    ok: true as const,
    list,
    label: info?.label || list,
    tickers: rows.map((r) => r.ticker.toUpperCase()),
    count: rows.length,
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
      lists: listNamedWatchlists(),
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
      lists: listNamedWatchlists(),
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
      lists: listNamedWatchlists(),
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
  const row = upsertNamedWatch(list, {
    ticker,
    name: body.name,
    market: body.market || metrics?.market || null,
    sector: body.sector || metrics?.sector || null,
    sub_sector: body.sub_sector || null,
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
