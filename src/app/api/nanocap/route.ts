import { NextRequest, NextResponse } from "next/server";
import { buildFaPage, runFaPriceCheck } from "@/lib/fallen-angels";
import { buildHgPage, runHgPriceCheck, runHolderScan } from "@/lib/hidden-gems";
import { buildLvPage, fillLvData } from "@/lib/listed-ventures";
import {
  buildNanoPage,
  fillNanoQuarters,
  fillQualityRatios,
  nanoFillJob,
  startNanoFill,
} from "@/lib/nanocap-champs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?basket=nano|lv|fa|hg: page data. GET ?job=1: progress of the background fill. */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("job") === "1") {
    return NextResponse.json({ ok: true, job: nanoFillJob() });
  }
  try {
    const basket = req.nextUrl.searchParams.get("basket");
    const page =
      basket === "lv"
        ? buildLvPage()
        : basket === "fa"
          ? await buildFaPage()
          : basket === "hg"
            ? await buildHgPage()
            : buildNanoPage();
    return NextResponse.json({ ok: true, ...page, job: nanoFillJob() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** POST {kind: nano|quality|lv, all?}: start a background fill (25, or the whole queue); returns at once. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { kind?: string; all?: boolean };
  const limit = body.all ? 5000 : 25;
  const job =
    body.kind === "hgscan"
      ? startNanoFill("hgscan", (p) => runHolderScan(p))
      : body.kind === "hgprice"
      ? startNanoFill("hgprice", (p) => runHgPriceCheck(p))
      : body.kind === "fa"
      ? startNanoFill("fa", (p) => runFaPriceCheck(p))
      : body.kind === "lv"
      ? startNanoFill("lv", (p) => fillLvData(limit, p))
      : body.kind === "quality"
        ? startNanoFill("quality", (p) => fillQualityRatios(limit, p))
        : startNanoFill("nano", (p) => fillNanoQuarters(limit, p));
  return NextResponse.json({ ok: true, job });
}
