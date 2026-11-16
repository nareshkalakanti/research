import { NextResponse } from "next/server";
import { lastBasketsRefresh, startBasketsRefresh } from "@/lib/baskets-refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Background refresh of the Nano-tab baskets — pinged by the app while open. */
export async function POST() {
  const last = lastBasketsRefresh();
  // At most every 30 minutes, whoever pings.
  if (last && Date.now() - Date.parse(last) < 30 * 60_000) {
    return NextResponse.json({ ok: true, started: false, reason: "recent", last });
  }
  return NextResponse.json({ ok: true, ...startBasketsRefresh(), last });
}
