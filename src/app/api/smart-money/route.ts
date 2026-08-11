import { NextRequest, NextResponse } from "next/server";
import { buildSmartMoneyRadar } from "@/lib/smart-money/radar";
import { syncSmartMoneyData } from "@/lib/smart-money/sync";
import {
  listShareholdingHits,
  listNewsSignals,
  upsertShareholdingHits,
} from "@/lib/smart-money/signals-store";
import { loadShareholdingSeeds } from "@/lib/smart-money/seeds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET — smart money radar (deals + SME overlap + cached signals). */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const days = Math.min(180, Number(sp.get("days") || "90") || 90);
    const investor = sp.get("investor") || undefined;
    const smeOnly = sp.get("sme") === "1";
    const buysOnly = sp.get("buys") === "1";
    const primaryOnly = sp.get("primary") !== "0";
    const limit = Math.min(300, Number(sp.get("limit") || "100") || 100);

    const radar = buildSmartMoneyRadar({
      days,
      investorId: investor,
      smeOnly,
      buysOnly,
      primaryOnly: investor ? false : primaryOnly,
      limit,
    });

    let shareholding = listShareholdingHits({
      primaryOnly: true,
      smeOnly: smeOnly,
      limit: 50,
    });
    if (!shareholding.length) {
      upsertShareholdingHits(loadShareholdingSeeds());
      shareholding = listShareholdingHits({
        primaryOnly: true,
        smeOnly: smeOnly,
        limit: 50,
      });
    }
    const news = listNewsSignals({ primaryOnly: true, limit: 30 });

    return NextResponse.json(
      { ok: true, shareholding, news, ...radar },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** POST — full sync: NSE+BSE deals, shareholding scan, news RSS. */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      days?: number;
      skipNews?: boolean;
      skipShareholding?: boolean;
    };
    const days = Math.min(90, Math.max(7, body.days ?? 30));
    const sync = await syncSmartMoneyData({
      days,
      skipNews: body.skipNews,
      skipShareholding: body.skipShareholding ?? true,
      shareholdingMax: 8,
    });
    const radar = buildSmartMoneyRadar({
      days,
      primaryOnly: true,
      limit: 100,
    });
    const shareholding = listShareholdingHits({ primaryOnly: true, limit: 50 });
    const news = listNewsSignals({ primaryOnly: true, limit: 30 });

    return NextResponse.json({
      ok: true,
      sync,
      shareholding,
      news,
      ...radar,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
