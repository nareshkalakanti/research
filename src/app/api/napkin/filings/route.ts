import { NextRequest } from "next/server";
import { napkinLog } from "@/lib/napkin/log";
import { listNapkinFilings, pickConcallTranscripts, qwenFilingPack } from "@/lib/napkin/filings";
import { extractPdf } from "@/lib/napkin/pdf";
import { runNapkinConcallTrack } from "@/lib/napkin/concall-track";
import { runNapkinQwen } from "@/lib/napkin/qwen-run";
import type { NapkinStepEvent } from "@/lib/napkin/progress";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "").trim();
  if (!ticker) {
    return new Response(JSON.stringify({ ok: false, error: "Enter an NSE ticker" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };
      const t0 = Date.now();
      napkinLog("filings stream start", { ticker });
      try {
        const rows = await listNapkinFilings(
          ticker,
          (step: NapkinStepEvent) => {
            napkinLog("filings step", step);
            send({ type: "step", step });
          },
          (next) => {
            send({
              type: "filings",
              filings: next,
              debug: { filings_ms: Date.now() - t0, count: next.length },
            });
          },
        );
        const pack = qwenFilingPack(rows);
        send({
          type: "step",
          step: {
            id: "pdf",
            status: "running",
            label: "PDF extract",
            detail: pack.length
              ? `Pack ${pack.map((p) => p.document_type).join(", ")}`
              : "Nothing to extract",
          },
        });
        let okN = 0;
        const tPdf = Date.now();
        for (let i = 0; i < pack.length; i++) {
          const row = pack[i]!;
          send({
            type: "step",
            step: {
              id: "pdf",
              status: "running",
              label: "PDF extract",
              detail: `${i + 1}/${pack.length} ${row.document_type}`,
            },
          });
          try {
            const doc = await extractPdf(row.url, { timeoutMs: 25_000 });
            okN += 1;
            send({
              type: "extract",
              url: row.url,
              title: row.document_title || doc.title,
              kind: row.document_type,
              preview: doc.pages.slice(0, 2).map((p) => ({
                page_number: p.page_number,
                text: p.text.slice(0, 1800),
              })),
              pages: doc.pages.length,
              error: null,
            });
          } catch (e) {
            send({
              type: "extract",
              url: row.url,
              title: row.document_title,
              kind: row.document_type,
              preview: [],
              pages: 0,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        send({
          type: "step",
          step: {
            id: "pdf",
            status: pack.length ? (okN ? "done" : "fail") : "skip",
            label: "PDF extract",
            detail: pack.length ? `${okN}/${pack.length} extracted` : "No PDF picked",
            ms: Date.now() - tPdf,
          },
        });
        send({
          type: "step",
          step: {
            id: "qwen",
            status: "running",
            label: "Qwen research",
            detail: "Local Ollama",
          },
        });
        const tQ = Date.now();
        const qwen = await runNapkinQwen(ticker, pack);
        send({
          type: "qwen",
          model: qwen.model,
          sections: qwen.sections,
          error: qwen.error,
        });
        send({
          type: "step",
          step: {
            id: "qwen",
            status: qwen.error ? "fail" : "done",
            label: "Qwen research",
            detail: qwen.error || qwen.model || "ok",
            ms: Date.now() - tQ,
          },
        });
        send({
          type: "step",
          step: {
            id: "concall",
            status: "running",
            label: "Concall track record",
            detail: "Last 8 transcripts",
          },
        });
        const tC = Date.now();
        const calls = pickConcallTranscripts(rows, 8);
        const resultDocs = rows
          .filter((r) => r.document_type === "RESULT")
          .slice(0, 4);
        let extractedCalls = 0;
        for (let i = 0; i < calls.length; i++) {
          const row = calls[i]!;
          send({
            type: "step",
            step: {
              id: "concall",
              status: "running",
              label: "Concall track record",
              detail: `Transcript ${i + 1}/${calls.length}`,
            },
          });
          try {
            await extractPdf(row.url, { timeoutMs: 20_000 });
            extractedCalls += 1;
          } catch {
            /* keep going */
          }
        }
        for (const row of resultDocs) {
          try {
            await extractPdf(row.url, { timeoutMs: 15_000 });
          } catch {
            /* optional result context */
          }
        }
        if (!calls.length) {
          send({
            type: "concall",
            track: {
              rows: [],
              themes: {},
              repeated_across_quarters: [],
              model: null,
              error: "No concall transcripts classified in this pack",
              transcripts: 0,
            },
          });
          send({
            type: "step",
            step: {
              id: "concall",
              status: "skip",
              label: "Concall track record",
              detail: "No transcripts",
              ms: Date.now() - tC,
            },
          });
        } else {
          const track = await runNapkinConcallTrack(calls, resultDocs);
          send({ type: "concall", track });
          send({
            type: "step",
            step: {
              id: "concall",
              status: track.error ? "fail" : "done",
              label: "Concall track record",
              detail: track.error || `${extractedCalls} transcripts`,
              ms: Date.now() - tC,
            },
          });
        }
        send({ type: "done" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        napkinLog("filings stream fail", { ticker, error: msg });
        send({ type: "error", error: msg });
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
