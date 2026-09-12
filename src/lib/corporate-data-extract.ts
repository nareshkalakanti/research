/**
 * Extract corporate / board fields from announcement PDF / ZIP (NSE KMP packs).
 * Vision: Ollama VL / Qianfan via OpenAI-compatible API.
 * Fallback: Firecrawl OCR. Text: pdf-parse + Ollama JSON (+ regex DIN fallback).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkLlmStatus, completeJson } from "./llm-client";
import { loadLlmConfig } from "./llm-config";
import {
  emptyExtract,
  type CorporateExtractPayload,
} from "./corporate-data";
import { rasterizePdfPages } from "./pdf-rasterize";

const execFileAsync = promisify(execFile);

const EXTRACT_SYSTEM = `You extract Indian listed-company board / KMP data from exchange filing text.
Return ONLY JSON matching this shape:
{
  "directors": [{"name":"","din":"8 digits or null","designation":null,"category":"Executive|Independent|Non-Executive|null","as_of":"YYYY-MM-DD|null","tenure_end":null,"committees":[]|null,"age":null,"dob":null,"shareholding_pct":null,"promoter":null,"related_party":null,"qualification":null}],
  "kmp": [{"name":"","din":null,"role":"CFO|CS|CEO|MD|other"}],
  "company": {"cin":null,"isin":null},
  "extras": {"earnings_snip":null,"order_wins":null,"credit_rating":null,"buyback":null,"clarification":null},
  "notes": null
}
Rules:
- DIN must be exactly 8 digits when present in the text; else null. Never invent DINs.
- Appointment / resignation / change-in-director letters usually name ONE person — still return them in directors (or kmp if CFO/CS).
- Prefer appointment / board composition facts. Leave unknown fields null.
- No markdown.`;

const OCR_PROMPT =
  "Transcribe all text from this Indian stock-exchange filing page. Preserve names, DIN numbers (8 digits), designations, dates, CIN/ISIN exactly. Output plain text only.";

function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function isPdfBuffer(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 5).toString("utf8") === "%PDF-";
}

/** If attachment is a ZIP (NSE KMP packs), return the largest PDF inside. */
async function resolveToPdfBuffer(buf: Buffer): Promise<Buffer> {
  if (isPdfBuffer(buf)) return buf;
  if (!isZipBuffer(buf)) return buf;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corp-zip-"));
  const zipPath = path.join(dir, "in.zip");
  try {
    fs.writeFileSync(zipPath, buf);
    await execFileAsync("unzip", ["-o", "-q", zipPath, "-d", dir], {
      timeout: 30_000,
    });
    const pdfs: Array<{ file: string; size: number }> = [];
    const walk = (d: string) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.pdf$/i.test(name)) pdfs.push({ file: p, size: st.size });
      }
    };
    walk(dir);
    pdfs.sort((a, b) => b.size - a.size);
    if (!pdfs.length) {
      throw new Error("ZIP has no PDF inside (NSE KMP pack)");
    }
    return fs.readFileSync(pdfs[0]!.file);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function extractPdfText(buf: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    b: Buffer,
  ) => Promise<{ text?: string }>;
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    const s = typeof chunk === "string" ? chunk : String(chunk);
    if (/private use area|undefined function:/i.test(s)) {
      return true;
    }
    return errWrite(chunk as never, ...(args as never[]));
  }) as typeof process.stderr.write;
  try {
    const parsed = await pdfParse(buf);
    return (parsed.text || "").replace(/\s+/g, " ").trim();
  } finally {
    process.stderr.write = errWrite;
  }
}

