import { NextRequest, NextResponse } from "next/server";
import { nanoFillJob, startNanoFill } from "@/lib/nanocap-champs";
import { runSmartRefresh, stopSmartRefresh } from "@/lib/smart-money";
import { buildSmartPage } from "@/lib/smart-money-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: Smart money page. GET ?job=1: refresh progress. */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("job") === "1") {
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  try {
    return NextResponse.json({ ok: true, ...buildSmartPage(), job: nanoFillJob() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** POST {stop?}: start (or stop) the refresh — Trendlyne pages + NSE filings. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { stop?: boolean };
  if (body.stop) {
    stopSmartRefresh();
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  return NextResponse.json({ ok: true, job: startNanoFill("smartmoney", (p) => runSmartRefresh(p)) });
}
