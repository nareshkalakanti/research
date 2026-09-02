/**
 * Firecrawl /parse (AnyDoc + Fire-PDF) — LLM-ready markdown from PDFs, DOCX, etc.
 * Set FIRECRAWL_API_KEY in .env.local to enable.
 */

const API_BASE = (process.env.FIRECRAWL_API_URL || "https://api.firecrawl.dev").replace(
  /\/$/,
  "",
);

export type FirecrawlParseResult = {
  markdown: string;
  numPages: number | null;
  source: "firecrawl_parse" | "firecrawl_scrape";
};

export function firecrawlConfigured(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY?.trim());
}

export function firecrawlApiKey(): string | null {
  return process.env.FIRECRAWL_API_KEY?.trim() || null;
}

const OFFICE_OR_DOC =
  /\.(pdf|docx?|docm|odt|rtf|xlsx?|xlsm|pptx?|pptm|epub|csv)(\?|$)/i;
const PDF_CT = /application\/pdf/i;
const OFFICE_CT =
  /wordprocessing|msword|spreadsheet|presentation|opendocument|rtf|epub|csv/i;

export function isFirecrawlDocumentUrl(url: string, contentType = ""): boolean {
  const u = url.toLowerCase();
  if (OFFICE_OR_DOC.test(u)) return true;
  if (PDF_CT.test(contentType) || OFFICE_CT.test(contentType)) return true;
  if (/AnnPdfOpen\.aspx/i.test(url)) return true;
  return false;
}

function filenameFromUrl(url: string, fallback = "document.pdf"): string {
  try {
    const path = new URL(url).pathname;
    const base = path.split("/").pop() || fallback;
    return base.includes(".") ? base : fallback;
  } catch {
    return fallback;
  }
}

function contentTypeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx"))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".xlsx"))
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".pptx"))
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return "application/octet-stream";
}

type ParseOptions = {
  maxPages?: number;
  mode?: "auto" | "fast" | "ocr";
  timeoutMs?: number;
};

function defaultParseOptions(opts?: ParseOptions): Record<string, unknown> {
  const envPages = Number(process.env.FIRECRAWL_MAX_PAGES);
  const maxPages = opts?.maxPages ?? (Number.isFinite(envPages) ? envPages : 80);
  const envMode = process.env.FIRECRAWL_PDF_MODE as ParseOptions["mode"] | undefined;
  const mode = opts?.mode ?? envMode ?? "auto";
  return {
    formats: ["markdown"],
    onlyMainContent: true,
    timeout: Math.min(300_000, opts?.timeoutMs ?? 120_000),
    parsers: [
      {
        type: "pdf",
        mode,
        maxPages: Number.isFinite(maxPages) ? maxPages : 80,
        pageMarkers: true,
      },
    ],
  };
}

function extractMarkdown(payload: unknown): { markdown: string; numPages: number | null } {
  const root = payload as {
    success?: boolean;
    data?: {
      markdown?: string;
      metadata?: { numPages?: number; totalPages?: number };
    };
    markdown?: string;
    metadata?: { numPages?: number; totalPages?: number };
    error?: string;
  };

  if (root.success === false) {
    throw new Error(root.error || "Firecrawl parse failed");
  }

  const data = root.data ?? root;
  const markdown = String(data.markdown || "").trim();
  const meta = "metadata" in data ? data.metadata : root.metadata;
  const numPages = meta?.numPages ?? meta?.totalPages ?? null;
  if (!markdown) throw new Error("Firecrawl returned empty markdown");
  return { markdown, numPages: numPages != null ? Number(numPages) : null };
}

/** Upload bytes to Firecrawl /v2/parse (AnyDoc engine). */
export async function parseDocumentBuffer(
  buffer: Buffer,
  filename: string,
  opts?: ParseOptions & { contentType?: string },
): Promise<FirecrawlParseResult> {
  const apiKey = firecrawlApiKey();
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY not set");

  const contentType = opts?.contentType || contentTypeForFilename(filename);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: contentType }),
    filename,
  );
  form.append("options", JSON.stringify(defaultParseOptions(opts)));

  const res = await fetch(`${API_BASE}/v2/parse`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout((opts?.timeoutMs ?? 120_000) + 15_000),
  });

  const json = (await res.json()) as unknown;
  if (!res.ok) {
    const err =
      (json as { error?: string })?.error || `Firecrawl parse HTTP ${res.status}`;
    throw new Error(err);
  }

  const { markdown, numPages } = extractMarkdown(json);
  return {
    markdown: markdown.slice(0, 80_000),
    numPages,
    source: "firecrawl_parse",
  };
}

/** Parse a public document URL via Firecrawl /v2/scrape. */
export async function parseDocumentUrl(
  url: string,
  opts?: ParseOptions,
): Promise<FirecrawlParseResult> {
  const apiKey = firecrawlApiKey();
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY not set");

  const res = await fetch(`${API_BASE}/v2/scrape`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      ...defaultParseOptions(opts),
    }),
    signal: AbortSignal.timeout((opts?.timeoutMs ?? 120_000) + 15_000),
  });

  const json = (await res.json()) as unknown;
  if (!res.ok) {
    const err =
      (json as { error?: string })?.error || `Firecrawl scrape HTTP ${res.status}`;
    throw new Error(err);
  }

  const { markdown, numPages } = extractMarkdown(json);
  return {
    markdown: markdown.slice(0, 80_000),
    numPages,
    source: "firecrawl_scrape",
  };
}

/** Prefer scrape for bare URLs; fall back to download + /parse when scrape fails. */
export async function parseDocumentFromUrl(
  url: string,
  download: () => Promise<{ buffer: Buffer; contentType: string }>,
  opts?: ParseOptions,
): Promise<FirecrawlParseResult> {
  if (!isFirecrawlDocumentUrl(url)) {
    throw new Error("Not a Firecrawl-supported document URL");
  }

  try {
    return await parseDocumentUrl(url, opts);
  } catch {
    const { buffer, contentType } = await download();
    const filename = filenameFromUrl(url);
    return parseDocumentBuffer(buffer, filename, {
      ...opts,
      contentType,
    });
  }
}
