import { NextRequest, NextResponse } from "next/server";
import { generateCompanyBrief, getLlmStatus } from "@/lib/company-brief";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  if (sp.get("status") === "1") {
    const llm = await getLlmStatus();
    return NextResponse.json({ ok: true, llm });
  }

  const ticker = (sp.get("ticker") || "").trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json(
      { ok: false, error: "ticker required" },
      { status: 400 },
    );
  }

  const market = (sp.get("market") || "").trim() || null;
  const priceOverride = Number(sp.get("price"));
  const price =
    Number.isFinite(priceOverride) && priceOverride > 0 ? priceOverride : null;
  const result = await generateCompanyBrief(ticker, market, price);

  if (result.error && !result.brief) {
    return NextResponse.json({
      ok: false,
      llm: result.llm,
      context: result.context,
      error: result.error,
      hint: result.llm.hint || undefined,
    });
  }

  return NextResponse.json({
    ok: true,
    llm: result.llm,
    context: result.context,
    brief: result.brief,
    cached: result.cached,
  });
}

export async function POST(req: NextRequest) {
  let body: {
    ticker?: string;
    market?: string | null;
    price?: number | null;
    quarterBlock?: string | null;
    quarterPanel?: import("@/lib/quarter-panel").QuarterPanel | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }

  const ticker = (body.ticker || "").trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json(
      { ok: false, error: "ticker required" },
      { status: 400 },
    );
  }

  const market = (body.market || "").trim() || null;
  const price =
    body.price != null && Number.isFinite(body.price) && body.price > 0
      ? body.price
      : null;
  const quarterBlock =
    body.quarterBlock !== undefined ? body.quarterBlock : undefined;

  const result = await generateCompanyBrief(
    ticker,
    market,
    price,
    quarterBlock,
    body.quarterPanel ?? null,
  );

  if (result.error && !result.brief) {
    return NextResponse.json({
      ok: false,
      llm: result.llm,
      context: result.context,
      error: result.error,
      hint: result.llm.hint || undefined,
    });
  }

  return NextResponse.json({
    ok: true,
    llm: result.llm,
    context: result.context,
    brief: result.brief,
    cached: result.cached,
  });
}
