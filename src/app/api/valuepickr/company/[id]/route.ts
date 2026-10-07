import { NextResponse } from "next/server";
import { loadCompanyEvidence } from "@/lib/valuepickr-board";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const ev = loadCompanyEvidence(decodeURIComponent(id));
    if (!ev.company) {
      return NextResponse.json(
        { ok: false, error: "UNMAPPED COMPANY", unmapped: true },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, ...ev });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
