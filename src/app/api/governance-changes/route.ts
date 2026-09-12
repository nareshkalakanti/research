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
  const limit = Math.min(200, Math.max(1, Number(sp.get("limit") || 30)));
  const watchOnly = sp.get("watchOnly") === "1";
  const personId = sp.get("personId") || null;
  const ticker = sp.get("ticker") || null;
  const source = sp.get("source") || null;
  const sourcesRaw = sp.get("sources") || "";
  const sources = sourcesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const eventTypeRaw = sp.get("eventType");
  const eventType =
    eventTypeRaw === "joined" ||
    eventTypeRaw === "resigned" ||
    eventTypeRaw === "role_changed"
      ? eventTypeRaw
      : null;

  const events = listRecentSeatEvents({
    limit,
    watchOnly,
    personId,
    ticker,
    source: sources.length ? null : source,
    sources: sources.length ? sources : null,
    eventType,
  });

  return NextResponse.json({
    ok: true,
    watch: loadGovWatch(),
    summary: seatEventSummary(events),
    events,
  });
}
