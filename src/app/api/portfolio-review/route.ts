import { NextRequest, NextResponse } from "next/server";
import { addToReview, buildReview, FUND, removeFromReview, resolveTickers } from "@/lib/portfolio-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: the review list with Fundamental scores. */
export async function GET(req: Request) {
  try {
    const fresh = new URL(req.url).searchParams.get("fresh") === "1";
    return NextResponse.json({ ok: true, rules: FUND, ...(await buildReview({ fresh })) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** POST {add: string[]} (names, NSE symbols or BSE codes) · {remove: ticker} · {clear: true}. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { add?: string[]; remove?: string; clear?: boolean };
  try {
    if (body.clear) {
      removeFromReview(null);
      return NextResponse.json({ ok: true });
    }
    if (body.remove) {
      removeFromReview(body.remove);
      return NextResponse.json({ ok: true });
    }
    const inputs = (body.add ?? []).map(String).filter((s) => s.trim()).slice(0, 500);
    const { found, missing } = resolveTickers(inputs);
    const added = addToReview(found);
    return NextResponse.json({ ok: true, added, found, missing });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
