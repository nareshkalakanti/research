import { NextRequest, NextResponse } from "next/server";
import { loadPead2Rows, type Pead2Row } from "@/lib/pead2-table";
import { refreshPeadReturns } from "@/lib/pead2-returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SortKey = keyof Pead2Row;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function filterRows(
  all: Pead2Row[],
  sp: URLSearchParams,
): { rows: Pead2Row[]; stats: { scored: number } } {
  const q = (sp.get("q") || "").trim().toLowerCase();
  const mcapMin = num(sp.get("mcapMin"));
  const mcapMax = num(sp.get("mcapMax"));
  const stats = { scored: all.filter((r) => r.pead_score != null).length };
  let rows = all;
  if (q) {
    rows = rows.filter((r) => {
      const hay = `${r.ticker} ${r.name} ${r.sector || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }
  if (mcapMin != null && mcapMin > 0) {
    rows = rows.filter((r) => r.mcap_cr != null && r.mcap_cr >= mcapMin);
  }
  if (mcapMax != null) {
    rows = rows.filter((r) => r.mcap_cr != null && r.mcap_cr <= mcapMax);
  }
  return { rows, stats };
}

function sortRows(rows: Pead2Row[], sort: string, dir: 1 | -1): Pead2Row[] {
  const key = (sort || "pead_score") as SortKey;
  const copy = [...rows];
  copy.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const aMissing = av == null || av === "";
    const bMissing = bv == null || bv === "";
    if (aMissing && bMissing) return a.ticker.localeCompare(b.ticker);
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      if (av !== bv) return (av < bv ? -1 : 1) * dir;
    } else {
      const cmp = String(av).localeCompare(String(bv));
      if (cmp) return cmp * dir;
    }
    return a.ticker.localeCompare(b.ticker);
  });
  return copy;
}

function pageSlice(req: NextRequest, rows: Pead2Row[]) {
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get("page") || 1));
  const pageSize = Math.min(100, Math.max(10, Number(sp.get("pageSize") || 40)));
  const sort = sp.get("sort") || "result_date";
  const dir = sp.get("dir") === "asc" ? (1 as const) : (-1 as const);
  const sorted = sortRows(rows, sort, dir);
  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return { total, page, pages, rows: sorted.slice(start, start + pageSize) };
}

export async function GET(req: NextRequest) {
  const all = loadPead2Rows();
  const { rows, stats } = filterRows(all, req.nextUrl.searchParams);
  const slice = pageSlice(req, rows);
  return NextResponse.json({ stats, ...slice });
}

export async function POST(req: NextRequest) {
  let body: { tickers?: string[] } = {};
  try {
    body = (await req.json()) as { tickers?: string[] };
  } catch {
    body = {};
  }
  const all = loadPead2Rows();
  const want = new Set(
    (body.tickers || []).map((t) => t.trim().toUpperCase()).filter(Boolean),
  );
  const { rows, stats } = filterRows(all, req.nextUrl.searchParams);
  const targets = want.size ? rows.filter((r) => want.has(r.ticker)) : rows.slice(0, 40);
  const { updated } = await refreshPeadReturns(targets);
  const fresh = loadPead2Rows();
  const next = filterRows(fresh, req.nextUrl.searchParams);
  const slice = pageSlice(req, next.rows);
  return NextResponse.json({ stats, updated, ...slice });
}
