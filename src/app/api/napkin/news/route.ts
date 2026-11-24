import { NextRequest, NextResponse } from "next/server";
import { napkinNews } from "@/lib/napkin/news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?ticker=&name= — recent news for one stock (IndianAPI, cached 12 h). */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ticker = (sp.get("ticker") || "").trim();
  if (!ticker) return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  const res = await napkinNews(ticker, sp.get("name") || "");
  return NextResponse.json({ ok: true, ...res });
}
