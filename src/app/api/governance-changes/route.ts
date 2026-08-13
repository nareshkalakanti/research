import { NextRequest, NextResponse } from "next/server";
import {
  listRecentSeatEvents,
  seatEventSummary,
} from "@/lib/governance-changes";
import { loadGovWatch } from "@/lib/governance-watch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(100, Math.max(1, Number(sp.get("limit") || 30)));
  const watchOnly = sp.get("watchOnly") === "1";
  const personId = sp.get("personId") || null;
  const ticker = sp.get("ticker") || null;

  const events = listRecentSeatEvents({
    limit,
    watchOnly,
    personId,
    ticker,
  });

  return NextResponse.json({
    ok: true,
    watch: loadGovWatch(),
    summary: seatEventSummary(events),
    events,
  });
}
