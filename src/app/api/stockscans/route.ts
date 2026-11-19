import { NextRequest, NextResponse } from "next/server";
import { nanoFillJob, startNanoFill } from "@/lib/nanocap-champs";
import { stockMasterStatus, syncStockMaster } from "@/lib/stock-master";
import { crawlStockscans, stockscansStatus, stopStockscansCrawl } from "@/lib/stockscans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: how much StockScans industry data is saved, plus crawl progress. */
export async function GET() {
  return NextResponse.json({ ok: true, status: stockscansStatus(), master: stockMasterStatus(), job: nanoFillJob() });
}

/** POST {stop?}: start (or stop) the slow crawl of StockScans company pages. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { stop?: boolean };
  if (body.stop) {
    stopStockscansCrawl();
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  return NextResponse.json({ ok: true, job: startNanoFill("stockscans", async (p) => {
        try {
          return await crawlStockscans(p);
        } finally {
          // New industries go straight into the stock master.
          syncStockMaster({ force: true });
        }
      }) });
}
