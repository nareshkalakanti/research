/**
 * Screenshot / image attachments for research notes.
 * Files live under data/note_attachments/{ticker}/ — OCR text stored for AI.
 */
import Database from "better-sqlite3";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "notes.db");
const ATTACH_DIR = path.join(DATA_DIR, "note_attachments");

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_PER_TICKER = 20;
const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export type NoteAttachment = {
  id: number;
  ticker: string;
  filename: string;
  mime: string;
  size: number;
  ocr_text: string | null;
  created_at: string;
  /** Public URL path to fetch the image bytes. */
  url: string;
};

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      ticker TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS note_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      ocr_text TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_note_attach_ticker
      ON note_attachments(ticker);
  `);
}

function openWritable(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  ensureSchema(db);
  return db;
}

function openReadonly(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

function tickerDir(ticker: string): string {
  return path.join(ATTACH_DIR, ticker.toUpperCase());
}

function filePath(ticker: string, filename: string): string {
  return path.join(tickerDir(ticker), filename);
}

function mapRow(r: Record<string, unknown>): NoteAttachment {
  const id = Number(r.id);
  const ticker = String(r.ticker).toUpperCase();
  return {
    id,
    ticker,
    filename: String(r.filename),
    mime: String(r.mime),
    size: Number(r.size),
    ocr_text: r.ocr_text != null ? String(r.ocr_text) : null,
    created_at: String(r.created_at),
    url: `/api/notes/attachments/${id}`,
  };
}

function extForMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "jpg";
}

/** Best-effort OCR via system tesseract (brew install tesseract). */
async function ocrImage(absPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "tesseract",
      [absPath, "stdout", "-l", "eng", "--psm", "6"],
      { timeout: 45_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const text = String(stdout || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

export function listAttachments(ticker: string): NoteAttachment[] {
  const t = ticker.trim().toUpperCase();
  if (!t) return [];
  const db = openReadonly();
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT id, ticker, filename, mime, size, ocr_text, created_at
         FROM note_attachments
         WHERE UPPER(ticker) = ?
         ORDER BY id ASC`,
      )
      .all(t) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function getAttachment(id: number): NoteAttachment | null {
  const db = openReadonly();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT id, ticker, filename, mime, size, ocr_text, created_at
         FROM note_attachments WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  } finally {
    db.close();
  }
}

export function readAttachmentBytes(
  id: number,
): { bytes: Buffer; mime: string; filename: string } | null {
  const meta = getAttachment(id);
  if (!meta) return null;
  const abs = filePath(meta.ticker, meta.filename);
  if (!fs.existsSync(abs)) return null;
  return {
    bytes: fs.readFileSync(abs),
    mime: meta.mime,
    filename: meta.filename,
  };
}

export function attachmentCount(ticker: string): number {
  return listAttachments(ticker).length;
}

export function tickersWithAttachments(): Set<string> {
  const db = openReadonly();
  if (!db) return new Set();
  try {
    const rows = db
      .prepare(`SELECT DISTINCT UPPER(ticker) AS ticker FROM note_attachments`)
      .all() as Array<{ ticker: string }>;
    return new Set(rows.map((r) => r.ticker));
  } catch {
    return new Set();
  } finally {
    db.close();
  }
}

/**
 * Combined note body + OCR from screenshots — for AI / search.
 */
export function noteAiContext(ticker: string): {
  body: string;
  ocr_blocks: Array<{ id: number; text: string }>;
  combined: string;
} {
  const t = ticker.trim().toUpperCase();
  const db = openReadonly();
  let body = "";
  if (db) {
    try {
      const row = db
        .prepare(`SELECT body FROM notes WHERE UPPER(ticker) = ?`)
        .get(t) as { body?: string } | undefined;
      body = row?.body?.trim() || "";
    } finally {
      db.close();
    }
  }
  const atts = listAttachments(t);
  const ocr_blocks = atts
    .filter((a) => a.ocr_text?.trim())
    .map((a) => ({ id: a.id, text: a.ocr_text!.trim() }));
  const parts = [body];
  for (const b of ocr_blocks) {
    parts.push(`\n--- Screenshot #${b.id} (OCR) ---\n${b.text}`);
  }
  return {
    body,
    ocr_blocks,
    combined: parts.filter(Boolean).join("\n").trim(),
  };
}

export async function addAttachment(opts: {
  ticker: string;
  buffer: Buffer;
  mime: string;
  originalName?: string;
}): Promise<NoteAttachment> {
  const t = opts.ticker.trim().toUpperCase();
  if (!t) throw new Error("ticker required");
  const mime = (opts.mime || "").toLowerCase().split(";")[0]!.trim();
  if (!ALLOWED.has(mime)) {
    throw new Error("Only PNG, JPEG, WebP, or GIF screenshots allowed");
  }
  if (!opts.buffer?.length) throw new Error("Empty file");
  if (opts.buffer.length > MAX_BYTES) {
    throw new Error("Screenshot too large (max 8 MB)");
  }

  const existing = listAttachments(t);
  if (existing.length >= MAX_PER_TICKER) {
    throw new Error(`Max ${MAX_PER_TICKER} screenshots per ticker`);
  }

  fs.mkdirSync(tickerDir(t), { recursive: true });
  const ext = extForMime(mime);
  const stamp = Date.now().toString(36);
  const filename = `${stamp}_${existing.length + 1}.${ext}`;
  const abs = filePath(t, filename);
  fs.writeFileSync(abs, opts.buffer);

  const ocr = await ocrImage(abs);
  const created_at = new Date().toISOString();
  const db = openWritable();
  try {
    const r = db
      .prepare(
        `INSERT INTO note_attachments
         (ticker, filename, mime, size, ocr_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(t, filename, mime, opts.buffer.length, ocr, created_at);

    // Touch notes row so has_note stays true when only screenshots exist.
    const note = db
      .prepare(`SELECT body FROM notes WHERE UPPER(ticker) = ?`)
      .get(t) as { body?: string } | undefined;
    if (!note) {
      db.prepare(
        `INSERT INTO notes (ticker, body, updated_at) VALUES (?, '', ?)`,
      ).run(t, created_at);
    } else {
      db.prepare(
        `UPDATE notes SET updated_at = ? WHERE UPPER(ticker) = ?`,
      ).run(created_at, t);
    }

    return mapRow({
      id: Number(r.lastInsertRowid),
      ticker: t,
      filename,
      mime,
      size: opts.buffer.length,
      ocr_text: ocr,
      created_at,
    });
  } finally {
    db.close();
  }
}

export function deleteAttachment(id: number): boolean {
  const meta = getAttachment(id);
  if (!meta) return false;
  const abs = filePath(meta.ticker, meta.filename);
  try {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    /* ignore */
  }
  const db = openWritable();
  try {
    db.prepare(`DELETE FROM note_attachments WHERE id = ?`).run(id);
    return true;
  } finally {
    db.close();
  }
}

export function deleteAttachmentsForTicker(ticker: string): number {
  const t = ticker.trim().toUpperCase();
  const atts = listAttachments(t);
  for (const a of atts) {
    const abs = filePath(a.ticker, a.filename);
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      /* ignore */
    }
  }
  const dir = tickerDir(t);
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    /* ignore */
  }
  const db = openWritable();
  try {
    const info = db
      .prepare(`DELETE FROM note_attachments WHERE UPPER(ticker) = ?`)
      .run(t);
    return info.changes;
  } finally {
    db.close();
  }
}
