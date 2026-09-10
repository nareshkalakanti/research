import { NextRequest, NextResponse } from "next/server";
import {
  discoverConcallPdfSources,
  downloadConcallPdf,
  extractConcallMaterialsText,
  generateConcallNotesForRow,
  getConcallCombinedText,
  getConcallQuantJson,
  isConcallPdfProxyUrl,
  listConcallHistory,
  deleteConcallHistoryByIds,
  loadConcallResearchSchema,
  refreshConcallHistoryPrices,
  refreshConcallHistoryRows,
  runConcallQuantForRow,
  screenConcallFromCombinedText,
  screenConcallMaterials,
  screenConcallPdf,
} from "@/lib/concall-screen";
import {
  loadQuantGold,
  compareQuantJson,
} from "@/lib/concall-quant-extract";

export const runtime = "nodejs";
export const maxDuration = 480;

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

  const fixture = req.nextUrl.searchParams.get("fixture")?.trim() || "";
  if (fixture === "executive" || fixture === "executive-summary") {
    try {
      return NextResponse.json({
        ok: true,
        kind: "executive",
        source: "test/ExecutiveSummary.json",
        json: loadQuantGold("executive"),
      });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : "Gold missing" },
        { status: 404 },
      );
    }
  }
  if (fixture === "highlights" || fixture === "highlight-sentiment") {
    try {
      return NextResponse.json({
        ok: true,
        kind: "highlights",
        source: "test/HighlightSentiment.json",
        json: loadQuantGold("highlights"),
      });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : "Gold missing" },
        { status: 404 },
      );
    }
  }

  const quantKind = req.nextUrl.searchParams.get("quant")?.trim() || "";
  const quantId = Number(req.nextUrl.searchParams.get("id") || 0);
  if (
    (quantKind === "executive" || quantKind === "highlights") &&
    Number.isInteger(quantId) &&
    quantId > 0
  ) {
    const got = getConcallQuantJson({
      id: quantId,
      kind: quantKind,
    });
    const withGold = req.nextUrl.searchParams.get("compare") === "1";
    let compare = undefined;
    if (withGold && got.json) {
      try {
        compare = compareQuantJson(got.json, loadQuantGold(quantKind));
      } catch {
        /* ignore */
      }
    }
    return NextResponse.json(
      { ...got, compare },
      { status: got.ok ? 200 : 404 },
    );
  }

  const discoverTicker = req.nextUrl.searchParams.get("ticker")?.trim() || "";
  if (req.nextUrl.searchParams.get("discover") === "1") {
    try {
      const found = await discoverConcallPdfSources(discoverTicker);
      return NextResponse.json(found);
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: e instanceof Error ? e.message : "Discover failed",
        },
        { status: 400 },
      );
    }
  }

  try {
    const limit = Math.min(
      100,
      Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 40)),
    );
    const schema = loadConcallResearchSchema({ force: true });
    let history = listConcallHistory(limit);
    if (req.nextUrl.searchParams.get("prices") !== "0") {
      history = await refreshConcallHistoryPrices(history);
    }
    return NextResponse.json({
      ok: true,
      schema,
      pass_rule: schema.pass_rule ?? null,
      history,
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
      const readUpload = async (key: string): Promise<Buffer | null> => {
        const f = form.get(key);
        if (!f || typeof f === "string") return null;
        try {
          const blob = f as Blob;
          if (typeof blob.arrayBuffer !== "function") return null;
          if (typeof blob.size === "number" && blob.size <= 0) return null;
          const ab = await blob.arrayBuffer();
          if (!ab.byteLength) return null;
          return Buffer.from(ab);
        } catch {
          return null;
        }
      };
      const urlTranscript =
        String(form.get("url_transcript") || form.get("url") || "").trim() ||
        null;
      const urlPpt = String(form.get("url_ppt") || "").trim() || null;
      let fileTranscript = await readUpload("file_transcript");
      let filePpt = await readUpload("file_ppt");
      // Legacy single "file" field — assign to whichever slot is open.
      if (!fileTranscript && !filePpt) {
        const legacy = await readUpload("file");
        if (legacy) {
          if (urlTranscript && !urlPpt) filePpt = legacy;
          else if (urlPpt && !urlTranscript) fileTranscript = legacy;
          else filePpt = legacy;
        }
      }

      const mode = String(form.get("mode") || form.get("action") || "")
        .trim()
        .toLowerCase();

      if (mode === "extract_text" || mode === "text") {
        const wantStream =
          String(form.get("stream") || "").trim() === "1" ||
          (req.headers.get("accept") || "").includes("ndjson");

        if (wantStream) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const send = (obj: Record<string, unknown>) => {
                controller.enqueue(
                  encoder.encode(`${JSON.stringify(obj)}\n`),
                );
              };
              try {
                const textResult = await extractConcallMaterialsText({
                  transcriptUrl: urlTranscript,
                  transcriptBuffer: fileTranscript,
                  pptUrl: urlPpt,
                  pptBuffer: filePpt,
                  onProgress: (p) => send({ ...p }),
                });
                send({
                  type: "result",
                  ok: textResult.ok,
                  mode: "extract_text",
                  materials: textResult.materials,
                  combined_text: textResult.combined_text,
                  text_chars: textResult.text_chars,
                  error: textResult.error,
                });
              } catch (e) {
                send({
                  type: "error",
                  ok: false,
                  error:
                    e instanceof Error ? e.message : "Text extract failed",
                });
              } finally {
                controller.close();
              }
            },
          });
          return new NextResponse(stream, {
            status: 200,
            headers: {
              "Content-Type": "application/x-ndjson; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }

        const textResult = await extractConcallMaterialsText({
          transcriptUrl: urlTranscript,
          transcriptBuffer: fileTranscript,
          pptUrl: urlPpt,
          pptBuffer: filePpt,
        });
        return NextResponse.json(
          {
            ok: textResult.ok,
            mode: "extract_text",
            materials: textResult.materials,
            combined_text: textResult.combined_text,
            text_chars: textResult.text_chars,
            error: textResult.error,
            decision: textResult.ok ? "review" : "fail",
            why: textResult.ok
              ? "PDF text extracted (transcript / PPT)"
              : textResult.error || "Text extract failed",
            extract: {},
            extract_json: {},
            engine: "pdf-text",
            text_excerpt: textResult.combined_text ||
              textResult.materials.transcript?.text ||
              textResult.materials.ppt?.text ||
              "",
            source_url:
              textResult.materials.transcript?.source_url ||
              textResult.materials.ppt?.source_url ||
              null,
          },
          { status: textResult.ok ? 200 : 422 },
        );
      }

      const result = await screenConcallMaterials({
        transcriptUrl: urlTranscript,
        transcriptBuffer: fileTranscript,
        pptUrl: urlPpt,
        pptBuffer: filePpt,
      });
      return NextResponse.json(result, {
        status: result.ok ? 200 : 422,
      });
    }

    let body: {
      url?: string;
      url_transcript?: string;
      url_ppt?: string;
      action?: string;
      limit?: number;
      reparsePdf?: boolean;
      id?: number;
      ids?: number[];
      extract?: Record<string, unknown>;
      source_url?: string | null;
      transcriptText?: string | null;
      combined_text?: string | null;
      combinedText?: string | null;
      kind?: "executive" | "highlights" | "both";
      compare?: boolean;
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }

    if (body.action === "delete") {
      const ids = Array.isArray(body.ids)
        ? body.ids
        : body.id != null
          ? [body.id]
          : [];
      const result = deleteConcallHistoryByIds(ids);
      const history = listConcallHistory(body.limit ?? 40);
      return NextResponse.json(
        { ...result, history },
        { status: result.ok ? 200 : 400 },
      );
    }

    if (body.action === "get_combined" || body.action === "combined") {
      const result = getConcallCombinedText(Number(body.id));
      return NextResponse.json(result, {
        status: result.ok ? 200 : 404,
      });
    }

    if (
      body.action === "quant" ||
      body.action === "quant_executive" ||
      body.action === "quant_highlights" ||
      body.action === "quant_both"
    ) {
      const kind =
        body.action === "quant_executive"
          ? "executive"
          : body.action === "quant_highlights"
            ? "highlights"
            : body.action === "quant_both"
              ? "both"
              : body.kind === "executive" ||
                  body.kind === "highlights" ||
                  body.kind === "both"
                ? body.kind
                : "both";
      const result = await runConcallQuantForRow({
        id: Number(body.id),
        kind,
        compareGold: body.compare !== false,
      });
      return NextResponse.json(result, {
        status: result.ok ? 200 : 422,
      });
    }

    if (
      body.action === "from_combined" ||
      body.action === "run_combined" ||
      body.action === "from_text"
    ) {
      const result = await screenConcallFromCombinedText({
        id: body.id ?? null,
        combinedText: body.combined_text || body.combinedText || null,
        sourceUrl: body.source_url ?? null,
      });
      const history = listConcallHistory(body.limit ?? 40);
      return NextResponse.json(
        { ...result, history },
        { status: result.ok ? 200 : 422 },
      );
    }

    if (body.action === "extract_text" || body.action === "text") {
      const textResult = await extractConcallMaterialsText({
        transcriptUrl: body.url_transcript?.trim() || body.url?.trim() || null,
        pptUrl: body.url_ppt?.trim() || null,
      });
      return NextResponse.json(
        {
          ok: textResult.ok,
          mode: "extract_text",
          materials: textResult.materials,
          combined_text: textResult.combined_text,
          text_chars: textResult.text_chars,
          error: textResult.error,
        },
        { status: textResult.ok ? 200 : 422 },
      );
    }

    if (body.action === "refresh") {
      const result = await refreshConcallHistoryRows({
        limit: body.limit ?? 40,
        prices: true,
        reparsePdf: body.reparsePdf !== false,
      });
      return NextResponse.json(result);
    }

    if (body.action === "notes") {
      const result = await generateConcallNotesForRow({
        id: body.id ?? null,
        extract: body.extract ?? null,
        source_url: body.source_url ?? null,
        transcriptText: body.transcriptText ?? null,
      });
      return NextResponse.json(result, {
        status: result.ok ? 200 : 422,
      });
    }

    const url = body.url?.trim() || null;
    const urlTranscript = body.url_transcript?.trim() || url;
    const urlPpt = body.url_ppt?.trim() || null;
    if (!urlTranscript && !urlPpt) {
      return NextResponse.json(
        { ok: false, error: "Paste a Transcript and/or PPT PDF URL" },
        { status: 400 },
      );
    }
    const result =
      urlTranscript && urlPpt
        ? await screenConcallMaterials({
            transcriptUrl: urlTranscript,
            pptUrl: urlPpt,
          })
        : await screenConcallPdf({ url: urlTranscript || urlPpt });
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
