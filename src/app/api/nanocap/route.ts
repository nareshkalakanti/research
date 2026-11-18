import { NextRequest, NextResponse } from "next/server";
import { buildMomPage, fillBseMain, fillMomQuarters, fillMomRatios, stopMomRatios } from "@/lib/momentum";
import { nanoFillJob, startNanoFill } from "@/lib/nanocap-champs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: Momentum page data. GET ?job=1: progress of the background fill. */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("job") === "1") {
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  try {
    const page = buildMomPage();
    return NextResponse.json({ ok: true, ...page, job: nanoFillJob() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** POST {kind: mom|momratio|bse, all?}: start a background fill (25, or the whole queue); returns at once. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { kind?: string; all?: boolean; fast?: boolean; stop?: boolean };
  if ((body.kind === "momratio" || body.kind === "bse") && body.stop) {
    stopMomRatios();
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  const job =
    body.kind === "bse"
      ? startNanoFill("bse", (p) => fillBseMain(p))
      : body.kind === "momratio"
      ? startNanoFill("momratio", (p) =>
          body.fast ? fillMomRatios(5000, p, false, { fast: true }) : fillMomRatios(body.all ? 60 : 20, p),
        )
      : startNanoFill("mom", (p) => fillMomQuarters(body.all ? 60 : 20, p));
  return NextResponse.json({ ok: true, job });
}
