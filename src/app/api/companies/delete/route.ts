import { NextRequest, NextResponse } from "next/server";
import { deleteCompanyEverywhere } from "@/lib/delete-company";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let ticker = (sp.get("ticker") || "").trim();
    if (!ticker) {
      try {
        const body = (await req.json()) as { ticker?: string };
        ticker = (body.ticker || "").trim();
      } catch {
        /* query only */
      }
    }
    if (!ticker) {
      return NextResponse.json(
        { ok: false, error: "ticker required" },
        { status: 400 },
      );
    }
    const result = deleteCompanyEverywhere(ticker);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: "Invalid ticker" },
        { status: 400 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Delete failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
