import { NextRequest, NextResponse } from "next/server";
import {
  downloadConcallPdf,
  isConcallPdfProxyUrl,
  listConcallHistory,
  loadConcallResearchSchema,
  screenConcallPdf,
} from "@/lib/concall-screen";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const pdfUrl = req.nextUrl.searchParams.get("pdf")?.trim() || "";
  if (pdfUrl) {
    if (!isConcallPdfProxyUrl(pdfUrl)) {
      return NextResponse.json(
        { ok: false, error: "PDF host not allowed" },
        { status: 400 },
      );
    }
    const buf = await downloadConcallPdf(pdfUrl);
    if (!buf) {
      return NextResponse.json(
        { ok: false, error: "Could not fetch PDF" },
        { status: 502 },
      );
    }
    const asDownload = req.nextUrl.searchParams.get("download") === "1";
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": asDownload
          ? 'attachment; filename="concall.pdf"'
          : 'inline; filename="concall.pdf"',
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  try {
    const limit = Math.min(
      100,
      Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 40)),
    );
    const schema = loadConcallResearchSchema({ force: true });
    return NextResponse.json({
      ok: true,
      schema,
      pass_rule: schema.pass_rule ?? null,
      history: listConcallHistory(limit),
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Failed to load concall research",
      },
      { status: 500 },
    );
  }
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
      const result = await screenConcallPdf({ url, pdfBuffer });
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
        { ok: false, error: "Paste a PDF URL or upload a file" },
        { status: 400 },
      );
    }
    const result = await screenConcallPdf({ url });
    return NextResponse.json(result, {
      status: result.ok ? 200 : 422,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Concall screen failed",
      },
      { status: 500 },
    );
  }
}
