import { NextRequest, NextResponse } from "next/server";
import {
  deleteHolding,
  loadHoldings,
  upsertHolding,
} from "@/lib/holdings";
import { getMetrics } from "@/lib/metrics";
import { invalidateCompanyCache } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payload() {
  const rows = loadHoldings();
  // StockScans sector / industry — used by Value / Rotation / Scan pickers.
  const industries = [
    ...new Set(
      rows
        .map((r) => (r.sub_sector || "").trim())
        .filter((s): s is string => !!s),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const sectors = [
    ...new Set(
      rows
        .map((r) => (r.sector || "").trim())
        .filter((s): s is string => !!s),
    ),
  ].sort((a, b) => a.localeCompare(b));
  return {
    ok: true as const,
    tickers: rows.map((r) => r.ticker.toUpperCase()),
    count: rows.length,
    industries,
    sectors,
  };
}

/** Personal holdings tickers from data/holdings.db */
export async function GET() {
  return NextResponse.json(payload());
}

export async function POST(req: NextRequest) {
  let body: {
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
  const ticker = (body.ticker || "").trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }
  const metrics = getMetrics(ticker);
  // Sector / industry always resolved from StockScans inside upsertHolding.
  const row = upsertHolding({
    ticker,
    name: body.name,
    market: body.market || metrics?.market || null,
  });
  if (!row) {
    return NextResponse.json({ ok: false, error: "Could not save" }, { status: 400 });
  }
  invalidateCompanyCache();
  return NextResponse.json({ ...payload(), row });
}

export async function DELETE(req: NextRequest) {
  const ticker = (
    req.nextUrl.searchParams.get("ticker") ||
    ""
  )
    .trim()
    .toUpperCase();
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }
  deleteHolding(ticker);
  invalidateCompanyCache();
  return NextResponse.json(payload());
}
