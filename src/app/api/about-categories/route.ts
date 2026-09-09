import { NextRequest, NextResponse } from "next/server";
import {
  aboutCategoryStats,
  listAboutCategoryMatches,
} from "@/lib/about-category-match";
import { loadCorporateEventKeywords } from "@/lib/corporate-event-keywords";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const market = sp.get("market") || "All";
  const q = sp.get("q") || "";
  const keyword = sp.get("keyword") || "";
  const limit = Math.min(300, Math.max(1, Number(sp.get("limit") || 80)));
  const offset = Math.max(0, Number(sp.get("offset") || 0));

  const file = loadCorporateEventKeywords();
  const { rows, total } = listAboutCategoryMatches({
    market,
    q,
    keyword,
    limit,
    offset,
  });
  const stats = aboutCategoryStats();

  return NextResponse.json({
    ok: true,
    stats: {
      ...stats,
      aliases_in_json: Object.keys(file.aliases || {}).length,
      concall_focus: file.concall_focus?.length ?? 0,
      json_updated_at: file.updated_at,
      json_source: file.source,
    },
    total,
    rows,
  });
}
