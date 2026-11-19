import { NextRequest, NextResponse } from "next/server";
import { invalidateCompanyCache } from "@/lib/db";
import { peopleStatus, previewPeopleSource, pullAllPeople, pullPeopleSource } from "@/lib/screener-people";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET: Screener people pages feeding the fund watchlists, with last update. */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, ...peopleStatus() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** POST {url?}: update one page, or all of them, now. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { url?: string; dry?: boolean };
  try {
    if (body.dry && body.url) {
      return NextResponse.json({ ok: true, preview: await previewPeopleSource(body.url) });
    }
    // "Update now" skips pages fetched in the last hour — no hammering Screener.
    const results = body.url ? [await pullPeopleSource(body.url)] : await pullAllPeople({ maxAgeMs: 60 * 60 * 1000 });
    invalidateCompanyCache();
    return NextResponse.json({ ok: true, results, ...peopleStatus() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
