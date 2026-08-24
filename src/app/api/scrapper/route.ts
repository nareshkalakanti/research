import { NextRequest, NextResponse } from "next/server";
import {
  ensureCompanyAboutRow,
  saveManualAboutToCompanyAbout,
  saveManualScrapedAbout,
  updateCompanyWebsite,
} from "@/lib/company-about-write";
import { ensureFundWatchlistInCompanyAbout } from "@/lib/fund-watchlists";
import {
  listScrapeRows,
  getScrapeByTicker,
  resetScrapeForTicker,
  type ScrapeFilter,
} from "@/lib/scraper-store";

export const runtime = "nodejs";

type ScrapperBody = {
  ticker?: string;
  name?: string;
  market?: string;
  website?: string;
  about?: string;
  scraped_about?: string;
  action?: "website" | "about" | "scraped_about";
};

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ticker = (sp.get("ticker") || "").trim().toUpperCase();
  if (ticker) {
    const row = getScrapeByTicker(ticker);
    if (!row) {
      return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, row });
  }

  const market = sp.get("market") || "All";
  const filter = (sp.get("filter") || "todo") as ScrapeFilter;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(sp.get("pageSize")) || 50));
  const sort = (sp.get("sort") || "name") as "name" | "ticker" | "status";
  const dir = sp.get("dir") === "desc" ? "desc" : "asc";

  const data = listScrapeRows({
    market,
    filter: filter === "failed" ? "failed" : "todo",
    page,
    pageSize,
    sort,
    dir,
  });

  return NextResponse.json({ ok: true, ...data });
}

export async function POST(req: NextRequest) {
  let body: ScrapperBody;
  try {
    body = (await req.json()) as ScrapperBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const ticker = (body.ticker || "").trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }

  const website = (body.website || "").trim();
  const about = (body.about || "").trim();
  const scrapedAbout = (body.scraped_about || "").trim();
  const action = body.action;

  ensureFundWatchlistInCompanyAbout();
  if (
    !ensureCompanyAboutRow(ticker, {
      name: body.name,
      market: body.market,
    })
  ) {
    return NextResponse.json(
      { ok: false, error: "company_about.db unavailable" },
      { status: 500 },
    );
  }

  if (action === "scraped_about" || (!action && scrapedAbout && !website && !about)) {
    if (!scrapedAbout) {
      return NextResponse.json(
        { ok: false, error: "scraped text required" },
        { status: 400 },
      );
    }
    const saved = saveManualScrapedAbout(ticker, scrapedAbout);
    if (!saved) {
      return NextResponse.json(
        {
          ok: false,
          error: "scrape text too short (min 40 chars) or ticker not found",
        },
        { status: 400 },
      );
    }
  } else if (action === "about" || (!action && about && !website)) {
    if (!about) {
      return NextResponse.json({ ok: false, error: "about required" }, { status: 400 });
    }
    const saved = saveManualAboutToCompanyAbout(ticker, about);
    if (!saved) {
      return NextResponse.json(
        { ok: false, error: "about too short (min 40 chars) or ticker not found" },
        { status: 400 },
      );
    }
  } else if (action === "website" || website) {
    if (!website) {
      return NextResponse.json({ ok: false, error: "website required" }, { status: 400 });
    }
    const saved = updateCompanyWebsite(ticker, website, { resetScrape: true });
    if (!saved) {
      return NextResponse.json(
        { ok: false, error: "invalid url or ticker not found" },
        { status: 400 },
      );
    }
    resetScrapeForTicker(ticker);
  } else {
    return NextResponse.json(
      { ok: false, error: "website or about required" },
      { status: 400 },
    );
  }

  const row = getScrapeByTicker(ticker);
  return NextResponse.json({ ok: true, row });
}
