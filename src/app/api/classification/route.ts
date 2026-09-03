import { NextRequest, NextResponse } from "next/server";
import { upsertClassification } from "@/lib/classifications-write";
import { ensureCompanyAboutRow } from "@/lib/company-about-write";
import { ensureFundWatchlistInCompanyAbout } from "@/lib/fund-watchlists";
import { loadSectorTaxonomy } from "@/lib/sector-classify";

export const runtime = "nodejs";

type Body = {
  ticker?: string;
  market?: string;
  name?: string;
  sector?: string;
  sub_sector?: string;
};

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("taxonomy") !== "1") {
    return NextResponse.json({ ok: false, error: "unknown request" }, { status: 400 });
  }
  const taxonomy = loadSectorTaxonomy();
  const sectors = [...new Set(taxonomy.map((p) => p.sector))].sort();
  return NextResponse.json({
    ok: true,
    pairs: taxonomy.slice(0, 500),
    sectors,
  });
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const ticker = (body.ticker || "").trim().toUpperCase();
  const market = (body.market || "").trim();
  const sector = (body.sector || "").trim();
  const sub_sector = (body.sub_sector || "").trim();

  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }
  if (!market) {
    return NextResponse.json({ ok: false, error: "market required" }, { status: 400 });
  }
  if (!sector || !sub_sector) {
    return NextResponse.json(
      { ok: false, error: "sector and sub_sector required" },
      { status: 400 },
    );
  }

  ensureFundWatchlistInCompanyAbout();
  ensureCompanyAboutRow(ticker, { name: body.name, market });

  upsertClassification(ticker, market, { sector, sub_sector });

  return NextResponse.json({
    ok: true,
    ticker,
    market,
    sector,
    sub_sector,
  });
}
