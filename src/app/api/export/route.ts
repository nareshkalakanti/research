import { NextRequest, NextResponse } from "next/server";
import { loadAllCompanies } from "@/lib/db";

export const runtime = "nodejs";

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const market = sp.get("market") || "NSE";
  const missing = (sp.get("missing") || "metrics").trim().toLowerCase();

  let companies = loadAllCompanies();
  if (market && market !== "All") {
    companies = companies.filter((c) => c.market === market);
  }

  companies = companies.filter((c) => {
    const price = c.price == null;
    const mcap = c.mcap_cr == null;
    const sector = !c.sector?.trim();
    const about = !c.about?.trim();
    const web = !c.web;
    if (missing === "any") return price || mcap || sector || about || web;
    if (missing === "price") return price;
    if (missing === "mcap") return mcap;
    if (missing === "sector") return sector;
    if (missing === "about") return about;
    if (missing === "web") return web;
    if (missing === "metrics") return price || mcap;
    return price || mcap;
  });

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
        !c.about?.trim() ? "1" : "0",
        !c.web ? "1" : "0",
        c.sc,
        c.tv,
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `missing-${missing}-${market.replace(/\s+/g, "_")}-${stamp}.csv`;

  return new NextResponse(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
