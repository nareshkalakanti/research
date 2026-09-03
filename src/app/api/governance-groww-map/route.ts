import { NextResponse } from "next/server";
import {
  applyGrowwDinMap,
  previewGrowwDinMap,
} from "@/lib/gov-groww-map";

export const runtime = "nodejs";

export async function GET() {
  const preview = previewGrowwDinMap();
  return NextResponse.json({
    ok: true,
    ...preview,
    message: preview.linked
      ? `${preview.linked} unique Groww names can link to an existing DIN`
      : "No high-confidence Groww → DIN matches left",
  });
}

export async function POST() {
  const result = applyGrowwDinMap();
  return NextResponse.json({
    ok: true,
    ...result,
    message: result.linked
      ? `Linked ${result.linked} Groww CEO/MD names to existing DIN directors`
      : "No high-confidence Groww → DIN matches to apply",
  });
}
