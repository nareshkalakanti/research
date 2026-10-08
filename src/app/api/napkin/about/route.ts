/**
 * Napkin About panel — company_about rich fields, Yahoo fill when empty.
 */
import { NextRequest, NextResponse } from "next/server";
import { loadAllCompanies, pickAboutText } from "@/lib/db";
import { saveYfAboutProfile } from "@/lib/company-about-write";
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

function payloadFromCompany(ticker: string): NapkinAboutPayload | null {
  const key = ticker.toUpperCase();
  const row = loadAllCompanies().find((c) => c.ticker.toUpperCase() === key);
  if (!row) return null;
  const about = pickAboutText(row);
  const products = splitProducts(row.products);
  const fromAbout = products.length < 2 ? productsFromAbout(about) : [];
  const merged = [...products];
  for (const p of fromAbout) {
    if (!merged.some((x) => x.toLowerCase() === p.toLowerCase())) merged.push(p);
  }
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

    const yf = await fetchYfAboutProfile(ticker, market);
    if (yf?.about || yf?.website || yf?.headquarters) {
      saveYfAboutProfile(ticker, {
        about: yf.about,
        website: yf.website,
        headquarters: yf.headquarters,
        sector: yf.sector,
        industry: yf.industry,
        name: nameHint,
        market: market ?? undefined,
      });
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
        products: productsFromAbout(about),
        headquarters: yf.headquarters,
        market,
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
      market,
      source: "none",
    } satisfies NapkinAboutPayload);
  } catch (e) {
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
        market,
        source: "none",
        error: e instanceof Error ? e.message : String(e),
      } satisfies NapkinAboutPayload,
      { status: 500 },
    );
  }
}
