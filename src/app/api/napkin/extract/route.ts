import { NextRequest, NextResponse } from "next/server";
import { extractPdf } from "@/lib/napkin/pdf";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(req: NextRequest) {
  let url = "";
  try {
    const body = (await req.json()) as { url?: string };
    url = (body.url || "").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
  if (!url) {
    return NextResponse.json({ ok: false, error: "PDF URL required" }, { status: 400 });
  }
  try {
    const doc = await extractPdf(url);
    const preview = doc.pages.slice(0, 3).map((p) => ({
      page_number: p.page_number,
      text: p.text.slice(0, 2500),
    }));
    return NextResponse.json({
      ok: true,
      title: doc.title,
      pages: doc.pages.map((p) => ({
        page_number: p.page_number,
        text: p.text,
      })),
      full_text: doc.full_text,
      preview,
      qwen: "Local Qwen is not connected yet.",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 422 });
  }
}
