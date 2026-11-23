import { NextRequest, NextResponse } from "next/server";
import {
  ensureIndexConstituents,
  indexTickerSet,
  NIFTY_INDEX_IDS,
  NIFTY_INDEX_META,
  type NiftyIndexId,
} from "@/lib/nse-index-constituents";

export const runtime = "nodejs";

function parseIndex(raw: string | null): NiftyIndexId | null {
  const id = (raw || "").trim().toUpperCase();
  if ((NIFTY_INDEX_IDS as readonly string[]).includes(id)) {
    return id as NiftyIndexId;
  }
  return null;
}

/** NSE index membership (Nifty 200 / Nifty 500) for client universe filters. */
export async function GET(req: NextRequest) {
  const id = parseIndex(req.nextUrl.searchParams.get("index"));
  if (!id) {
    return NextResponse.json(
      {
        ok: false,
        error: `index must be one of ${NIFTY_INDEX_IDS.join(", ")}`,
      },
      { status: 400 },
    );
  }
  try {
    const ensured = await ensureIndexConstituents(id);
    const tickers = [...indexTickerSet(id)].sort();
    return NextResponse.json({
      ok: true,
      index: id,
      label: NIFTY_INDEX_META[id].label,
      count: tickers.length,
      refreshed: ensured.refreshed,
      tickers,
      error: ensured.error,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
