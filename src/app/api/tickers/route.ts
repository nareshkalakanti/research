import { NextRequest, NextResponse } from "next/server";
import { loadAllCompanies } from "@/lib/db";

export const runtime = "nodejs";

type Hit = { ticker: string; name: string; market: string };

function rankHit(q: string, h: Hit): number {
  const t = h.ticker.toUpperCase();
  const n = h.name.toUpperCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (n.startsWith(q)) return 2;
  if (t.includes(q)) return 3;
  if (n.includes(q)) return 4;
  return 9;
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
    return NextResponse.json({ ok: true, q, hits: [] as Hit[] });
  }

  const hits: Hit[] = [];
  for (const c of loadAllCompanies()) {
    const ticker = String(c.ticker || "").toUpperCase();
    const name = String(c.name || "").trim();
    if (!ticker) continue;
    const blob = `${ticker} ${name}`.toUpperCase();
    if (!blob.includes(q) && !ticker.startsWith(q)) continue;
    hits.push({
      ticker,
      name: name || ticker,
      market: String(c.market || ""),
    });
  }

  hits.sort((a, b) => {
    const ra = rankHit(q, a);
    const rb = rankHit(q, b);
    if (ra !== rb) return ra - rb;
    return a.ticker.localeCompare(b.ticker);
  });

  return NextResponse.json({
    ok: true,
    q,
    hits: hits.slice(0, limit),
  });
}
