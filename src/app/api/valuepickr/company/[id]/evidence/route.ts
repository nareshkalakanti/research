import { NextRequest, NextResponse } from "next/server";
import { loadCompanyEvidence } from "@/lib/valuepickr-board";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const theme = (req.nextUrl.searchParams.get("theme") || "").trim();
  const ev = loadCompanyEvidence(decodeURIComponent(id));
  const posts = theme
    ? ev.posts.filter((p) => p.themes.includes(theme))
    : ev.posts;
  return NextResponse.json({
    ok: true,
    quality: ev.row?.quality ?? null,
    signal: ev.row?.signal ?? null,
    components: ev.row?.components ?? null,
    posts,
  });
}
