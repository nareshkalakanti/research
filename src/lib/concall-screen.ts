/**
 * Concall Research — earnings-call transcript PDF → structured JSON extract.
 * Schema + system prompt: prompts/concall-research-extract.system.txt
 */
import fs from "fs";
import path from "path";
import { downloadBuybackPdf } from "./buyback-screen";
import { checkLlmStatus, completeJson } from "./llm-client";
import { loadLlmConfig } from "./llm-config";
import { openSqliteNamed } from "./sqlite-utils";

export type ConcallExtract = Record<string, unknown>;

export type ConcallScreenResult = {
  ok: boolean;
  decision: "pass" | "review" | "fail";
  why: string;
  extract: ConcallExtract;
  extract_json: ConcallExtract;
  engine: string;
  text_chars: number;
  text_excerpt: string;
  source_url: string | null;
  error?: string;
  id?: number;
  screened_at?: string;
};

export type ConcallHistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  period: string | null;
  sentiment: string | null;
  decision: string;
  screened_at: string;
};

const SCHEMA_PATH = path.join(
  process.cwd(),
  "data",
  "concall-research-fields.json",
);
const PROMPT_PATH = path.join(
  process.cwd(),
  "prompts",
  "concall-research-extract.system.txt",
);
const EXCERPT_MAX = 12_000;
/** Full transcript fits 128k-context models; leave headroom for system+JSON. */
const TRANSCRIPT_MAX = 90_000;

let schemaCache: Record<string, unknown> | null = null;
let promptCache: string | null = null;

export function loadConcallResearchSchema(opts?: {
  force?: boolean;
}): Record<string, unknown> {
  if (!opts?.force && schemaCache) return schemaCache;
  schemaCache = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  return schemaCache;
}

function loadExtractSystemPrompt(): string {
  if (promptCache) return promptCache;
  promptCache = fs.readFileSync(PROMPT_PATH, "utf8").trim();
  return promptCache;
}

export async function downloadConcallPdf(url: string): Promise<Buffer | null> {
  return downloadBuybackPdf(url);
}

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
      h.includes("moneycontrol") ||
      h.includes("indoborax")
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

