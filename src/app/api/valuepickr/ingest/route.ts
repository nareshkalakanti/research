import { NextResponse } from "next/server";
import { ingestValuepickr } from "@/lib/valuepickr-ingest";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST() {
  try {
    const stats = await ingestValuepickr();
    return NextResponse.json({ ok: true, ...stats });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
