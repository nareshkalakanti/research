/**
 * Napkin About panel — company_about rich fields, Yahoo fill when empty.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  invalidateCompanyCache,
  loadAllCompanies,
  pickAboutText,
} from "@/lib/db";
import { saveYfAboutProfile } from "@/lib/company-about-write";
import { resolveListingMarket } from "@/lib/listing-market";
import { isSqliteCorrupt, openSqliteNamed } from "@/lib/sqlite-utils";
import { fetchYfAboutProfile } from "@/lib/yfinance";

export const runtime = "nodejs";
export const maxDuration = 45;

export type NapkinAboutPayload = {
  ok: boolean;
  ticker: string;
  name: string | null;
  headline: string | null;
  sector: string | null;
  sub_sector: string | null;
  about: string | null;
  products: string[];
  headquarters: string | null;
  market: string | null;
  source: "company_about" | "yahoo" | "none";
  error?: string;
};

function splitProducts(raw: string | null | undefined): string[] {
  const t = (raw || "").trim();
  if (!t) return [];
  return t
    .split(/\s*[;|·]\s*|\s*,\s*|\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2 && !/^n\/?a$/i.test(p));
}

/** Pull "products include A, B and C" style lists from about text. */
function productsFromAbout(about: string | null | undefined): string[] {
  const t = (about || "").trim();
  if (!t) return [];
  const m = t.match(
    /products?\s+include\s+(.+?)(?:\.|$)/i,
  );
  if (!m?.[1]) return [];
  return m[1]
    .split(/\s*,\s*|\s+and\s+/i)
    .map((p) => p.trim().replace(/\.+$/, ""))
    .filter((p) => p.length >= 3);
}

const BRAND_STOP = new Set([
  "the",
  "its",
  "their",
  "our",
  "a",
  "an",
  "and",
  "or",
  "brand",
  "brands",
  "name",
  "names",
  "product",
  "products",
]);

/** Pull brand lists from Yahoo/about prose ("under the X, Y, and Z brand names"). */
function brandsFromAbout(text: string | null | undefined): string[] {
  const t = (text || "").trim();
  if (!t) return [];
  const patterns = [
    /under\s+the\s+(.+?)\s+brand\s+names?\b/gi,
    /under\s+(?:its|their|our)\s+(?:brand\s+names?|brands)\s+(.+?)(?:\.|;|$)/gi,
    /(?:each\s+of\s+)?(?:our|its|their)\s+brands?\s+(.+?)(?:,\s+play|\.|$)/gi,
    /products?\s+(?:are\s+)?(?:sold|marketed|offered)\s+under\s+(?:the\s+)?(.+?)(?:\s+brand\s+names?)?(?:\.|;|$)/gi,
    // Singular: "under Pigeon brand" / "under Gilma brand" / "under Black+Decker brand"
    /under\s+([A-Z][\w+&.]*(?:\s+[A-Z][\w+&.,]*){0,3})\s+brands?\b/g,
    // Dual: "under Pigeon and Gilma brands"
    /under\s+([A-Z][\w+&.]*\s+and\s+[A-Z][\w+&.,]*)\s+brands?\b/g,
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) != null) {
      const chunk = (m[1] || "").trim();
      if (!chunk) continue;
      for (const raw of chunk.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)) {
        const p = raw
          .trim()
          .replace(/^[\s"'“”]+|[\s"'“”.]+$/g, "")
          .replace(/^and\s+/i, "")
          .trim();
        if (p.length < 2 || p.length > 48) continue;
        if (BRAND_STOP.has(p.toLowerCase())) continue;
        if (/^(including|such as|like)\b/i.test(p)) continue;
        const key = p.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
      }
    }
  }
  return out;
}

