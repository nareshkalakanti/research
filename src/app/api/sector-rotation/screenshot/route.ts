import { NextRequest } from "next/server";
import {
  importSectorFromScreenshot,
  type SectorShotEvent,
} from "@/lib/sector-screenshot";

export const runtime = "nodejs";
export const maxDuration = 180;

async function imageFromForm(form: FormData): Promise<string> {
  const file = form.get("file");
  if (file && typeof file === "object" && "arrayBuffer" in file) {
    const buf = Buffer.from(await (file as File).arrayBuffer());
    const mime = (file as File).type || "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  }
  return String(form.get("image") || "").trim();
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") || "";
  let imageDataUrl = "";
  let priorIndustry = "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    imageDataUrl = await imageFromForm(form);
    priorIndustry = String(form.get("priorIndustry") || "").trim();
  } else {
    try {
      const body = (await req.json()) as { image?: string; priorIndustry?: string };
      imageDataUrl = (body.image || "").trim();
      priorIndustry = (body.priorIndustry || "").trim();
    } catch {
      imageDataUrl = "";
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: SectorShotEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
      };
      try {
        const result = await importSectorFromScreenshot(
          imageDataUrl,
          send,
          priorIndustry,
        );
        send({
          t: "done",
          industry: result.industry,
          names: result.names,
          unresolved: result.unresolved,
          sector: result.sector,
        });
      } catch (e) {
        send({
          t: "error",
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
