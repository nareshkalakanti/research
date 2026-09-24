import { NextRequest, NextResponse } from "next/server";
import {
  deleteNamedWatch,
  loadNamedWatchlist,
  upsertNamedWatch,
} from "@/lib/named-watchlists";
import { getMetrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payload(list: string) {
  const rows = loadNamedWatchlist(list);
  return {
    ok: true as const,
    list,
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
    return NextResponse.json({ ok: false, error: "list required" }, { status: 400 });
  }
  return NextResponse.json(payload(list));
}

export async function POST(req: NextRequest) {
  let body: {
    list?: string;
    ticker?: string;
    name?: string | null;
    market?: string | null;
    sector?: string | null;
    sub_sector?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
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
  return NextResponse.json({ ...payload(list), row });
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
  return NextResponse.json(payload(list));
}
