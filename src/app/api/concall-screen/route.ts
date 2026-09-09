import { NextRequest, NextResponse } from "next/server";
import {
  addConcallResearchField,
  downloadConcallPdf,
  isConcallPdfProxyUrl,
  listConcallHistory,
  loadConcallResearchFields,
  readConcallPdf,
  setConcallResearchFieldEnabled,
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
    const fields = loadConcallResearchFields({ force: true });
    return NextResponse.json({
      ok: true,
      fields: fields.fields,
      pass_rule: fields.pass_rule,
      purpose: fields.purpose,
      updated_at: fields.updated_at,
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
      const action = String(form.get("action") || "read_pdf").trim();
      if (action === "read_pdf" || action === "extract") {
        const url = String(form.get("url") || "").trim() || null;
        const file = form.get("file");
        let pdfBuffer: Buffer | null = null;
        if (file && typeof file === "object" && "arrayBuffer" in file) {
          const ab = await (file as File).arrayBuffer();
          pdfBuffer = Buffer.from(ab);
        }
        const result = await readConcallPdf({ url, pdfBuffer });
        return NextResponse.json(result, {
          status: result.ok ? 200 : 422,
        });
      }
      return NextResponse.json(
        { ok: false, error: "Unknown multipart action" },
        { status: 400 },
      );
    }

    let body: {
      action?: string;
      id?: string;
      label?: string;
      group?: string;
      required?: boolean;
      notes?: string;
      enabled?: boolean;
      url?: string;
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }

    const action = body.action?.trim() || "add_field";

    if (action === "read_pdf" || action === "extract") {
      const url = body.url?.trim() || null;
      if (!url) {
        return NextResponse.json(
          { ok: false, error: "url required (or upload multipart file)" },
          { status: 400 },
        );
      }
      const result = await readConcallPdf({ url });
      return NextResponse.json(result, {
        status: result.ok ? 200 : 422,
      });
    }

    if (action === "add_field") {
      const field = addConcallResearchField({
        id: body.id,
        label: body.label || "",
        group: body.group,
        required: body.required,
        notes: body.notes,
        enabled: body.enabled,
      });
      return NextResponse.json({
        ok: true,
        field,
        fields: loadConcallResearchFields({ force: true }).fields,
      });
    }

    if (action === "set_enabled") {
      const id = body.id?.trim() || "";
      if (!id) {
        return NextResponse.json(
          { ok: false, error: "id required" },
          { status: 400 },
        );
      }
      const field = setConcallResearchFieldEnabled(id, body.enabled !== false);
      return NextResponse.json({
        ok: true,
        field,
        fields: loadConcallResearchFields({ force: true }).fields,
      });
    }

    return NextResponse.json(
      { ok: false, error: `Unknown action: ${action}` },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Concall research update failed",
      },
      { status: 400 },
    );
  }
}
