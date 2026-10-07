import { NextResponse } from "next/server";
import { loadCompanyEvidence } from "@/lib/valuepickr-board";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ev = loadCompanyEvidence(decodeURIComponent(id));
  const c = ev.row?.components;
  return NextResponse.json({
    ok: true,
    unique: c?.contributors_30d ?? 0,
    unique_90d: c?.contributors_90d ?? 0,
    unique_12m: c?.contributors_12m ?? 0,
    new_30d: c?.new_contributors_30d ?? 0,
    new_90d: c?.new_contributors_90d ?? 0,
    returning_30d: c?.returning_30d ?? 0,
    posts_per_contributor_30d: c?.posts_per_contributor_30d ?? null,
  });
}
