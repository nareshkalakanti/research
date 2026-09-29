import { NextRequest, NextResponse } from "next/server";
import { applyDinScreenshot, listMissingDinJobs } from "@/lib/din-fill";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET() {
  return NextResponse.json({ ok: true, ...listMissingDinJobs() });
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    let ticker = "";
    let imageDataUrl = "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      ticker = String(form.get("ticker") || "").trim();
      const file = form.get("file");
      if (file && typeof file === "object" && "arrayBuffer" in file) {
        const buf = Buffer.from(await (file as File).arrayBuffer());
        const mime = (file as File).type || "image/png";
        imageDataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      }
    } else {
      const body = (await req.json()) as {
        ticker?: string;
        image?: string;
      };
      ticker = (body.ticker || "").trim();
      imageDataUrl = (body.image || "").trim();
    }

    if (!ticker || !imageDataUrl.startsWith("data:image")) {
      return NextResponse.json(
        { ok: false, error: "ticker and screenshot image required" },
        { status: 400 },
      );
    }

    const result = await applyDinScreenshot({ ticker, imageDataUrl });
    const next = listMissingDinJobs();
    return NextResponse.json({ ok: true, ...result, ...next });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "DIN fill failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 422 });
  }
}
