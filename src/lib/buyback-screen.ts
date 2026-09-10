/**
 * Buyback Research screen — paste BSE/NSE PDF → OCR/extract → tender vs open market
 * → offer vs CMP upside (>8%).
 */
import { ocrImageWithQianfan } from "./corporate-data-extract";
import { checkLlmStatus, completeJson } from "./llm-client";
import { loadLlmConfig } from "./llm-config";
import { rasterizePdfPages } from "./pdf-rasterize";
import { openSqliteNamed } from "./sqlite-utils";
import { fetchQuoteDetailed } from "./yfinance";

export const BUYBACK_UPSIDE_MIN = 0.08;

export type BuybackMethod = "tender" | "open_market" | "unknown";

export type BuybackDecision =
  | "pass_tender"
  | "skip_open_market"
  | "skip_low_upside"
  | "need_review";

export type BuybackExtract = {
  ticker: string | null;
  company: string | null;
  subject: string | null;
  method: BuybackMethod;
  method_evidence: string | null;
  offer_price: number | null;
  max_buyback_price: number | null;
  /** Max shares in buyback (e.g. 2068965). */
  issue_shares: number | null;
  /** Aggregate size in ₹ crore (e.g. 300). */
  issue_amount_cr: number | null;
  face_value: number | null;
  /** e.g. "BSE, NSE". */
  listing: string | null;
  record_date: string | null;
  tender_open: string | null;
  tender_close: string | null;
  filing_kind:
    | "letter_of_offer"
    | "public_announcement"
    | "daily_report"
    | "board_outcome"
    | "other";
  confidence: number;
};

export type BuybackScreenResult = {
  ok: boolean;
  decision: BuybackDecision;
  /** Plain-English why this decision. */
  why: string;
  extract: BuybackExtract;
  cmp: number | null;
  upside_pct: number | null;
  engine: string;
  text_chars: number;
  /** Truncated OCR / pdf-parse text shown in UI. */
  text_excerpt: string;
  source_url: string | null;
  error?: string;
  id?: number;
  screened_at?: string;
};

export type BuybackHistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  method: string;
  decision: string;
  offer_price: number | null;
  cmp: number | null;
  upside_pct: number | null;
  subject: string | null;
  screened_at: string;
  record_date: string | null;
  issue_open: string | null;
  issue_close: string | null;
  buyback_type: string | null;
  issue_shares: number | null;
  issue_shares_cr: number | null;
  issue_amount_cr: number | null;
};

const EXTRACT_SYSTEM = `You extract Indian listed-company share BUYBACK facts from an exchange filing (BSE/NSE PDF text).
Return ONLY JSON:
{
  "ticker": "NSE symbol or null",
  "company": "name or null",
  "subject": "short subject line",
  "method": "tender" | "open_market" | "unknown",
  "method_evidence": "short quote from text",
  "offer_price": number or null,
  "max_buyback_price": number or null,
  "issue_shares": number or null,
  "issue_amount_cr": number or null,
  "face_value": number or null,
  "listing": "BSE, NSE or null",
  "record_date": "YYYY-MM-DD or null",
  "tender_open": "YYYY-MM-DD or null",
  "tender_close": "YYYY-MM-DD or null",
  "filing_kind": "letter_of_offer" | "public_announcement" | "daily_report" | "board_outcome" | "other",
  "confidence": 0.0-1.0
}
Rules:
- method=tender if text says tender offer / tendering period / Letter of Offer for tender.
- method=open_market if "open market", "stock exchange mechanism", daily buyback report of shares bought on exchange.
- For tender, offer_price is the FIXED buyback price in ₹ (e.g. 1450 from "₹ 1,450/-"). For open market, put max/avg in max_buyback_price; offer_price null.
- issue_shares = max shares offered (Indian commas ok: 20,68,965 → 2068965).
- issue_amount_cr = aggregate buyback size in crore ₹ (300 from "₹ 300 crores" or "₹ 300,00,00,000").
- face_value typically 1, 2, 5, or 10.
- daily_report of shares bought that day = open_market.
- Do not invent prices or dates. No markdown.`;

