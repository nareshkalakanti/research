import { NextRequest, NextResponse } from "next/server";
import { bootstrapCompanyTicker } from "@/lib/company-ticker-bootstrap";
import { invalidateCompanyCache, loadAllCompanies } from "@/lib/db";
import { listingQueryMatches, rankListingQuery } from "@/lib/listing-name-match";
import { openSqliteNamed } from "@/lib/sqlite-utils";
import { searchGrowwListings } from "@/lib/web-mcap";

export const runtime = "nodejs";

export type TickerHit = {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  mcap_cr: number | null;
  source?: "local" | "groww";
};

function listingMatches(q: string, ticker: string, name: string): boolean {
  return listingQueryMatches(q, ticker, name);
}

function rankHit(q: string, h: TickerHit): number {
  return rankListingQuery(q, h.ticker, h.name);
}

function localHits(q: string, limit: number): TickerHit[] {
  const hits: TickerHit[] = [];
  const have = new Set<string>();
  const push = (row: TickerHit) => {
    const ticker = row.ticker.toUpperCase();
    if (have.has(ticker)) return;
    have.add(ticker);
    hits.push({ ...row, ticker });
  };
  for (const c of loadAllCompanies()) {
    const ticker = String(c.ticker || "").toUpperCase();
    const name = String(c.name || "").trim();
    if (!ticker) continue;
    if (!listingMatches(q, ticker, name)) continue;
    push({
      ticker,
      name: name || ticker,
      market: String(c.market || ""),
      sector: c.sector || null,
      mcap_cr:
        c.mcap_cr != null && Number.isFinite(c.mcap_cr) ? c.mcap_cr : null,
      source: "local",
    });
  }
  try {
    const db = openSqliteNamed("governance.db", {
      readonly: true,
      fileMustExist: true,
    });
    const rows = db
      .prepare(`SELECT ticker, name, market FROM companies`)
      .all() as Array<{ ticker: string; name: string; market: string }>;
    db.close();
    for (const c of rows) {
      const ticker = String(c.ticker || "").toUpperCase();
      const name = String(c.name || "").trim();
      if (!ticker || !listingMatches(q, ticker, name)) continue;
      push({
        ticker,
        name: name || ticker,
        market: String(c.market || ""),
        sector: null,
        mcap_cr: null,
        source: "local",
      });
    }
  } catch {
    /* about rows still usable */
  }
  hits.sort((a, b) => {
    const ra = rankHit(q, a);
    const rb = rankHit(q, b);
    if (ra !== rb) return ra - rb;
    return a.ticker.localeCompare(b.ticker);
  });
  return hits.slice(0, limit);
}

function toHit(
  c: ReturnType<typeof loadAllCompanies>[number] | undefined,
  fallback: TickerHit,
): TickerHit {
  if (!c) return fallback;
  return {
    ticker: c.ticker.toUpperCase(),
    name: c.name || c.ticker,
    market: c.market || fallback.market,
    sector: c.sector || null,
    mcap_cr:
      c.mcap_cr != null && Number.isFinite(c.mcap_cr) ? c.mcap_cr : null,
    source: "local",
  };
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.& -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const limit = Math.min(
    30,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 12) || 12),
  );

  if (q.length < 1) {
    return NextResponse.json({ ok: true, q, hits: [] as TickerHit[] });
  }

  const hits = localHits(q, limit);
  const have = new Set(hits.map((h) => h.ticker));
  const localStrong =
    hits.length >= limit ||
    hits.some((h) => rankHit(q, h) <= 2);

  if (q.length >= 2 && !localStrong) {
    try {
      const remote = await searchGrowwListings(q, limit);
      for (const r of remote) {
        if (have.has(r.ticker)) continue;
        if (!listingMatches(q, r.ticker, r.name)) continue;
        have.add(r.ticker);
        hits.push({
          ticker: r.ticker,
          name: r.name,
          market: r.market,
          sector: null,
          mcap_cr: null,
          source: "groww",
        });
      }
    } catch {
      /* local hits still usable */
    }
  }

  hits.sort((a, b) => {
    const ra = rankHit(q, a);
    const rb = rankHit(q, b);
    if (ra !== rb) return ra - rb;
    if ((a.source || "local") !== (b.source || "local")) {
      return (a.source || "local") === "local" ? -1 : 1;
    }
    return a.ticker.localeCompare(b.ticker);
  });

  return NextResponse.json({
    ok: true,
    q,
    hits: hits.slice(0, limit),
  });
}

/** Add a Groww/exchange listing into company_about so DIN / people can attach. */
export async function POST(req: NextRequest) {
  let body: { ticker?: string; name?: string; market?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const ticker = (body.ticker || "").trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }
  const before = new Set(
    loadAllCompanies().map((c) => c.ticker.toUpperCase()),
  );
  const ok = await bootstrapCompanyTicker(ticker, {
    name: body.name || ticker,
    market: body.market || null,
  });
  invalidateCompanyCache();
  const all = loadAllCompanies();
  const added = all.filter((c) => !before.has(c.ticker.toUpperCase()));
  const co =
    all.find((c) => c.ticker.toUpperCase() === ticker) ||
    added[0] ||
    all.find(
      (c) =>
        (body.name || "").trim() &&
        c.name.toLowerCase() === String(body.name || "").trim().toLowerCase(),
    );
  const hit = toHit(co, {
    ticker,
    name: body.name || ticker,
    market: body.market || "",
    sector: null,
    mcap_cr: null,
    source: "local",
  });
  if (!ok && !co) {
    return NextResponse.json(
      { ok: false, error: "Could not add listing from Groww / exchange", hit },
      { status: 422 },
    );
  }
  return NextResponse.json({ ok: true, hit });
}
