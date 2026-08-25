import { NextRequest, NextResponse } from "next/server";
import {
  csvEscape,
  loadMissingCompanies,
} from "@/lib/missing-data";
import {
  listScrapeOutcomeRows,
  loadScrapeStatusMap,
} from "@/lib/scraper-store";
import { websiteUrl } from "@/lib/links";

export const runtime = "nodejs";

const SCRAPE_OUTCOME_KEYS = new Set([
  "scrape_empty",
  "scrape_failed",
  "scrape_bad",
]);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const market = sp.get("market") || "All";
  const missing = sp.get("missing") || "metrics";
  const format = (sp.get("format") || "basic").trim().toLowerCase();

  const stamp = new Date().toISOString().slice(0, 10);
  const safeMarket = market.replace(/\s+/g, "_");
  const safeMissing = missing.replace(/\s+/g, "_");

  if (SCRAPE_OUTCOME_KEYS.has(missing.trim().toLowerCase())) {
    const key = missing.trim().toLowerCase();
    const outcomes =
      key === "scrape_empty"
        ? (["empty"] as const)
        : key === "scrape_failed"
          ? (["failed", "blocked"] as const)
          : (["empty", "failed", "blocked"] as const);
    const outcomeRows = listScrapeOutcomeRows([...outcomes], market);
    const companies = loadMissingCompanies(market, missing);
    const byTicker = new Map(
      companies.map((c) => [c.ticker.toUpperCase(), c]),
    );
    const header = [
      "company name",
      "symbol",
      "market",
      "website",
      "scrape_status",
      "error",
      "website_status",
    ];
    const lines = [header.join(",")];
    for (const o of outcomeRows) {
      const c = byTicker.get(o.ticker);
      lines.push(
        [
          c?.name ?? o.ticker,
          o.ticker,
          c?.market ?? "",
          websiteUrl(o.website) ?? o.website ?? "",
          o.status,
          o.error ?? "",
          o.website_status ?? "",
        ]
          .map(csvEscape)
          .join(","),
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

  const companies = loadMissingCompanies(market, missing);

  if (format === "full") {
    const statusMap = loadScrapeStatusMap();
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
      "scrape_status",
      "scrape_error",
      "screener",
      "tradingview",
    ];
    const lines = [header.join(",")];
    for (const c of companies) {
      const st = statusMap.get(c.ticker.toUpperCase());
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
          st?.status ?? "",
          st?.error ?? "",
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
