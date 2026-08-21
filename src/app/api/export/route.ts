import { NextRequest, NextResponse } from "next/server";
import {
  csvEscape,
  loadMissingCompanies,
} from "@/lib/missing-data";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const market = sp.get("market") || "All";
  const missing = sp.get("missing") || "metrics";
  const format = (sp.get("format") || "basic").trim().toLowerCase();

  const companies = loadMissingCompanies(market, missing);
  const stamp = new Date().toISOString().slice(0, 10);
  const safeMarket = market.replace(/\s+/g, "_");
  const safeMissing = missing.replace(/\s+/g, "_");

  if (format === "full") {
    const header = [
      "ticker",
      "name",
      "market",
      "sector",
      "sub_sector",
      "price",
      "mcap_cr",
      "website",
      "missing_price",
      "missing_mcap",
      "missing_sector",
      "missing_sub_sector",
      "missing_about",
      "missing_web",
      "screener",
      "tradingview",
    ];
    const lines = [header.join(",")];
    for (const c of companies) {
      lines.push(
        [
          c.ticker,
          c.name,
          c.market,
          c.sector,
          c.sub_sector,
          c.price,
          c.mcap_cr,
          c.web,
          c.price == null ? "1" : "0",
          c.mcap_cr == null ? "1" : "0",
          !c.sector?.trim() ? "1" : "0",
          !c.sub_sector?.trim() ? "1" : "0",
          !c.about?.trim() ? "1" : "0",
          !c.web ? "1" : "0",
          c.sc,
          c.tv,
        ]
          .map(csvEscape)
          .join(","),
      );
    }
    const filename = `missing-${safeMissing}-${safeMarket}-${stamp}-full.csv`;
    return new NextResponse(lines.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const header = ["company name", "symbol", "website"];
  const lines = [header.join(",")];
  for (const c of companies) {
    lines.push(
      [c.name, c.ticker, c.web ?? ""].map(csvEscape).join(","),
    );
  }

  const filename = `missing-${safeMissing}-${safeMarket}-${stamp}.csv`;
  return new NextResponse(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
