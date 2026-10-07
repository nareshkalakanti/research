import { NextResponse } from "next/server";
import { loadCompanyEvidence } from "@/lib/valuepickr-board";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ev = loadCompanyEvidence(decodeURIComponent(id));
  return NextResponse.json({ ok: true, themes: ev.themes });
}