function emptyExtract(): BuybackExtract {
  return {
    ticker: null,
    company: null,
    subject: null,
    method: "unknown",
    method_evidence: null,
    offer_price: null,
    max_buyback_price: null,
    issue_shares: null,
    issue_amount_cr: null,
    face_value: null,
    listing: null,
    record_date: null,
    tender_open: null,
    tender_close: null,
    filing_kind: "other",
    confidence: 0,
  };
}

/** PVR INOX Letter of Offer — fixture for tender extract fields. */
export const PVRINOX_TENDER_SAMPLE = {
  url: "https://www.bseindia.com/xml-data/corpfiling/AttachLive/739d7f51-56ee-4dce-8e22-717f501f31d9.pdf",
  ticker: "PVRINOX",
  company: "PVR INOX Limited",
  method: "tender" as const,
  issue_shares: 2_068_965,
  issue_amount_cr: 300,
  offer_price: 1450,
  face_value: 10,
  listing: "BSE, NSE",
  record_date: "2026-09-04",
  tender_open: "2026-09-10",
  tender_close: "2026-09-17",
};

function ensureDb() {
  const db = openSqliteNamed("buyback_screen.db", { wal: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS buyback_screens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url TEXT,
      ticker TEXT,
      company TEXT,
      method TEXT NOT NULL,
      decision TEXT NOT NULL,
      offer_price REAL,
      cmp REAL,
      upside_pct REAL,
      subject TEXT,
      extract_json TEXT NOT NULL,
      engine TEXT,
      screened_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_buyback_screened ON buyback_screens(screened_at DESC);
  `);
  // Chittorgarh-style pass columns (additive migration).
  const cols = db.prepare(`PRAGMA table_info(buyback_screens)`).all() as Array<{
    name: string;
  }>;
  const have = new Set(cols.map((c) => c.name));
  const add: Array<[string, string]> = [
    ["record_date", "TEXT"],
    ["issue_open", "TEXT"],
    ["issue_close", "TEXT"],
    ["buyback_type", "TEXT"],
    ["issue_shares", "REAL"],
    ["issue_shares_cr", "REAL"],
    ["issue_amount_cr", "REAL"],
  ];
  for (const [name, typ] of add) {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE buyback_screens ADD COLUMN ${name} ${typ}`);
    }
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_buyback_pass ON buyback_screens(decision, screened_at DESC)`,
  );
  return db;
}

function buybackTypeLabel(method: string): string {
  if (method === "tender") return "Tender Offer";
  if (method === "open_market") return "Open Market";
  return method || "—";
}

/** Shares count → crore (Chittorgarh "Issue Size - Shares (Rs. Cr.)"). */
export function sharesToCrore(shares: number | null | undefined): number | null {
  if (shares == null || !Number.isFinite(shares) || shares <= 0) return null;
  return Math.round((shares / 10_000_000) * 100) / 100;
}

/** Fetch BSE/NSE PDF bytes (server-side — exchanges block iframe embeds). */
export async function downloadBuybackPdf(
  url: string,
  opts?: { timeoutMs?: number },
): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/pdf,*/*",
        Referer: url.includes("bseindia")
          ? "https://www.bseindia.com/"
          : "https://www.nseindia.com/",
      },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 90_000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    // %PDF
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
      return buf;
    }
    return buf;
  } catch {
    return null;
  }
}

function isAllowedPdfHost(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return (
      h === "www.bseindia.com" ||
      h === "bseindia.com" ||
      h.endsWith(".bseindia.com") ||
      h === "www.nseindia.com" ||
      h === "nseindia.com" ||
      h.endsWith(".nseindia.com") ||
      h === "archives.nseindia.com"
    );
  } catch {
    return false;
  }
}

/** Safe allowlist check for PDF proxy URLs. */
export function isBuybackPdfProxyUrl(url: string): boolean {
  return isAllowedPdfHost(url.trim());
}

async function extractPdfText(buf: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    b: Buffer,
  ) => Promise<{ text?: string }>;
  const parsed = await pdfParse(buf);
  return (parsed.text || "").trim();
}

function qianfanConfigured(): boolean {
  return !!(process.env.QIANFAN_OCR_BASE_URL || "").trim();
}

async function ocrPdf(buf: Buffer): Promise<string> {
  if (!qianfanConfigured()) return "";
  const pages = await rasterizePdfPages(buf, { maxPages: 6, dpi: 144 });
  const chunks: string[] = [];
  for (const page of pages) {
    const t = await ocrImageWithQianfan(
      page.dataUrl,
      "Transcribe all text from this Indian stock-exchange buyback filing page. Preserve company name, ticker/symbol, offer price, tender/open market wording, record date, tender period dates exactly. Plain text only.",
    );
    if (t.trim()) chunks.push(`--- page ${page.page} ---\n${t.trim()}`);
  }
  return chunks.join("\n\n").trim();
}

/** Lexical method hint — overrides soft LLM misses on daily open-market reports. */
export function detectMethodLexical(text: string): {
  method: BuybackMethod;
  evidence: string | null;
} {
  const t = text.replace(/\s+/g, " ");
  if (
    /open\s+market\s+through\s+stock\s+exchange/i.test(t) ||
    /from\s+the\s+open\s+market/i.test(t) ||
    /buy[\s-]?back[^.|]{0,80}open\s+market/i.test(t) ||
    /daily\s+report[^.|]{0,60}bought\s+back/i.test(t) ||
    /shares\s+bought\s+back\s+on\s+\w+\s+\d{1,2},?\s+\d{4}/i.test(t)
  ) {
    const m = t.match(
      /open\s+market[^.|]{0,60}|from\s+the\s+open\s+market[^.|]{0,40}|daily\s+report[^.|]{0,50}/i,
    );
    return { method: "open_market", evidence: m?.[0]?.trim().slice(0, 160) || null };
  }
  if (
    /tender\s+offer/i.test(t) ||
    /through\s+the\s+['"]?tender\s+offer/i.test(t) ||
    /tendering\s+period/i.test(t)
  ) {
    const m = t.match(/tender\s+offer[^.|]{0,60}|tendering\s+period[^.|]{0,40}/i);
    return { method: "tender", evidence: m?.[0]?.trim().slice(0, 160) || null };
  }
  return { method: "unknown", evidence: null };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/** Parse ₹ amounts that may use Indian grouping (1,450 or 20,68,965). */
function parseInrAmount(raw: string): number | null {
  const cleaned = raw.replace(/[₹Rs.\s]/gi, "").replace(/,/g, "").replace(/\/-?$/, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

/** "September 10, 2026" / "Friday, September 4, 2026" → YYYY-MM-DD */
function parseEnglishDate(raw: string): string | null {
  const m = raw
    .replace(/\s+/g, " ")
    .trim()
    .match(
      /(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i,
    );
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  const day = m[2].padStart(2, "0");
  return `${m[3]}-${mon}-${day}`;
}

/**
 * Fill gaps from Letter of Offer / PA wording when LLM misses fields.
 * PVRINOX sample: tender, 20,68,965 shares, ₹300 Cr, ₹1450, FV ₹10, BSE/NSE.
 */
export function enrichExtractLexical(
  text: string,
  extract: BuybackExtract,
): BuybackExtract {
  const out = { ...extract };
  const flat = text.replace(/\s+/g, " ");

  if (/LETTER\s+OF\s+OFFER/i.test(text) && out.filing_kind === "other") {
    out.filing_kind = "letter_of_offer";
  }

  if (out.offer_price == null) {
    const patterns = [
      /at\s+a\s+price\s+of\s+[₹Rs.\s]*([\d,]+(?:\.\d+)?)\s*(?:\/-)?/i,
      /price\s+of\s+[₹Rs.\s]*([\d,]+(?:\.\d+)?)\s*(?:\/-)?(?:\s*\([^)]*\))?\s*per\s+(?:Equity\s+)?Share/i,
      /Buy[\s-]?back\s+Price[^\d₹]{0,40}[₹Rs.\s]*([\d,]+(?:\.\d+)?)/i,
      /₹\s*([\d,]+(?:\.\d+)?)\s*(?:\/-)?\s*\([^)]*\)\s*per\s+(?:Equity\s+)?Share/i,
    ];
    for (const re of patterns) {
      const m = flat.match(re);
      if (!m) continue;
      const p = parseInrAmount(m[1]);
      // Buyback offer prices are typically ≥ ₹10 and < ₹100000
      if (p != null && p >= 10 && p < 100_000) {
        out.offer_price = p;
        break;
      }
    }
  }

  if (out.issue_shares == null) {
    const patterns = [
      /(?:up\s+to|buyback\s+of(?:\s+up\s+to)?)\s+([\d,]+)\s*(?:\([^)]+\))?\s*fully\s+paid[- ]?up\s+equity\s+shares/i,
      /OFFER\s+TO\s+BUYBACK\s+UP\s+TO\s+([\d,]+)/i,
      /Issue\s+Size\s*\(Shares\)\s*([\d,]+)/i,
    ];
    for (const re of patterns) {
      const m = flat.match(re);
      if (!m) continue;
      const n = parseInrAmount(m[1]);
      if (n != null && n >= 1000) {
        out.issue_shares = Math.round(n);
        break;
      }
    }
  }

  if (out.issue_amount_cr == null) {
    const crore = flat.match(
      /(?:aggregate\s+maximum\s+amount|buy[\s-]?back\s+size|Issue\s+Size\s*\(Amount\))[^\d₹]{0,80}[₹Rs.\s]*([\d,.]+)\s*(?:Crores?|Cr\.?)/i,
    );
    if (crore) {
      const n = Number(crore[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0 && n < 100_000) out.issue_amount_cr = n;
    }
    if (out.issue_amount_cr == null) {
      // ₹ 300,00,00,000 → crore
      const rupees = flat.match(
        /(?:not\s+exceeding|aggregate\s+maximum\s+amount)[^\d₹]{0,40}[₹Rs.\s]*([\d,]+)\s*(?:\/-)?/i,
      );
      if (rupees) {
        const n = parseInrAmount(rupees[1]);
        if (n != null && n >= 10_000_000) {
          out.issue_amount_cr = Math.round((n / 10_000_000) * 100) / 100;
        }
      }
    }
  }

  if (out.face_value == null) {
    const fv = flat.match(
      /face\s+value\s+of\s+[₹Rs.\sINR]*([\d,]+(?:\.\d+)?)/i,
    );
    const p = fv ? parseInrAmount(fv[1]) : null;
    if (p != null && p <= 100) out.face_value = p;
  }

  if (!out.listing) {
    const hasBse = /\bBSE\b/i.test(flat);
    const hasNse = /\bNSE\b|National\s+Stock\s+Exchange/i.test(flat);
    if (hasBse && hasNse) out.listing = "BSE, NSE";
    else if (hasBse) out.listing = "BSE";
    else if (hasNse) out.listing = "NSE";
  }

  if (!out.tender_open) {
    const open =
      flat.match(
        /BUYBACK\s+OPENS\s+ON\s+((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+[A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
      )?.[1] ||
      flat.match(
        /date\s+of\s+opening\s+of\s+the\s+Buy[\s-]?back\s+is\s+([^.]{8,50})/i,
      )?.[1];
    if (open) out.tender_open = parseEnglishDate(open);
  }
  if (!out.tender_close) {
    const close =
      flat.match(
        /BUYBACK\s+CLOSES\s+ON\s+((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+[A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
      )?.[1] ||
      flat.match(
        /date\s+of\s+closing\s+of\s+the\s+Buy[\s-]?back\s+is\s+([^.]{8,50})/i,
      )?.[1];
    if (close) out.tender_close = parseEnglishDate(close);
  }
  if (!out.record_date) {
    const rd = flat.match(
      /Record\s+Date[,\s]*(?:being\s+|i\.e\.?,?\s*)([^.]{8,50})/i,
    )?.[1];
    if (rd) out.record_date = parseEnglishDate(rd);
  }

  if (!out.subject) {
    const sub =
      text.match(/Subject\s*:\s*(.+)/i)?.[1]?.trim() ||
      text.match(/Sub\s*:\s*(.+)/i)?.[1]?.trim();
    if (sub) out.subject = sub.replace(/\s+/g, " ").slice(0, 280);
  }

  return out;
}

function parseExtract(raw: Record<string, unknown>): BuybackExtract {
  const methodRaw = String(raw.method || "").toLowerCase();
  const method: BuybackMethod =
    methodRaw === "tender" || methodRaw === "open_market"
      ? methodRaw
      : "unknown";
  const kindRaw = String(raw.filing_kind || "other");
  const filing_kind = (
    [
      "letter_of_offer",
      "public_announcement",
      "daily_report",
      "board_outcome",
      "other",
    ] as const
  ).includes(kindRaw as BuybackExtract["filing_kind"])
    ? (kindRaw as BuybackExtract["filing_kind"])
    : "other";
  const conf = num(raw.confidence);
  return {
    ticker: str(raw.ticker)?.toUpperCase() ?? null,
    company: str(raw.company),
    subject: str(raw.subject),
    method,
    method_evidence: str(raw.method_evidence),
    offer_price: num(raw.offer_price),
    max_buyback_price: num(raw.max_buyback_price),
    issue_shares: num(raw.issue_shares),
    issue_amount_cr: num(raw.issue_amount_cr),
    face_value: num(raw.face_value),
    listing: str(raw.listing),
    record_date: str(raw.record_date),
    tender_open: str(raw.tender_open),
    tender_close: str(raw.tender_close),
    filing_kind,
    confidence: conf != null ? Math.min(1, conf) : 0.5,
  };
}

export function decideBuyback(
  extract: BuybackExtract,
  cmp: number | null,
): { decision: BuybackDecision; upside_pct: number | null; why: string } {
  if (extract.method === "open_market") {
    return {
      decision: "skip_open_market",
      upside_pct: null,
      why: "Filing is an open-market buyback (buys on exchange), not a tender offer. Flowchart: stop.",
    };
  }
  if (extract.method !== "tender") {
    return {
      decision: "need_review",
      upside_pct: null,
      why: "Could not tell tender vs open market from the text. Check subject line manually.",
    };
  }
  if (extract.offer_price == null) {
    return {
      decision: "need_review",
      upside_pct: null,
      why: "Marked as tender but no fixed offer price found in the text.",
    };
  }
  if (cmp == null || cmp <= 0) {
    return {
      decision: "need_review",
      upside_pct: null,
      why: `Tender offer ₹${extract.offer_price} found, but CMP unavailable for ${extract.ticker || "ticker"}.`,
    };
  }
  const upside = (extract.offer_price - cmp) / cmp;
  const upside_pct = Math.round(upside * 10000) / 100;
  if (upside > BUYBACK_UPSIDE_MIN) {
    return {
      decision: "pass_tender",
      upside_pct,
      why: `Tender offer ₹${extract.offer_price} vs CMP ₹${cmp} → ${upside_pct}% > 8%. Continue to technicals / fundamentals.`,
    };
  }
  return {
    decision: "skip_low_upside",
    upside_pct,
    why: `Tender offer ₹${extract.offer_price} vs CMP ₹${cmp} → ${upside_pct}% (need >8%). Flowchart: stop.`,
  };
}

export const BUYBACK_PASS_HISTORY_LIMIT = 1;

function saveHistory(row: {
  source_url: string | null;
  extract: BuybackExtract;
  decision: BuybackDecision;
  cmp: number | null;
  upside_pct: number | null;
  engine: string;
}): number | null {
  // Persist only PASS rows into the Chittorgarh-style register.
  if (row.decision !== "pass_tender") return null;

  const db = ensureDb();
  try {
    const at = new Date().toISOString();
    const issue_shares = row.extract.issue_shares;
    const issue_shares_cr = sharesToCrore(issue_shares);
    const ticker = row.extract.ticker?.toUpperCase() || null;
    const buyback_type = buybackTypeLabel(row.extract.method);
    const extract_json = JSON.stringify(row.extract);

    // One PASS row per ticker (or per PDF URL if no ticker) — update in place.
    let existingId: number | null = null;
    if (ticker) {
      const hit = db
        .prepare(
          `SELECT id FROM buyback_screens
           WHERE decision = 'pass_tender' AND upper(ticker) = ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(ticker) as { id: number } | undefined;
      existingId = hit?.id ?? null;
    } else if (row.source_url) {
      const hit = db
        .prepare(
          `SELECT id FROM buyback_screens
           WHERE decision = 'pass_tender' AND source_url = ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(row.source_url) as { id: number } | undefined;
      existingId = hit?.id ?? null;
    }

    if (existingId != null) {
      db.prepare(
        `UPDATE buyback_screens SET
          source_url = ?, ticker = ?, company = ?, method = ?, decision = ?,
          offer_price = ?, cmp = ?, upside_pct = ?, subject = ?,
          extract_json = ?, engine = ?, screened_at = ?,
          record_date = ?, issue_open = ?, issue_close = ?, buyback_type = ?,
          issue_shares = ?, issue_shares_cr = ?, issue_amount_cr = ?
         WHERE id = ?`,
      ).run(
        row.source_url,
        ticker,
        row.extract.company,
        row.extract.method,
        row.decision,
        row.extract.offer_price,
        row.cmp,
        row.upside_pct,
        row.extract.subject,
        extract_json,
        row.engine,
        at,
        row.extract.record_date,
        row.extract.tender_open,
        row.extract.tender_close,
        buyback_type,
        issue_shares,
        issue_shares_cr,
        row.extract.issue_amount_cr,
        existingId,
      );
      prunePassHistory(db);
      return existingId;
    }

    const info = db
      .prepare(
        `INSERT INTO buyback_screens (
          source_url, ticker, company, method, decision,
          offer_price, cmp, upside_pct, subject, extract_json, engine, screened_at,
          record_date, issue_open, issue_close, buyback_type,
          issue_shares, issue_shares_cr, issue_amount_cr
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.source_url,
        ticker,
        row.extract.company,
        row.extract.method,
        row.decision,
        row.extract.offer_price,
        row.cmp,
        row.upside_pct,
        row.extract.subject,
        extract_json,
        row.engine,
        at,
        row.extract.record_date,
        row.extract.tender_open,
        row.extract.tender_close,
        buyback_type,
        issue_shares,
        issue_shares_cr,
        row.extract.issue_amount_cr,
      );
    const id = Number(info.lastInsertRowid);
    prunePassHistory(db);
    return id;
  } finally {
    db.close();
  }
}