function mergeProductLists(...lists: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const p of list) {
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

function payloadFromRow(
  key: string,
  row: {
    name?: string | null;
    products?: string | null;
    business_model?: string | null;
    sector?: string | null;
    sub_sector?: string | null;
    headquarters?: string | null;
    market?: string | null;
    about?: string | null;
    yf_about?: string | null;
    scraped_about?: string | null;
    scraped_about_clean?: string | null;
    llm_about?: string | null;
  },
): NapkinAboutPayload | null {
  const about = pickAboutText({
    about: row.about ?? null,
    yf_about: row.yf_about,
    llm_about: row.llm_about,
    scraped_about: row.scraped_about,
  });
  // Brands often live in Yahoo/scrape even when displayed about is a short LLM blurb.
  const brandCorpus = [
    row.yf_about,
    row.scraped_about,
    row.scraped_about_clean,
    about,
  ]
    .filter(Boolean)
    .join("\n");
  const brands = brandsFromAbout(brandCorpus);
  const products = splitProducts(row.products);
  const fromAbout =
    products.length < 2 ? productsFromAbout(about || brandCorpus) : [];
  // Brands first so About shows Gowardhan/Go-style names ahead of category nouns.
  const merged = mergeProductLists(brands, products, fromAbout);
  const headline = row.business_model?.trim() || null;
  const hasBody = !!(about && about.replace(/\s/g, "").length >= 40);
  if (!headline && !hasBody && !merged.length) return null;
  return {
    ok: true,
    ticker: key,
    name: row.name ?? null,
    headline,
    sector: row.sector ?? null,
    sub_sector: row.sub_sector ?? null,
    about: hasBody ? about : null,
    products: merged.slice(0, 8),
    headquarters: row.headquarters ?? null,
    market: row.market ?? null,
    source: "company_about",
  };
}

/** Direct ticker read — avoids full-universe load when About cache hits disk I/O. */
function payloadFromDirectSql(ticker: string): NapkinAboutPayload | null {
  const key = ticker.toUpperCase();
  try {
    const db = openSqliteNamed("company_about.db", {
      readonly: true,
      wal: true,
      quickCheck: false,
    });
    try {
      const row = db
        .prepare(
          `SELECT ticker, name, market, about, yf_about, scraped_about,
                  scraped_about_clean, llm_about,
                  company_sector AS sector, company_industry AS sub_sector,
                  headquarters, products, business_model
           FROM company_about WHERE UPPER(ticker) = ? LIMIT 1`,
        )
        .get(key) as
        | {
            name: string | null;
            market: string | null;
            about: string | null;
            yf_about: string | null;
            scraped_about: string | null;
            scraped_about_clean: string | null;
            llm_about: string | null;
            sector: string | null;
            sub_sector: string | null;
            headquarters: string | null;
            products: string | null;
            business_model: string | null;
          }
        | undefined;
      if (!row) return null;
      return payloadFromRow(key, row);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function payloadFromCompany(ticker: string): NapkinAboutPayload | null {
  const key = ticker.toUpperCase();
  try {
    const row = loadAllCompanies().find((c) => c.ticker.toUpperCase() === key);
    if (row) return payloadFromRow(key, row);
  } catch (err) {
    if (isSqliteCorrupt(err)) {
      invalidateCompanyCache();
    }
  }
  return payloadFromDirectSql(key);
}

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "")
    .trim()
    .toUpperCase();
  const market = (req.nextUrl.searchParams.get("market") || "").trim() || null;
  const nameHint = (req.nextUrl.searchParams.get("name") || "").trim() || null;
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";

  if (!ticker) {
    return NextResponse.json(
      { ok: false, error: "ticker required", source: "none" },
      { status: 400 },
    );
  }

  try {
    if (!refresh) {
      const existing = payloadFromCompany(ticker);
      if (existing) return NextResponse.json(existing);
    }

    const listing = market || resolveListingMarket(ticker);
    const yf = await fetchYfAboutProfile(ticker, listing);
    if (yf?.about || yf?.website || yf?.headquarters) {
      try {
        saveYfAboutProfile(ticker, {
          about: yf.about,
          website: yf.website,
          headquarters: yf.headquarters,
          sector: yf.sector,
          industry: yf.industry,
          name: nameHint,
          market: listing ?? undefined,
        });
        invalidateCompanyCache();
      } catch {
        /* keep Yahoo live response even if local write hits disk I/O */
      }
      const after = payloadFromCompany(ticker);
      if (after) {
        return NextResponse.json({ ...after, source: "yahoo" });
      }
      // Row may still fail length checks — return Yahoo live.
      const about = yf.about?.trim() || null;
      return NextResponse.json({
        ok: true,
        ticker,
        name: nameHint,
        headline: null,
        sector: yf.sector,
        sub_sector: yf.industry,
        about,
        products: mergeProductLists(
          brandsFromAbout(about),
          productsFromAbout(about),
        ),
        headquarters: yf.headquarters,
        market: listing,
        source: "yahoo",
      } satisfies NapkinAboutPayload);
    }

    return NextResponse.json({
      ok: true,
      ticker,
      name: nameHint,
      headline: null,
      sector: null,
      sub_sector: null,
      about: null,
      products: [],
      headquarters: null,
      market: listing,
      source: "none",
    } satisfies NapkinAboutPayload);
  } catch (e) {
    invalidateCompanyCache();
    const recovered = payloadFromDirectSql(ticker);
    if (recovered) return NextResponse.json(recovered);
    return NextResponse.json(
      {
        ok: false,
        ticker,
        name: nameHint,
        headline: null,
        sector: null,
        sub_sector: null,
        about: null,
        products: [],
        headquarters: null,
        market: market || resolveListingMarket(ticker),
        source: "none",
        error: e instanceof Error ? e.message : String(e),
      } satisfies NapkinAboutPayload,
      { status: 500 },
    );
  }
}
