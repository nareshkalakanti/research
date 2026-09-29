import { NextRequest, NextResponse } from "next/server";
import { bootstrapCompanyTicker } from "@/lib/company-ticker-bootstrap";
import { invalidateCompanyCache, loadAllCompanies } from "@/lib/db";
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

function compactSym(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function listingMatches(q: string, ticker: string, name: string): boolean {
  const Q = q.trim().toUpperCase();
  if (!Q) return false;
  const t = ticker.toUpperCase();
  const n = name.toUpperCase();
  if (t === Q || t.startsWith(Q) || t.includes(Q)) return true;
  if (`${t} ${n}`.includes(Q) || n.includes(Q)) return true;
  const cq = compactSym(Q);
  if (cq.length < 2) return false;
  const ct = compactSym(t);
  const cn = compactSym(n);
  return ct === cq || ct.startsWith(cq) || ct.includes(cq) || cn.includes(cq);
}

function rankHit(q: string, h: TickerHit): number {
  const t = h.ticker.toUpperCase();
  const n = h.name.toUpperCase();
  const cq = compactSym(q);
  const ct = compactSym(t);
  if (t === q || (cq.length >= 2 && ct === cq)) return 0;
  if (t.startsWith(q) || (cq.length >= 2 && ct.startsWith(cq))) return 1;
  if (n.startsWith(q)) return 2;
  if (t.includes(q) || n.includes(q)) return 3;
  if (cq.length >= 2 && (ct.includes(cq) || compactSym(n).includes(cq))) return 4;
  return 9;
}

function localHits(q: string, limit: number): TickerHit[] {
  const hits: TickerHit[] = [];
  for (const c of loadAllCompanies()) {
    const ticker = String(c.ticker || "").toUpperCase();
    const name = String(c.name || "").trim();
    if (!ticker) continue;
    if (!listingMatches(q, ticker, name)) continue;
    hits.push({
      ticker,
      name: name || ticker,
      market: String(c.market || ""),
      sector: c.sector || null,
      mcap_cr:
        c.mcap_cr != null && Number.isFinite(c.mcap_cr) ? c.mcap_cr : null,
      source: "local",
    });
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
    .replace(/[^A-Z0-9.& -]/g, "");
  const limit = Math.min(
    30,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 12) || 12),
  );

  if (q.length < 1) {
    return NextResponse.json({ ok: true, q, hits: [] as TickerHit[] });
  }

  const hits = localHits(q, limit);
  const have = new Set(hits.map((h) => h.ticker));

  if (q.length >= 2 && hits.length < limit) {
    try {
      const remote = await searchGrowwListings(q, limit);
      for (const r of remote) {
        if (have.has(r.ticker)) continue;
        have.add(r.ticker);
        hits.push({
          ticker: r.ticker,
          name: r.name,
          market: r.market,
          sector: null,
          mcap_cr: null,
          source: "groww",
        });
        if (hits.length >= limit) break;
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
