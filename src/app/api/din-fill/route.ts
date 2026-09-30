import { NextRequest, NextResponse } from "next/server";
import {
  previewDinScreenshot,
  resolveDinCompany,
  saveDinSeats,
} from "@/lib/din-fill";
import { inferDirectorCategory, type BoardSeat } from "@/lib/nse-governance";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET() {
  return NextResponse.json({ ok: true });
}

function asSeats(raw: unknown): BoardSeat[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        din: String(r.din || "").replace(/\D/g, ""),
        name: String(r.name || "").trim(),
        designation: String(r.designation || "Director").trim(),
        category: inferDirectorCategory(String(r.designation || "Director")),
        source: "zauba_screenshot",
        as_of: "",
      } as BoardSeat;
    })
    .filter((s) => s.din.length === 8 && s.name.length >= 5);
}

async function imageFromForm(form: FormData): Promise<string> {
  const file = form.get("file");
  if (file && typeof file === "object" && "arrayBuffer" in file) {
    const buf = Buffer.from(await (file as File).arrayBuffer());
    const mime = (file as File).type || "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  }
  return "";
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    let action = "preview";
    let ticker = "";
    let company = "";
    let imageDataUrl = "";
    let seats: BoardSeat[] = [];

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      action = String(form.get("action") || "preview").trim() || "preview";
      ticker = String(form.get("ticker") || "").trim();
      company = String(form.get("company") || "").trim();
      imageDataUrl = await imageFromForm(form);
      const seatsRaw = String(form.get("seats") || "").trim();
      if (seatsRaw) {
        try {
          seats = asSeats(JSON.parse(seatsRaw) as unknown);
        } catch {
          seats = [];
        }
      }
    } else {
      const body = (await req.json()) as {
        action?: string;
        ticker?: string;
        company?: string;
        image?: string;
        seats?: unknown;
      };
      action = (body.action || "preview").trim() || "preview";
      ticker = (body.ticker || "").trim();
      company = (body.company || "").trim();
      imageDataUrl = (body.image || "").trim();
      seats = asSeats(body.seats);
    }

    if (action === "resolve") {
      const result = await resolveDinCompany({ company, ticker });
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === "save") {
      const result = await saveDinSeats({ ticker, company, seats });
      return NextResponse.json({ ok: true, ...result });
    }

    if (!imageDataUrl.startsWith("data:image")) {
      return NextResponse.json(
        { ok: false, error: "screenshot image required" },
        { status: 400 },
      );
    }

    const result = await previewDinScreenshot({ ticker, imageDataUrl });
    return NextResponse.json({ ok: true, saved: 0, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "DIN fill failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 422 });
  }
}
