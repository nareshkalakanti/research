import { NextRequest, NextResponse } from "next/server";
import { nanoFillJob, startNanoFill } from "@/lib/nanocap-champs";
import { comboTest, runModelPipeline, stopModelRun } from "@/lib/sm-model";
import { buildShortlist } from "@/lib/shortlist";
import { buildModelPage } from "@/lib/sm-model-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: model report + data coverage + job progress. */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("job") === "1") {
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  if (req.nextUrl.searchParams.get("combo") === "1") {
    const trust = new Map<string, number>();
    for (const r of buildShortlist().rows) if (r.trust != null) trust.set(r.ticker.toUpperCase(), r.trust);
    return NextResponse.json({ ok: true, combo: comboTest(trust) });
  }
  try {
    return NextResponse.json({ ok: true, ...buildModelPage(), job: nanoFillJob() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** POST {stop?, retrainOnly?}: run the pipeline (history → prices → train → score) in the background. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { stop?: boolean; retrainOnly?: boolean };
  if (body.stop) {
    stopModelRun();
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  const job = startNanoFill("smmodel", (p) => runModelPipeline(p, { skipData: !!body.retrainOnly }));
  return NextResponse.json({ ok: true, job });
}
