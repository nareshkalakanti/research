import { NextRequest, NextResponse } from "next/server";
import {
  downloadBuybackPdf,
  isBuybackPdfProxyUrl,
  listBuybackHistory,
  screenBuybackPdf,
} from "@/lib/buyback-screen";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const pdfUrl = req.nextUrl.searchParams.get("pdf")?.trim() || "";
  if (pdfUrl) {
    if (!isBuybackPdfProxyUrl(pdfUrl)) {
      return NextResponse.json(
        { ok: false, error: "PDF host not allowed" },
        { status: 400 },
      );
    }
    const buf = await downloadBuybackPdf(pdfUrl);
    if (!buf) {
      return NextResponse.json(
        { ok: false, error: "Could not fetch PDF" },
        { status: 502 },
      );
    }
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=\"filing.pdf\"",
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const limit = Math.min(
    100,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 1)),
  );
  const decision = req.nextUrl.searchParams.get("decision");
  return NextResponse.json({
    ok: true,
    history: listBuybackHistory(limit, {
      decision:
        decision === "pass" || decision === "pass_tender"
          ? "pass_tender"
          : null,
    }),
  });
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const url = String(form.get("url") || "").trim() || null;
      const file = form.get("file");
      let pdfBuffer: Buffer | null = null;
      if (file && typeof file === "object" && "arrayBuffer" in file) {
        const ab = await (file as File).arrayBuffer();
        pdfBuffer = Buffer.from(ab);
      }
      const result = await screenBuybackPdf({ url, pdfBuffer });
      return NextResponse.json(result, {
        status: result.ok ? 200 : 422,
      });
    }

    let body: { url?: string } = {};
    try {
      body = (await req.json()) as { url?: string };
    } catch {
      body = {};
    }
    const url = body.url?.trim() || null;
    if (!url) {
      return NextResponse.json(
        { ok: false, error: "Provide url or multipart file" },
        { status: 400 },
      );
    }
    const result = await screenBuybackPdf({ url });
    return NextResponse.json(result, {
      status: result.ok ? 200 : 422,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Buyback screen failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 503 });
  }
}
