/**
 * Concall Research screen — define extract targets, then (later) screen transcripts.
 * Fields live in data/concall-research-fields.json; history in concall_screen.db.
 */
import fs from "fs";
import path from "path";
import { downloadBuybackPdf } from "./buyback-screen";
import { openSqliteNamed } from "./sqlite-utils";

export type ConcallFieldGroup = "meta" | "content" | "sentiment" | "custom";

export type ConcallResearchField = {
  id: string;
  label: string;
  group: ConcallFieldGroup | string;
  required: boolean;
  notes: string;
  enabled: boolean;
};

export type ConcallResearchFieldsFile = {
  version: number;
  purpose: string;
  updated_at: string;
  pass_rule: string;
  fields: ConcallResearchField[];
};

export type ConcallHistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  period: string | null;
  sentiment: string | null;
  screened_at: string;
};

const FIELDS_PATH = path.join(
  process.cwd(),
  "data",
  "concall-research-fields.json",
);

let fieldsCache: ConcallResearchFieldsFile | null = null;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugifyFieldId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export function loadConcallResearchFields(opts?: {
  force?: boolean;
}): ConcallResearchFieldsFile {
  if (!opts?.force && fieldsCache) return fieldsCache;
  const raw = fs.readFileSync(FIELDS_PATH, "utf8");
  fieldsCache = JSON.parse(raw) as ConcallResearchFieldsFile;
  return fieldsCache;
}

function persistFields(file: ConcallResearchFieldsFile): void {
  file.updated_at = todayIso();
  fs.writeFileSync(FIELDS_PATH, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  fieldsCache = file;
}

export function addConcallResearchField(input: {
  id?: string;
  label: string;
  group?: string;
  required?: boolean;
  notes?: string;
  enabled?: boolean;
}): ConcallResearchField {
  const label = input.label.trim();
  if (!label) throw new Error("label is required");
  const id = slugifyFieldId(input.id || label);
  if (!id) throw new Error("id is empty");

  const file = loadConcallResearchFields({ force: true });
  if (file.fields.some((f) => f.id === id)) {
    throw new Error(`Field already exists: ${id}`);
  }

  const field: ConcallResearchField = {
    id,
    label,
    group: input.group?.trim() || "custom",
    required: Boolean(input.required),
    notes: (input.notes || "").trim(),
    enabled: input.enabled !== false,
  };
  file.fields.push(field);
  persistFields(file);
  return field;
}

export function setConcallResearchFieldEnabled(
  id: string,
  enabled: boolean,
): ConcallResearchField {
  const file = loadConcallResearchFields({ force: true });
  const field = file.fields.find((f) => f.id === id);
  if (!field) throw new Error(`Unknown field: ${id}`);
  field.enabled = enabled;
  persistFields(file);
  return field;
}

function openDb() {
  const db = openSqliteNamed("concall_screen.db", { wal: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS concall_screens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url TEXT,
      ticker TEXT,
      company TEXT,
      period TEXT,
      sentiment TEXT,
      extract_json TEXT NOT NULL,
      screened_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_concall_screened
      ON concall_screens(screened_at DESC);
  `);
  return db;
}

/** Pass list — empty until extract + pass rule land. */
export function listConcallHistory(limit = 40): ConcallHistoryRow[] {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT id, source_url, ticker, company, period, sentiment, screened_at
       FROM concall_screens
       ORDER BY screened_at DESC, id DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, limit))) as Array<{
    id: number;
    source_url: string | null;
    ticker: string | null;
    company: string | null;
    period: string | null;
    sentiment: string | null;
    screened_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    source_url: r.source_url,
    ticker: r.ticker,
    company: r.company,
    period: r.period,
    sentiment: r.sentiment,
    screened_at: r.screened_at,
  }));
}

export async function downloadConcallPdf(url: string): Promise<Buffer | null> {
  return downloadBuybackPdf(url);
}

/** BSE/NSE + common IR / CDN hosts for transcript PDFs. */
export function isConcallPdfProxyUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return (
      h === "www.bseindia.com" ||
      h === "bseindia.com" ||
      h.endsWith(".bseindia.com") ||
      h === "www.nseindia.com" ||
      h === "nseindia.com" ||
      h.endsWith(".nseindia.com") ||
      h === "archives.nseindia.com" ||
      h.endsWith(".s3.amazonaws.com") ||
      h.endsWith(".cloudfront.net") ||
      h.endsWith(".blob.core.windows.net") ||
      h.includes("trendlyne") ||
      h.includes("screener.in") ||
      h.includes("moneycontrol")
    );
  } catch {
    return false;
  }
}

async function extractPdfText(buf: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    b: Buffer,
  ) => Promise<{ text?: string }>;
  const parsed = await pdfParse(buf);
  return (parsed.text || "").trim();
}

export type ConcallReadResult = {
  ok: boolean;
  engine: string;
  text_chars: number;
  text_excerpt: string;
  source_url: string | null;
  enabled_fields: string[];
  error?: string;
};

const EXCERPT_MAX = 12_000;

/**
 * Read transcript / presentation PDF text so we can iterate on extract fields.
 * Field-level LLM extract comes next.
 */
export async function readConcallPdf(opts: {
  url?: string | null;
  pdfBuffer?: Buffer | null;
}): Promise<ConcallReadResult> {
  const source_url = opts.url?.trim() || null;
  let buf = opts.pdfBuffer || null;
  if (!buf && source_url) {
    buf = await downloadConcallPdf(source_url);
  }
  if (!buf) {
    return {
      ok: false,
      engine: "none",
      text_chars: 0,
      text_excerpt: "",
      source_url,
      enabled_fields: loadConcallResearchFields()
        .fields.filter((f) => f.enabled)
        .map((f) => f.id),
      error: "Paste a PDF URL or upload a file",
    };
  }

  let text = "";
  let engine = "pdf-parse";
  try {
    text = await extractPdfText(buf);
  } catch (e) {
    return {
      ok: false,
      engine,
      text_chars: 0,
      text_excerpt: "",
      source_url,
      enabled_fields: loadConcallResearchFields()
        .fields.filter((f) => f.enabled)
        .map((f) => f.id),
      error: e instanceof Error ? e.message : "pdf-parse failed",
    };
  }

  const enabled_fields = loadConcallResearchFields()
    .fields.filter((f) => f.enabled)
    .map((f) => f.id);

  return {
    ok: text.length > 0,
    engine,
    text_chars: text.length,
    text_excerpt: text.slice(0, EXCERPT_MAX),
    source_url,
    enabled_fields,
    error: text.length ? undefined : "No text in PDF (may need OCR later)",
  };
}