async function downloadAttachment(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/pdf,application/zip,*/*",
      },
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function qianfanConfig(): { base: string; model: string } | null {
  const base = (process.env.QIANFAN_OCR_BASE_URL || "").trim().replace(/\/$/, "");
  if (!base) return null;
  const model =
    (process.env.LLM_MODEL_OCR ||
      process.env.QIANFAN_OCR_MODEL ||
      "baidu/Qianfan-OCR").trim() ||
    "baidu/Qianfan-OCR";
  return { base, model };
}

export async function ocrImageWithQianfan(
  imageDataUrl: string,
  prompt: string = OCR_PROMPT,
): Promise<string> {
  const cfg = qianfanConfig();
  if (!cfg) {
    throw new Error(
      "Set QIANFAN_OCR_BASE_URL (Ollama vision or vLLM OpenAI-compatible)",
    );
  }
  const { shrinkImageDataUrlForOcr } = await import("./pdf-rasterize");
  const image = await shrinkImageDataUrlForOcr(imageDataUrl, 1280);
  // Keep prompt short — image tokens dominate context
  const shortPrompt =
    prompt.length > 280 ? `${prompt.slice(0, 280)}…` : prompt;
  const numCtx = Math.max(
    8192,
    Number(process.env.OLLAMA_OCR_NUM_CTX || 16384) || 16384,
  );
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: shortPrompt },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
      // Completion budget — do not set near full context (Ollama counts both)
      max_tokens: 1536,
      temperature: 0,
      // Ollama OpenAI-compat: raise context above default 4096
      options: { num_ctx: numCtx },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Vision OCR ${res.status}: ${t.slice(0, 280)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content?.trim() || "";
  if (!text) throw new Error("Empty vision OCR response");
  return text;
}

async function ocrPdfWithVision(pdf: Buffer): Promise<string> {
  const pages = await rasterizePdfPages(pdf, { maxPages: 4, dpi: 144 });
  const chunks: string[] = [];
  for (const page of pages) {
    const t = await ocrImageWithQianfan(page.dataUrl);
    if (t.trim()) chunks.push(`--- page ${page.page} ---\n${t.trim()}`);
  }
  return chunks.join("\n\n").trim();
}

async function ocrWithFirecrawlBuffer(pdf: Buffer): Promise<string | null> {
  try {
    const fc = await import("./firecrawl-parse");
    if (!fc.firecrawlConfigured()) return null;
    const parsed = await fc.parseDocumentBuffer(pdf, "filing.pdf", {
      maxPages: 8,
      mode: "ocr",
      timeoutMs: 180_000,
    });
    const md = parsed.markdown?.trim() || "";
    return md.length >= 40 ? md : null;
  } catch {
    return null;
  }
}

async function ocrWithFirecrawlUrl(sourceUrl: string): Promise<string | null> {
  try {
    const fc = await import("./firecrawl-parse");
    if (!fc.firecrawlConfigured()) return null;
    const parsed = await fc.parseDocumentUrl(sourceUrl, {
      maxPages: 8,
      mode: "ocr",
      timeoutMs: 180_000,
    });
    const md = parsed.markdown?.trim() || "";
    return md.length >= 40 ? md : null;
  } catch {
    return null;
  }
}

function regexDirectorsFromText(
  text: string,
): CorporateExtractPayload["directors"] {
  const out: CorporateExtractPayload["directors"] = [];
  const seen = new Set<string>();
  // Name (DIN 12345678) — ignore UDIN (chartered accountant ids)
  const reParen =
    /(?:(?:Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Shri)\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.]+){0,4})\s*\(\s*DIN\s*[:.]?\s*(\d{8})\s*\)/g;
  // DIN: 12345678 / DIN No. 12345678 near a capitalized name (not UDIN)
  const reDinLine =
    /(?<!U)DIN\s*(?:No\.?|Number|#)?\s*[:.\-]?\s*(\d{8})\b/gi;

  let m: RegExpExecArray | null;
  while ((m = reParen.exec(text)) !== null) {
    const name = m[1]!.replace(/\s+/g, " ").trim();
    const din = m[2]!;
    if (seen.has(din)) continue;
    seen.add(din);
    const window = text
      .slice(Math.max(0, m.index - 80), m.index + 120)
      .toLowerCase();
    let category: string | null = null;
    if (/independent/.test(window)) category = "Independent";
    else if (/managing|whole.?time|executive/.test(window))
      category = "Executive";
    else if (/non.?executive/.test(window)) category = "Non-Executive";
    out.push({
      name,
      din,
      designation: null,
      category,
      as_of: null,
      tenure_end: null,
      committees: null,
      age: null,
      dob: null,
      shareholding_pct: null,
      promoter: null,
      related_party: null,
      qualification: null,
    });
  }

  while ((m = reDinLine.exec(text)) !== null) {
    const din = m[1]!;
    if (seen.has(din)) continue;
    // Skip if this is part of UDIN (U before DIN already guarded; also check nearby)
    const around = text.slice(Math.max(0, m.index - 3), m.index + 20);
    if (/UDIN/i.test(around)) continue;
    seen.add(din);
    const before = text.slice(Math.max(0, m.index - 120), m.index);
    const nameHit = before.match(
      /(?:(?:Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Shri)\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.]+){1,4})\s*$/,
    );
    const name = nameHit?.[1]?.replace(/\s+/g, " ").trim() || `DIN ${din}`;
    out.push({
      name,
      din,
      designation: null,
      category: null,
      as_of: null,
      tenure_end: null,
      committees: null,
      age: null,
      dob: null,
      shareholding_pct: null,
      promoter: null,
      related_party: null,
      qualification: null,
    });
  }
  return out;
}

function normalizeExtract(
  raw: Record<string, unknown>,
  sourceUrl: string,
): CorporateExtractPayload {
  const base = emptyExtract(sourceUrl);
  const directorsIn = Array.isArray(raw.directors) ? raw.directors : [];
  base.directors = directorsIn
    .map((d) => {
      const row = (d && typeof d === "object" ? d : {}) as Record<
        string,
        unknown
      >;
      const dinRaw = row.din == null ? "" : String(row.din).replace(/\D/g, "");
      const din = dinRaw.length === 8 ? dinRaw : null;
      return {
        name: String(row.name || "").trim(),
        din,
        designation: row.designation != null ? String(row.designation) : null,
        category: row.category != null ? String(row.category) : null,
        as_of: row.as_of != null ? String(row.as_of).slice(0, 10) : null,
        tenure_end: row.tenure_end != null ? String(row.tenure_end) : null,
        committees: Array.isArray(row.committees)
          ? row.committees
              .map((c) =>
                typeof c === "string"
                  ? c
                  : c && typeof c === "object" && "name" in (c as object)
                    ? String((c as { name?: unknown }).name || "")
                    : "",
              )
              .map((c) => c.trim())
              .filter(Boolean)
          : null,
        age:
          typeof row.age === "number" && Number.isFinite(row.age)
            ? row.age
            : null,
        dob: row.dob != null ? String(row.dob) : null,
        shareholding_pct:
          typeof row.shareholding_pct === "number"
            ? row.shareholding_pct
            : null,
        promoter: typeof row.promoter === "boolean" ? row.promoter : null,
        related_party:
          typeof row.related_party === "boolean" ? row.related_party : null,
        qualification:
          row.qualification != null ? String(row.qualification) : null,
      };
    })
    .filter((d) => d.name);

  const kmpIn = Array.isArray(raw.kmp) ? raw.kmp : [];
  base.kmp = kmpIn
    .map((k) => {
      const row = (k && typeof k === "object" ? k : {}) as Record<
        string,
        unknown
      >;
      const dinRaw = row.din == null ? "" : String(row.din).replace(/\D/g, "");
      return {
        name: String(row.name || "").trim(),
        din: dinRaw.length === 8 ? dinRaw : null,
        role: row.role != null ? String(row.role) : null,
      };
    })
    .filter((k) => k.name);

  const company =
    raw.company && typeof raw.company === "object"
      ? (raw.company as Record<string, unknown>)
      : {};
  base.company = {
    cin: company.cin != null ? String(company.cin) : null,
    isin: company.isin != null ? String(company.isin) : null,
  };

  const extras =
    raw.extras && typeof raw.extras === "object"
      ? (raw.extras as Record<string, unknown>)
      : {};
  base.extras = {
    earnings_snip:
      extras.earnings_snip != null ? String(extras.earnings_snip) : null,
    order_wins: extras.order_wins != null ? String(extras.order_wins) : null,
    credit_rating:
      extras.credit_rating != null ? String(extras.credit_rating) : null,
    buyback: extras.buyback != null ? String(extras.buyback) : null,
    clarification:
      extras.clarification != null ? String(extras.clarification) : null,
  };
  base.notes = raw.notes != null ? String(raw.notes) : null;
  base.source_url = sourceUrl;
  return base;
}

export type CorporateExtractResult = {
  ok: boolean;
  engine: string;
  status: string;
  extracted: CorporateExtractPayload;
  text_chars: number;
  error?: string;
};

async function structuredExtract(
  text: string,
  sourceUrl: string,
  engine: string,
): Promise<CorporateExtractResult> {
  // Fast path: Name (DIN 12345678) in text — skip Ollama (~5–30s)
  const regexHit = regexDirectorsFromText(text);
  if (regexHit.length > 0) {
    const extracted = emptyExtract(sourceUrl);
    extracted.directors = regexHit;
    const cin = text.match(/\b([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b/);
    if (cin) extracted.company.cin = cin[1]!;
    return {
      ok: true,
      engine: `${engine}+regex`,
      status: "ok",
      extracted,
      text_chars: text.length,
    };
  }

  const excerpt = text.slice(0, 12_000);
  const cfg = loadLlmConfig();
  const status = await checkLlmStatus(cfg);

  if (!status.available) {
    return {
      ok: false,
      engine,
      status: "llm_offline",
      extracted: emptyExtract(sourceUrl),
      text_chars: text.length,
      error: status.detail || "LLM offline — start Ollama for JSON extract",
    };
  }

  try {
    const parsed = await completeJson(
      cfg,
      EXTRACT_SYSTEM,
      `Filing text:\n${excerpt}`,
      { skipStatusCheck: true, temperature: 0, maxTokens: 2000 },
    );
    const extracted = normalizeExtract(parsed, sourceUrl);
    return {
      ok: extracted.directors.length > 0 || extracted.kmp.length > 0,
      engine,
      status:
        extracted.directors.length || extracted.kmp.length
          ? "ok"
          : "empty_extract",
      extracted,
      text_chars: text.length,
    };
  } catch (err) {
    return {
      ok: false,
      engine,
      status: "extract_failed",
      extracted: emptyExtract(sourceUrl),
      text_chars: text.length,
      error: err instanceof Error ? err.message : "Extract failed",
    };
  }
}

export async function extractCorporateFromPdfUrl(
  sourceUrl: string,
  opts?: { skipOcr?: boolean },
): Promise<CorporateExtractResult> {
  const skipOcr = opts?.skipOcr === true;
  const raw = await downloadAttachment(sourceUrl);
  if (!raw) {
    return {
      ok: false,
      engine: "none",
      status: "download_failed",
      extracted: emptyExtract(sourceUrl),
      text_chars: 0,
      error: "Could not download attachment",
    };
  }

  let buf: Buffer;
  try {
    buf = await resolveToPdfBuffer(raw);
  } catch (err) {
    return {
      ok: false,
      engine: "zip",
      status: "no_pdf_in_zip",
      extracted: emptyExtract(sourceUrl),
      text_chars: 0,
      error: err instanceof Error ? err.message : "ZIP has no PDF",
    };
  }

  if (!isPdfBuffer(buf)) {
    return {
      ok: false,
      engine: "none",
      status: "not_pdf",
      extracted: emptyExtract(sourceUrl),
      text_chars: 0,
      error: "Attachment is not a PDF (and not a ZIP with PDF)",
    };
  }

  const fromZip = isZipBuffer(raw);
  let text = "";
  try {
    text = await extractPdfText(buf);
  } catch {
    text = "";
  }

  let engine = fromZip ? "zip+pdf-parse+llm" : "pdf-parse+llm";

  if (text.length < 80 && !skipOcr) {
    const q = qianfanConfig();
    let ocrErr: string | null = null;

    if (q) {
      try {
        const ocrText = await ocrPdfWithVision(buf);
        if (ocrText.length >= 40) {
          text = ocrText;
          engine = fromZip ? "zip+vision-ocr+llm" : "vision-ocr+llm";
        } else {
          ocrErr = "Vision OCR returned little text";
        }
      } catch (err) {
        ocrErr = err instanceof Error ? err.message : "Vision OCR failed";
      }
    }

    if (text.length < 80) {
      // Prefer local Qianfan / Ollama vision; Firecrawl only if vision unset
      // or CORPORATE_ALLOW_FIRECRAWL_OCR=1
      const allowFirecrawl =
        !q || process.env.CORPORATE_ALLOW_FIRECRAWL_OCR === "1";
      if (allowFirecrawl) {
        const fcBuf = await ocrWithFirecrawlBuffer(buf);
        if (fcBuf && fcBuf.length >= 40) {
          text = fcBuf;
          engine = fromZip ? "zip+firecrawl-ocr+llm" : "firecrawl-ocr+llm";
        }
      }
    }

    if (text.length < 80 && !fromZip) {
      const allowFirecrawl =
        !qianfanConfig() || process.env.CORPORATE_ALLOW_FIRECRAWL_OCR === "1";
      if (allowFirecrawl) {
        const fcUrl = await ocrWithFirecrawlUrl(sourceUrl);
        if (fcUrl && fcUrl.length >= 40) {
          text = fcUrl;
          engine = "firecrawl-ocr+llm";
        }
      }
    }

    if (text.length < 80) {
      const hints: string[] = [];
      if (q && ocrErr) {
        if (/fetch failed|ECONNREFUSED|abort|timeout/i.test(ocrErr)) {
          hints.push(
            `Vision OCR not reachable at ${q.base} — ollama serve + pull ${q.model}`,
          );
        } else {
          hints.push(ocrErr);
        }
      } else if (!q) {
        hints.push("Set QIANFAN_OCR_BASE_URL for local vision OCR");
      }
      if (!q || process.env.CORPORATE_ALLOW_FIRECRAWL_OCR === "1") {
        hints.push("Or set FIRECRAWL_API_KEY (+ CORPORATE_ALLOW_FIRECRAWL_OCR=1)");
      } else {
        hints.push(
          "Firecrawl OCR skipped (Qianfan preferred). Set CORPORATE_ALLOW_FIRECRAWL_OCR=1 to enable fallback",
        );
      }
      return {
        ok: false,
        engine: q ? "vision-ocr" : "pdf-parse",
        status: "no_text",
        extracted: emptyExtract(sourceUrl),
        text_chars: text.length,
        error: hints.join(". "),
      };
    }
  }

  return structuredExtract(text, sourceUrl, engine);
}
