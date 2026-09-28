import { NextRequest, NextResponse } from "next/server";
import {
  addManualDinSeats,
  listCompanyBoardSeats,
  removeBoardSeat,
} from "@/lib/governance-write";
import { invalidateGovernanceMapCache } from "@/lib/governance-map";
import { getMetrics } from "@/lib/metrics";
import { normDin } from "@/lib/nse-governance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseDins(raw: unknown): string[] {
  const text = raw == null ? "" : String(raw);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/\d{8}/g)) {
    const din = normDin(m[0]);
    if (din.length !== 8 || seen.has(din)) continue;
    seen.add(din);
    out.push(din);
  }
  return out;
}

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "")
    .trim()
    .toUpperCase();
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    ticker,
    seats: listCompanyBoardSeats(ticker),
  });
}

export async function POST(req: NextRequest) {
  let body: {
    ticker?: string;
    name?: string;
    market?: string | null;
    din?: string;
    dins?: string;
    directorName?: string;
    designation?: string;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const ticker = (body.ticker || "").trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }
  const dins = parseDins(body.dins ?? body.din);
  if (!dins.length) {
    return NextResponse.json({ ok: false, error: "DIN required (8 digits)" }, { status: 400 });
  }
  const metrics = getMetrics(ticker);
  const companyName =
    (body.name || "").trim() || metrics?.ticker || ticker;
  const directorName = (body.directorName || "").trim();
  try {
    const result = addManualDinSeats({
      ticker,
      companyName,
      market: body.market || metrics?.market || "NSE",
      seats: dins.map((din) => ({
        din,
        name: dins.length === 1 ? directorName : undefined,
        designation: body.designation,
      })),
    });
    invalidateGovernanceMapCache();
    return NextResponse.json({
      ok: true,
      ...result,
      seats: listCompanyBoardSeats(ticker),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not add DIN";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "")
    .trim()
    .toUpperCase();
  const personId = (req.nextUrl.searchParams.get("personId") || "").trim();
  try {
    const result = removeBoardSeat({ ticker, personId });
    invalidateGovernanceMapCache();
    return NextResponse.json({
      ok: true,
      ...result,
      seats: listCompanyBoardSeats(ticker),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not remove seat";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