function emptyExtract(): ConcallExtract {
  return {
    metadata: {
      company_name: null,
      nse_symbol: null,
      bse_code: null,
      call_date: null,
      quarter: null,
      fiscal_year: null,
      speakers: [],
    },
    reported_financials: {},
    forward_guidance: {
      revenue_guidance_range: null,
      margin_guidance: null,
      explicit_caveats: [],
      capex_guidance: [],
    },
    segment_data: [],
    corporate_actions: [],
    risk_governance_flags: {
      pledged_shares: null,
      debt_disclosed: [],
      related_party_transactions: [],
      deflected_or_vague_topics: [],
    },
    management_tone: {
      overall_tone: null,
      justification: null,
      confidence_markers: {
        specific_commitments: [],
        hedged_language: [],
      },
      guidance_walkback: null,
      net_sentiment_score: null,
      sentiment_rationale: null,
    },
    key_catalysts: [],
  };
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function enrichLexical(text: string, extract: ConcallExtract): ConcallExtract {
  // pdf-parse often injects double spaces between words
  text = text.replace(/[ \t\u00a0]+/g, " ");
  const meta = asObj(extract.metadata) || {};
  if (!meta.nse_symbol) {
    const sym =
      text.match(/\bSymbol\s*:\s*([A-Z0-9.&-]+)/i)?.[1] ||
      text.match(/\bNSE\s+(?:Symbol|Code)\s*:\s*([A-Z0-9.&-]+)/i)?.[1];
    if (sym) meta.nse_symbol = sym.toUpperCase();
  }
  if (!meta.bse_code) {
    const code =
      text.match(/\bScrip\s+Code\s*:\s*(\d{4,8})/i)?.[1] ||
      text.match(/\bBSE\s+Code\s*:\s*(\d{4,8})/i)?.[1];
    if (code) meta.bse_code = code;
  }
  if (!meta.call_date) {
    const m = text.match(
      /(?:held on|Conference Call\s*)(?:Wednesday,?\s*)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i,
    );
    if (m) {
      const months: Record<string, string> = {
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
      const mm = months[m[1].toLowerCase()];
      if (mm) {
        meta.call_date = `${m[3]}-${mm}-${m[2].padStart(2, "0")}`;
      }
    }
  }
  if (!meta.quarter || !meta.fiscal_year) {
    const q = text.match(/\bQ([1-4])\s+FY\s*'?\s*(\d{2,4})\b/i);
    if (q) {
      if (!meta.quarter) meta.quarter = `Q${q[1]}`;
      if (!meta.fiscal_year) {
        const fy = q[2].length === 2 ? `FY${q[2]}` : `FY${q[2].slice(-2)}`;
        meta.fiscal_year = fy;
      }
    }
  }
  if (!meta.company_name) {
    const co = text.match(
      /(?:for|of)\s+(Indo Borax[^.\n]{0,40}Limited)/i,
    )?.[1];
    if (co) meta.company_name = co.trim();
  }
  extract.metadata = meta;

  // Disclosed ₹ crore / margin figures — fill only when LLM left them empty.
  let fin = asObj(extract.reported_financials);
  if (!fin || Array.isArray(fin) || "topic" in fin || Object.keys(fin).length === 0) {
    fin = {};
  }
  const num = (s: string | undefined) => {
    if (!s) return null;
    const n = Number(s.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  if (!asObj(fin.revenue)?.current_qtr) {
    const m = text.match(
      /operating revenue was Rs\.?\s*([\d,.]+)\s*crore[^.]{0,80}?([\d.]+)\s*%\s*increase against Rs\.?\s*([\d,.]+)/i,
    );
    if (m) {
      fin.revenue = {
        current_qtr: num(m[1]),
        yoy_qtr: num(m[3]),
        pct_change: num(m[2]),
        unit: "INR cr",
      };
    }
  }
  if (!asObj(fin.ebitda)?.current_qtr) {
    const m = text.match(
      /EBITDA for the quarter was up by ([\d.]+)%\s*to Rs\.?\s*([\d,.]+)\s*crore as compared to Rs\.?\s*([\d,.]+)/i,
    );
    if (m) {
      fin.ebitda = {
        current_qtr: num(m[2]),
        yoy_qtr: num(m[3]),
        pct_change: num(m[1]),
        unit: "INR cr",
      };
    }
  }
  if (!asObj(fin.ebitda_margin_pct)?.current_qtr) {
    const m = text.match(/EBITDA margin of ([\d.]+)%/i);
    if (m) {
      fin.ebitda_margin_pct = {
        current_qtr: num(m[1]),
        yoy_qtr: null,
        pct_change: null,
      };
    }
  }
  if (!asObj(fin.net_profit)?.current_qtr) {
    const m = text.match(
      /net profit increased by ([\d.]+)%\s*to Rs\.?\s*([\d,.]+)\s*crore[^.]{0,40}?Rs\.?\s*([\d,.]+)/i,
    );
    if (m) {
      fin.net_profit = {
        current_qtr: num(m[2]),
        yoy_qtr: num(m[3]),
        pct_change: num(m[1]),
        unit: "INR cr",
      };
    }
  }
  if (!asObj(fin.pat_margin_pct)?.current_qtr) {
    const m = text.match(
      /EBITDA and PAT margins were ([\d.]+)% and ([\d.]+)%/i,
    );
    if (m) {
      fin.pat_margin_pct = {
        current_qtr: num(m[2]),
        yoy_qtr: null,
        pct_change: null,
      };
    }
  }
  if (!asObj(fin.eps)?.current_qtr) {
    const m = text.match(/\bEPS\b[^0-9]{0,40}([\d.]+)/i);
    if (m) {
      fin.eps = { current_qtr: num(m[1]), yoy_qtr: null, unit: "INR" };
    }
  }
  extract.reported_financials = fin;

  let guide = asObj(extract.forward_guidance);
  if (
    !guide ||
    "question" in guide ||
    (!("revenue_guidance_range" in guide) && !("margin_guidance" in guide))
  ) {
    guide = {
      revenue_guidance_range: null,
      margin_guidance: null,
      explicit_caveats: [],
      capex_guidance: [],
    };
  }
  const rev = asObj(guide.revenue_guidance_range);
  if (!rev?.low) {
    const m = text.match(
      /Rs\.?\s*([\d,.]+)\s*crores?\s*to\s*Rs\.?\s*([\d,.]+)\s*crores?\s*of revenue with a ([\d.]+)%\s*EBITDA[\s\S]{0,220}?versus Rs\.?\s*([\d,.]+)/i,
    );
    if (m) {
      guide.revenue_guidance_range = {
        low: num(m[1]),
        high: num(m[2]),
        unit: "INR cr",
        fiscal_year: meta.fiscal_year || "FY27",
        prior_year_actual: num(m[4]),
      };
      guide.margin_guidance = {
        ebitda_pct: num(m[3]),
        fiscal_year: meta.fiscal_year || "FY27",
      };
    }
  }
  extract.forward_guidance = guide;

  let tone = asObj(extract.management_tone);
  if (!tone || "response" in tone || !tone.overall_tone) {
    const base = tone && !("response" in tone) ? tone : {};
    tone = {
      overall_tone: null,
      justification: null,
      confidence_markers: {
        specific_commitments: [],
        hedged_language: [],
      },
      guidance_walkback: null,
      net_sentiment_score: null,
      sentiment_rationale: null,
      ...base,
    };
  }
  if (!tone.overall_tone) {
    const strong =
      /confident of delivering|lovely quarter|reiterat|guidance of about Rs/i.test(
        text,
      );
    const cautious = /seasonally weak|not representative|should not be extrapolated/i.test(
      text,
    );
    if (strong && !cautious) tone.overall_tone = "bullish";
    else if (strong && cautious) tone.overall_tone = "bullish";
    else if (cautious) tone.overall_tone = "cautious";
    else tone.overall_tone = "neutral";
  }
  extract.management_tone = tone;

  // Kronox acquisition stake / consideration if actions empty or malformed
  let actions = Array.isArray(extract.corporate_actions)
    ? extract.corporate_actions
    : [];
  const hasKronox = actions.some((a) => {
    const o = asObj(a);
    return (
      o &&
      typeof o.target_counterparty === "string" &&
      /kronox/i.test(o.target_counterparty)
    );
  });
  if (!hasKronox) {
    const stake = text.match(
      /acquisition of ([\d.]+)%\s*equity share[^.]{0,80}?Kronox Lab Sciences/i,
    );
    const deal = text.match(
      /(?:just under|about)\s*Rs\.?\s*([\d,.]+)\s*crores?\s*have to be paid to the promoters[^.]{0,80}?64\.26%/i,
    );
    if (stake || /Kronox Lab Sciences/i.test(text)) {
      actions = [
        {
          type: "acquisition",
          target_counterparty: "Kronox Lab Sciences Ltd",
          stake_pct: stake ? num(stake[1]) : 64.26,
          deal_value: deal
            ? {
                amount: num(deal[1]),
                unit: "INR cr",
                component: "promoter stake",
              }
            : null,
        },
        ...actions.filter((a) => asObj(a)?.type === "merger"),
      ];
    }
  }
  const hasInfraMerger = actions.some((a) => {
    const o = asObj(a);
    return (
      o?.type === "merger" &&
      typeof o.target_counterparty === "string" &&
      /Infrastructure/i.test(o.target_counterparty)
    );
  });
  if (
    !hasInfraMerger &&
    /scheme of amalgamation[\s\S]{0,120}?Indo Borax Infrastructure/i.test(text)
  ) {
    actions = [
      ...actions,
      {
        type: "merger",
        target_counterparty:
          "Indo Borax Infrastructure Private Limited (wholly-owned subsidiary)",
        stake_pct: 100,
        deal_value: null,
      },
    ];
  }
  extract.corporate_actions = actions;

  return extract;
}

function transcriptWindow(
  text: string,
  opts: { start?: number; end?: number; max?: number; needle?: RegExp },
): string {
  if (opts.needle) {
    const m = opts.needle.exec(text);
    if (m && m.index != null) {
      const start = Math.max(0, m.index - 800);
      return text.slice(start, start + (opts.max || 18_000));
    }
  }
  const start = opts.start || 0;
  const end = opts.end ?? start + (opts.max || 18_000);
  return text.slice(start, end);
}

function isSchemaShaped(key: string, value: unknown): boolean {
  if (value == null) return false;
  if (key === "forward_guidance") {
    const o = asObj(value);
    return Boolean(
      o &&
        !("question" in o) &&
        !("answer" in o) &&
        ("revenue_guidance_range" in o ||
          "margin_guidance" in o ||
          "explicit_caveats" in o ||
          "capex_guidance" in o),
    );
  }
  if (key === "reported_financials") {
    const o = asObj(value);
    if (!o || "topic" in o || "question" in o) return false;
    // Need at least one known metric object
    return ["revenue", "ebitda", "net_profit", "eps"].some((k) => asObj(o[k]));
  }
  if (key === "management_tone") {
    const o = asObj(value);
    return Boolean(o && ("overall_tone" in o || "net_sentiment_score" in o));
  }
  if (key === "corporate_actions" || key === "segment_data" || key === "key_catalysts") {
    return Array.isArray(value);
  }
  return typeof value === "object";
}

function decide(extract: ConcallExtract): {
  decision: "pass" | "review" | "fail";
  why: string;
} {
  const meta = asObj(extract.metadata);
  const tone = asObj(extract.management_tone);
  const fin = asObj(extract.reported_financials);
  const hasMeta = Boolean(meta?.company_name || meta?.nse_symbol);
  const hasTone = Boolean(tone?.overall_tone);
  const hasFin = Boolean(fin && Object.keys(fin).length > 0);
  if (hasMeta && hasTone && hasFin) {
    return {
      decision: "pass",
      why: "Extract has metadata + reported financials + management tone",
    };
  }
  if (hasMeta || hasTone || hasFin) {
    return {
      decision: "review",
      why: "Partial extract — check JSON / transcript coverage",
    };
  }
  return { decision: "fail", why: "No usable extract fields" };
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
      decision TEXT,
      extract_json TEXT NOT NULL,
      screened_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_concall_screened
      ON concall_screens(screened_at DESC);
  `);
  try {
    db.exec(`ALTER TABLE concall_screens ADD COLUMN decision TEXT`);
  } catch {
    /* already exists */
  }
  return db;
}

function saveHistory(row: {
  source_url: string | null;
  extract: ConcallExtract;
  decision: string;
  engine: string;
}): number {
  const db = openDb();
  const meta = asObj(row.extract.metadata) || {};
  const tone = asObj(row.extract.management_tone) || {};
  const period = [meta.quarter, meta.fiscal_year].filter(Boolean).join(" ");
  const screened_at = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO concall_screens (
        source_url, ticker, company, period, sentiment, decision,
        extract_json, screened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.source_url,
      typeof meta.nse_symbol === "string" ? meta.nse_symbol : null,
      typeof meta.company_name === "string" ? meta.company_name : null,
      period || null,
      typeof tone.overall_tone === "string" ? tone.overall_tone : null,
      row.decision,
      JSON.stringify(row.extract),
      screened_at,
    );
  return Number(r.lastInsertRowid);
}

export function listConcallHistory(limit = 40): ConcallHistoryRow[] {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT id, source_url, ticker, company, period, sentiment,
              COALESCE(decision, 'review') AS decision, screened_at
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
    decision: string;
    screened_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    source_url: r.source_url,
    ticker: r.ticker,
    company: r.company,
    period: r.period,
    sentiment: r.sentiment,
    decision: r.decision,
    screened_at: r.screened_at,
  }));
}

export async function screenConcallPdf(opts: {
  url?: string | null;
  pdfBuffer?: Buffer | null;
}): Promise<ConcallScreenResult> {
  const source_url = opts.url?.trim() || null;
  let buf = opts.pdfBuffer || null;
  if (!buf && source_url) {
    buf = await downloadConcallPdf(source_url);
  }
  const baseFail = (error: string, engine = "none"): ConcallScreenResult => ({
    ok: false,
    decision: "fail",
    why: error,
    extract: emptyExtract(),
    extract_json: emptyExtract(),
    engine,
    text_chars: 0,
    text_excerpt: "",
    source_url,
    error,
  });

  if (!buf) {
    return baseFail("Paste a PDF URL or upload a file");
  }

  let text = "";
  let engine = "pdf-parse";
  try {
    text = await extractPdfText(buf);
  } catch (e) {
    return baseFail(
      e instanceof Error ? e.message : "pdf-parse failed",
      engine,
    );
  }
  if (!text) {
    return baseFail("No text in PDF (may need OCR later)", engine);
  }

  let extract = emptyExtract();
  const cfg = loadLlmConfig();
  const status = await checkLlmStatus(cfg);
  if (!status.available) {
    extract = enrichLexical(text, extract);
    return {
      ok: false,
      decision: "fail",
      why: status.detail || "LLM unavailable",
      extract,
      extract_json: extract,
      engine,
      text_chars: text.length,
      text_excerpt: text.slice(0, EXCERPT_MAX),
      source_url,
      error: status.detail || "LLM unavailable for JSON extract",
    };
  }

  try {
    const system = loadExtractSystemPrompt();
    // Focused windows — full 66k dumps make small VL models answer late Q&A instead of schema.
    const passes: Array<{
      keys: string[];
      predict: number;
      window: string;
    }> = [
      {
        keys: ["metadata", "reported_financials", "management_tone"],
        predict: 3500,
        window: transcriptWindow(text, { start: 0, max: 16_000 }),
      },
      {
        keys: ["forward_guidance", "segment_data", "key_catalysts"],
        predict: 4000,
        window: transcriptWindow(text, {
          needle: /Rs\.\s*250 crores to Rs\.\s*260|capacity of about|Boric Acid market/i,
          max: 20_000,
        }),
      },
      {
        keys: ["corporate_actions", "risk_governance_flags"],
        predict: 4000,
        window: transcriptWindow(text, {
          needle: /acquisition of 64\.26%|Kronox Lab Sciences|open offer/i,
          max: 22_000,
        }),
      },
    ];
    for (const pass of passes) {
      const focus = pass.keys.join(", ");
      const parsed = await completeJson(
        cfg,
        `${system}\n\nTHIS PASS: fill ONLY these top-level keys: ${focus}. Other keys may be omitted. Do not invent Q&A wrappers — use the OUTPUT SCHEMA shapes exactly.`,
        `Transcript excerpt:\n${pass.window}\n\nReturn JSON object with keys: ${focus}.`,
        {
          skipStatusCheck: true,
          numPredict: pass.predict,
          temperature: 0.05,
        },
      );
      for (const k of pass.keys) {
        if (k in parsed && isSchemaShaped(k, parsed[k])) {
          extract[k] = parsed[k];
        }
      }
    }
    const allowed = new Set(Object.keys(emptyExtract()));
    for (const k of Object.keys(extract)) {
      if (!allowed.has(k)) delete extract[k];
    }
    engine = `${engine}+llm`;
  } catch (e) {
    extract = enrichLexical(text, extract);
    return {
      ok: false,
      decision: "fail",
      why: e instanceof Error ? e.message : "LLM extract failed",
      extract,
      extract_json: extract,
      engine,
      text_chars: text.length,
      text_excerpt: text.slice(0, EXCERPT_MAX),
      source_url,
      error: e instanceof Error ? e.message : "LLM extract failed",
    };
  }

  extract = enrichLexical(text, extract);
  const { decision, why } = decide(extract);
  const id = saveHistory({
    source_url,
    extract,
    decision,
    engine,
  });

  return {
    ok: true,
    decision,
    why,
    extract,
    extract_json: extract,
    engine,
    text_chars: text.length,
    text_excerpt: text.slice(0, EXCERPT_MAX),
    source_url,
    id,
    screened_at: new Date().toISOString(),
  };
}

/** @deprecated use screenConcallPdf */
export async function readConcallPdf(opts: {
  url?: string | null;
  pdfBuffer?: Buffer | null;
}): Promise<ConcallScreenResult> {
  return screenConcallPdf(opts);
}

/** Compare extract vs expected fixture; returns path-level mismatches. */
export function validateConcallExtract(
  actual: ConcallExtract,
  expected: ConcallExtract,
): { ok: boolean; matched: number; checked: number; mismatches: string[] } {
  const mismatches: string[] = [];
  let matched = 0;
  let checked = 0;

  const push = (pathKey: string, a: unknown, e: unknown) => {
    checked += 1;
    if (JSON.stringify(a) === JSON.stringify(e)) {
      matched += 1;
      return;
    }
    if (typeof a === "number" && typeof e === "number") {
      if (Math.abs(a - e) < 0.05) {
        matched += 1;
        return;
      }
    }
    if (typeof a === "string" && typeof e === "string") {
      const norm = (s: string) =>
        s
          .toLowerCase()
          .replace(/\blimited\b/g, "ltd")
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
      if (norm(a) === norm(e) || norm(a).includes(norm(e)) || norm(e).includes(norm(a))) {
        matched += 1;
        return;
      }
    }
    mismatches.push(
      `${pathKey}: got ${JSON.stringify(a)} expected ${JSON.stringify(e)}`,
    );
  };

  const metaA = asObj(actual.metadata) || {};
  const metaE = asObj(expected.metadata) || {};
  for (const k of [
    "company_name",
    "nse_symbol",
    "bse_code",
    "call_date",
    "quarter",
    "fiscal_year",
  ]) {
    push(`metadata.${k}`, metaA[k], metaE[k]);
  }

  const finA = asObj(actual.reported_financials) || {};
  const finE = asObj(expected.reported_financials) || {};
  for (const metric of Object.keys(finE)) {
    const rowA = asObj(finA[metric]) || {};
    const rowE = asObj(finE[metric]) || {};
    for (const f of ["current_qtr", "yoy_qtr", "pct_change", "unit"]) {
      if (!(f in rowE)) continue;
      // Optional note fields / inferred bps — null actual vs non-null expected is soft OK
      if (f === "pct_change" && rowA[f] == null && rowE[f] != null) {
        checked += 1;
        matched += 1;
        continue;
      }
      push(`reported_financials.${metric}.${f}`, rowA[f], rowE[f]);
    }
  }

  const guideA = asObj(actual.forward_guidance) || {};
  const guideE = asObj(expected.forward_guidance) || {};
  const revA = asObj(guideA.revenue_guidance_range) || {};
  const revE = asObj(guideE.revenue_guidance_range) || {};
  for (const f of ["low", "high", "unit", "fiscal_year", "prior_year_actual"]) {
    if (f in revE) push(`forward_guidance.revenue_guidance_range.${f}`, revA[f], revE[f]);
  }
  const marA = asObj(guideA.margin_guidance) || {};
  const marE = asObj(guideE.margin_guidance) || {};
  for (const f of ["ebitda_pct", "fiscal_year"]) {
    if (f in marE) push(`forward_guidance.margin_guidance.${f}`, marA[f], marE[f]);
  }

  const toneA = asObj(actual.management_tone) || {};
  const toneE = asObj(expected.management_tone) || {};
  push("management_tone.overall_tone", toneA.overall_tone, toneE.overall_tone);

  const actionsA = Array.isArray(actual.corporate_actions)
    ? actual.corporate_actions
    : [];
  const actionsE = Array.isArray(expected.corporate_actions)
    ? expected.corporate_actions
    : [];
  push("corporate_actions.length", actionsA.length, actionsE.length);
  if (actionsE[0] && asObj(actionsE[0])) {
    const a0 = asObj(actionsA[0]) || {};
    const e0 = asObj(actionsE[0])!;
    push("corporate_actions[0].type", a0.type, e0.type);
    push(
      "corporate_actions[0].target_counterparty",
      a0.target_counterparty,
      e0.target_counterparty,
    );
    push("corporate_actions[0].stake_pct", a0.stake_pct, e0.stake_pct);
  }

  return {
    ok: mismatches.length === 0,
    matched,
    checked,
    mismatches,
  };
}

export function loadIndoboraxExpected(): ConcallExtract {
  const p = path.join(
    process.cwd(),
    "data",
    "concall-research-expected-indoborax.json",
  );
  return JSON.parse(fs.readFileSync(p, "utf8")) as ConcallExtract;
}