function prunePassHistory(db: ReturnType<typeof ensureDb>) {
  // Drop older duplicates of the same ticker first.
  const dups = db
    .prepare(
      `SELECT id FROM buyback_screens b
       WHERE decision = 'pass_tender'
         AND ticker IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM buyback_screens b2
           WHERE b2.decision = 'pass_tender'
             AND upper(b2.ticker) = upper(b.ticker)
             AND b2.id > b.id
         )`,
    )
    .all() as Array<{ id: number }>;
  if (dups.length) {
    db.prepare(
      `DELETE FROM buyback_screens WHERE id IN (${dups.map(() => "?").join(",")})`,
    ).run(...dups.map((d) => d.id));
  }

  const keep = db
    .prepare(
      `SELECT id FROM buyback_screens
       WHERE decision = 'pass_tender'
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(BUYBACK_PASS_HISTORY_LIMIT) as Array<{ id: number }>;
  if (keep.length === 0) {
    db.prepare(
      `DELETE FROM buyback_screens WHERE decision = 'pass_tender'`,
    ).run();
    return;
  }
  const ids = keep.map((k) => k.id);
  db.prepare(
    `DELETE FROM buyback_screens
     WHERE decision = 'pass_tender'
       AND id NOT IN (${ids.map(() => "?").join(",")})`,
  ).run(...ids);
}

export function listBuybackHistory(
  limit = BUYBACK_PASS_HISTORY_LIMIT,
  opts?: { decision?: BuybackDecision | "pass" | null },
): BuybackHistoryRow[] {
  try {
    const db = ensureDb();
    try {
      const decisionFilter =
        opts?.decision === "pass" || opts?.decision === "pass_tender"
          ? "pass_tender"
          : opts?.decision || null;
      if (decisionFilter === "pass_tender") {
        prunePassHistory(db);
      }
      const cap =
        decisionFilter === "pass_tender"
          ? Math.min(BUYBACK_PASS_HISTORY_LIMIT, Math.max(1, limit))
          : Math.min(100, Math.max(1, limit));
      type Raw = {
        id: number;
        source_url: string | null;
        ticker: string | null;
        company: string | null;
        method: string;
        decision: string;
        offer_price: number | null;
        cmp: number | null;
        upside_pct: number | null;
        subject: string | null;
        screened_at: string;
        record_date: string | null;
        issue_open: string | null;
        issue_close: string | null;
        buyback_type: string | null;
        issue_shares: number | null;
        issue_shares_cr: number | null;
        issue_amount_cr: number | null;
        extract_json?: string | null;
      };
      const rows = (
        decisionFilter
          ? (db
              .prepare(
                `SELECT id, source_url, ticker, company, method, decision,
                        offer_price, cmp, upside_pct, subject, screened_at,
                        record_date, issue_open, issue_close, buyback_type,
                        issue_shares, issue_shares_cr, issue_amount_cr,
                        extract_json
                 FROM buyback_screens
                 WHERE decision = ?
                 ORDER BY id DESC
                 LIMIT ?`,
              )
              .all(decisionFilter, cap) as Raw[])
          : (db
              .prepare(
                `SELECT id, source_url, ticker, company, method, decision,
                        offer_price, cmp, upside_pct, subject, screened_at,
                        record_date, issue_open, issue_close, buyback_type,
                        issue_shares, issue_shares_cr, issue_amount_cr,
                        extract_json
                 FROM buyback_screens
                 ORDER BY id DESC
                 LIMIT ?`,
              )
              .all(cap) as Raw[])
      );

      return rows.map((row) => {
        let record_date = row.record_date;
        let issue_open = row.issue_open;
        let issue_close = row.issue_close;
        let buyback_type = row.buyback_type;
        let issue_shares = row.issue_shares;
        let issue_shares_cr = row.issue_shares_cr;
        let issue_amount_cr = row.issue_amount_cr;
        // Backfill from extract_json for older rows.
        if (
          !record_date ||
          !issue_open ||
          !issue_close ||
          issue_shares == null ||
          issue_amount_cr == null
        ) {
          try {
            const ex = JSON.parse(
              row.extract_json || "{}",
            ) as Partial<BuybackExtract>;
            record_date = record_date || ex.record_date || null;
            issue_open = issue_open || ex.tender_open || null;
            issue_close = issue_close || ex.tender_close || null;
            buyback_type =
              buyback_type || buybackTypeLabel(ex.method || row.method);
            issue_shares =
              issue_shares ??
              (typeof ex.issue_shares === "number" ? ex.issue_shares : null);
            issue_shares_cr =
              issue_shares_cr ?? sharesToCrore(issue_shares);
            issue_amount_cr =
              issue_amount_cr ??
              (typeof ex.issue_amount_cr === "number"
                ? ex.issue_amount_cr
                : null);
          } catch {
            /* ignore */
          }
        }
        if (!buyback_type) buyback_type = buybackTypeLabel(row.method);
        if (issue_shares_cr == null) issue_shares_cr = sharesToCrore(issue_shares);
        return {
          id: row.id,
          source_url: row.source_url,
          ticker: row.ticker,
          company: row.company,
          method: row.method,
          decision: row.decision,
          offer_price: row.offer_price,
          cmp: row.cmp,
          upside_pct: row.upside_pct,
          subject: row.subject,
          screened_at: row.screened_at,
          record_date,
          issue_open,
          issue_close,
          buyback_type,
          issue_shares,
          issue_shares_cr,
          issue_amount_cr,
        };
      });
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export async function screenBuybackPdf(opts: {
  url?: string | null;
  pdfBuffer?: Buffer | null;
}): Promise<BuybackScreenResult> {
  const source_url = opts.url?.trim() || null;
  let buf = opts.pdfBuffer ?? null;
  let engine = "none";

  if (!buf && source_url) {
    buf = await downloadBuybackPdf(source_url);
  }
  if (!buf) {
    return {
      ok: false,
      decision: "need_review",
      why: "No PDF bytes to read.",
      extract: emptyExtract(),
      cmp: null,
      upside_pct: null,
      engine,
      text_chars: 0,
      text_excerpt: "",
      source_url,
      error: source_url
        ? "Could not download PDF (try upload). BSE/NSE may block the server."
        : "Provide a PDF URL or upload",
    };
  }

  let text = "";
  try {
    text = await extractPdfText(buf);
    engine = "pdf-parse";
  } catch {
    text = "";
  }

  if (text.length < 120) {
    try {
      const ocr = await ocrPdf(buf);
      if (ocr.length >= 40) {
        text = ocr;
        engine = "vision-ocr";
      }
    } catch (e) {
      if (text.length < 80) {
        return {
          ok: false,
          decision: "need_review",
          why: "Could not OCR enough text from the PDF.",
          extract: emptyExtract(),
          cmp: null,
          upside_pct: null,
          engine,
          text_chars: text.length,
          text_excerpt: text.slice(0, 4000),
          source_url,
          error:
            e instanceof Error
              ? e.message
              : "OCR failed — set QIANFAN_OCR_BASE_URL or upload a text PDF",
        };
      }
    }
  }

  if (text.length < 80) {
    return {
      ok: false,
      decision: "need_review",
      why: "Little text extracted from the PDF.",
      extract: emptyExtract(),
      cmp: null,
      upside_pct: null,
      engine,
      text_chars: text.length,
      text_excerpt: text.slice(0, 4000),
      source_url,
      error: "Little text from PDF — upload another file or enable vision OCR",
    };
  }

  const lexical = detectMethodLexical(text);
  let extract = emptyExtract();

  const cfg = loadLlmConfig();
  const status = await checkLlmStatus(cfg);
  if (status.available) {
    try {
      const parsed = await completeJson(
        cfg,
        EXTRACT_SYSTEM,
        `Filing text (truncated):\n${text.slice(0, 14000)}`,
        { skipStatusCheck: true, numPredict: 900 },
      );
      extract = parseExtract(parsed);
      engine = `${engine}+llm`;
    } catch {
      /* lexical fallback */
    }
  }

  // Lexical wins on clear open-market / tender phrases.
  if (lexical.method === "open_market") {
    extract.method = "open_market";
    if (!extract.method_evidence) extract.method_evidence = lexical.evidence;
    if (extract.filing_kind === "other") extract.filing_kind = "daily_report";
  } else if (
    lexical.method === "tender" &&
    (extract.method === "unknown" || extract.method === "tender")
  ) {
    extract.method = "tender";
    if (!extract.method_evidence) extract.method_evidence = lexical.evidence;
  }

  extract = enrichExtractLexical(text, extract);
  if (
    extract.confidence < 0.5 &&
    extract.offer_price != null &&
    extract.method === "tender"
  ) {
    extract.confidence = 0.85;
  }

  if (!extract.ticker) {
    const sym =
      text.match(/\bSymbol\s*:\s*([A-Z0-9.&-]+)/i)?.[1] ||
      text.match(/\bNSE\s+Symbol\s*:\s*([A-Z0-9.&-]+)/i)?.[1];
    if (sym) extract.ticker = sym.toUpperCase();
  }
  if (!extract.company) {
    const co =
      text.match(/Buyback by\s+([^(]+?)\s+\([“"]?Company/i)?.[1]?.trim() ||
      text.match(
        /Proposed buyback by\s+([^(]+?)\s+\([“"]?Company/i,
      )?.[1]?.trim();
    if (co) extract.company = co.slice(0, 160);
  }

  let cmp: number | null = null;
  if (extract.ticker) {
    try {
      const q = await fetchQuoteDetailed(extract.ticker, "NSE", {
        skipSummary: true,
      });
      cmp = q.price;
    } catch {
      cmp = null;
    }
  }

  const { decision, upside_pct, why } = decideBuyback(extract, cmp);
  const id = saveHistory({
    source_url,
    extract,
    decision,
    cmp,
    upside_pct,
    engine,
  });

  return {
    ok: true,
    decision,
    why,
    extract,
    cmp,
    upside_pct,
    engine,
    text_chars: text.length,
    text_excerpt: text.slice(0, 8000),
    source_url,
    id: id ?? undefined,
    screened_at: new Date().toISOString(),
  };
}
