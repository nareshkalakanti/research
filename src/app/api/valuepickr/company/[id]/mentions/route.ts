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
    mentions_30d: c?.mentions_30d ?? 0,
    mentions_90d: c?.mentions_90d ?? 0,
    mentions_12m: c?.mentions_12m ?? 0,
    mentions_all: c?.mentions_all ?? 0,
    months: ev.months,
  });
}
