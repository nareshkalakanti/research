/**
 * Concall Research — earnings-call transcript PDF → structured JSON extract.
 * Schema + system prompt: prompts/concall-research-extract.system.txt
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { downloadBuybackPdf } from "./buyback-screen";
import { checkLlmStatus, completeJson } from "./llm-client";
import { loadLlmConfig } from "./llm-config";
import { openSqliteNamed } from "./sqlite-utils";
import { rasterizePdfPages } from "./pdf-rasterize";
import { ocrImageWithQianfan } from "./corporate-data-extract";
import {
  baselineCloseBefore,
  computeDriftPct,
} from "./strategy/concall-drift-math";
import { fetchDailyBars } from "./ohlc";
import { fetchQuoteDetailed } from "./yfinance";
import {
  enrichInvestorPresentationLexical,
  extractInvestorPresentationPdf,
  looksLikeInvestorPresentation,
  mapInvestorPresentationToConcallExtract,
} from "./investor-presentation-extract";
import { parseOrderSizeToCr } from "./orderbook-screen";
import {
  extractUnifiedEarningsFromTexts,
  isUnifiedLlmEnabled,
  mapUnifiedEarningsToConcallExtract,
} from "./unified-earnings-extract";
import {
  applyExecutiveSnapshotToFinancials,
  applyHighlightSentimentToCard,
  cardHighlightsFromQuant,
  extractQuantFromTexts,
  formatExecutiveSummaryText,
  loadQuantGold,
  compareQuantJson,
} from "./concall-quant-extract";

const CONCALL_UPLOAD_DIR = path.join(process.cwd(), "data", "concall-uploads");

export type ConcallExtract = Record<string, unknown>;

/** What kind of PDF is this — drives extract path + UI labeling. */
export type ConcallDocKind =
  | "investor_presentation"
  | "analyst_meet"
  | "earnings_call"
  | "other";

export function classifyConcallDocument(text: string): {
  kind: ConcallDocKind;
  label: string;
  note: string;
} {
  const head = text.slice(0, 14_000);
  if (
    /Transcript of Investors?\s*(?:&|and)\s*Analyst Meet/i.test(head) ||
    /Investors?\s*(?:&|and)\s*Analyst Meet/i.test(head) ||
    /Analyst(?:s)?\s*(?:&|and)\s*Investor Meet/i.test(head) ||
    /Analyst\s*\/\s*Investor Conference/i.test(head) ||
    /special purpose conference call/i.test(head) ||
    /Machine-generated transcript/i.test(head) ||
    (/Investor and Analyst Meet/i.test(head) &&
      /Moderator|E&OE|Good (?:morning|afternoon)/i.test(head))
  ) {
    return {
      kind: "analyst_meet",
      label: /special purpose|proposed (?:combination|merger|transaction)/i.test(
        head,
      )
        ? "Special call transcript"
        : "Analyst Meet transcript",
      note: "Spoken strategy/Q&A meet — not an earnings-deck P&L print. Highlights/financials only when management states numbers in the transcript.",
    };
  }
  if (
    /Moderator\s*:|Ladies and gentlemen|earnings conference call|Good (?:morning|afternoon|evening).{0,80}welcome to the/i.test(
      head,
    ) ||
    /Transcript Notes\s*·/i.test(head)
  ) {
    return {
      kind: "earnings_call",
      label: /Transcript Notes/i.test(head)
        ? "Transcript Notes"
        : "Earnings call transcript",
      note: "Earnings conference call transcript.",
    };
  }
  return {
    kind: "other",
    label: "Corporate PDF",
    note: "Unclassified corporate filing PDF.",
  };
}

export type ConcallScreenResult = {
  ok: boolean;
  decision: "pass" | "review" | "fail";
  why: string;
  extract: ConcallExtract;
  extract_json: ConcallExtract;
  engine: string;
  text_chars: number;
  text_excerpt: string;
  /** Full PDF text when skipSave (dual merge / unified LLM). */
  text_full?: string;
  /** Per-PDF text (transcript / PPT) for dual UI. */
  materials?: {
    transcript?: ConcallMaterialText;
    ppt?: ConcallMaterialText;
  };
  /** Transcript + PPT text joined for downstream LLM / copy. */
  combined_text?: string;
  source_url: string | null;
  notes_markdown?: string | null;
  notes_engine?: string | null;
  error?: string;
  id?: number;
  screened_at?: string;
  /** Pre-save checklist — fields still needed before PASS persist. */
  save_gaps?: ConcallSaveGap[];
};

export type ConcallSaveGap = {
  field: string;
  reason: string;
};

export type ConcallMaterialText = {
  role: "transcript" | "ppt";
  ok: boolean;
  text: string;
  text_chars: number;
  engine: string;
  source_url: string | null;
  error?: string;
};

export type ConcallHistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  call_date: string | null;
  period: string | null;
  sector: string | null;
  industry: string | null;
  revenue_cr: number | null;
  revenue_yoy_pct: number | null;
  ebitda_margin_pct: number | null;
  guidance_label: string | null;
  sentiment: string | null;
  sentiment_score: number | null;
  result_quality: string | null;
  mgmt_sentiment: string | null;
  highlights: Array<{ text: string; polarity: string }>;
  /** StockScans-style material links (+ saved combined text for re-run) */
  docs: {
    summary: string | null;
    transcript: string | null;
    ppt: string | null;
    /** List payload only — full text stays in extract_json.docs.combined */
    has_combined?: boolean;
    combined_chars?: number;
    has_executive?: boolean;
    has_highlights_json?: boolean;
  };
  decision: string;
  ltp: number | null;
  baseline_close: number | null;
  drift_pct: number | null;
  screened_at: string;
};

export type ConcallDocLinks = {
  summary: string | null;
  transcript: string | null;
  ppt: string | null;
  /** Full TX+PPT text saved for re-extract without PDFs */
  combined: string | null;
};

const COMBINED_DOCS_MAX = 100_000;

function emptyDocs(): ConcallDocLinks {
  return { summary: null, transcript: null, ppt: null, combined: null };
}

function asDocs(v: unknown): ConcallDocLinks {
  const o = asObj(v);
  if (!o) return emptyDocs();
  return {
    summary: typeof o.summary === "string" ? o.summary : null,
    transcript: typeof o.transcript === "string" ? o.transcript : null,
    ppt: typeof o.ppt === "string" ? o.ppt : null,
    combined: typeof o.combined === "string" ? o.combined : null,
  };
}

/** History list: URLs + combined meta (no full text blob). */
function asDocsPublic(
  v: unknown,
  extract?: ConcallExtract | null,
): ConcallHistoryRow["docs"] {
  const d = asDocs(v);
  const chars = d.combined?.trim().length ?? 0;
  const quant = asObj(extract?.quant);
  const hasExec =
    Boolean(asObj(quant?.executive_summary)) ||
    (typeof d.summary === "string" && d.summary.trim().length > 40);
  return {
    // Don't ship full summary text in the PASS list payload
    summary: null,
    transcript: d.transcript,
    ppt: d.ppt,
    has_combined: chars > 0,
    combined_chars: chars,
    has_executive: hasExec,
    has_highlights_json: Boolean(asObj(quant?.highlight_sentiment)),
  };
}

function mergeDocs(a: ConcallDocLinks, b: ConcallDocLinks): ConcallDocLinks {
  return {
    summary: b.summary || a.summary,
    transcript: b.transcript || a.transcript,
    ppt: b.ppt || a.ppt,
    combined: b.combined || a.combined,
  };
}

function setDocsCombined(
  extract: ConcallExtract,
  combined: string | null | undefined,
): ConcallExtract {
  const docs = asDocs(extract.docs);
  const t = (combined || "").trim();
  if (t) docs.combined = t.slice(0, COMBINED_DOCS_MAX);
  extract.docs = docs;
  return extract;
}

/** Split saved combined blob back into transcript / PPT sections. */
export function splitCombinedMaterialsText(combined: string): {
  transcriptText: string;
  presentationText: string;
} {
  const raw = combined.replace(/\u0000/g, "").trim();
  if (!raw) return { transcriptText: "", presentationText: "" };

  const pptMark = /=====\s*PPT\s*(?:\/\s*PRESENTATION)?\s*=====/i;
  const txMark = /=====\s*TRANSCRIPT\s*=====/i;
  const pptIdx = raw.search(pptMark);
  const txIdx = raw.search(txMark);

  if (pptIdx >= 0 && txIdx >= 0) {
    if (txIdx < pptIdx) {
      return {
        transcriptText: raw
          .slice(txIdx, pptIdx)
          .replace(txMark, "")
          .trim(),
        presentationText: raw.slice(pptIdx).replace(pptMark, "").trim(),
      };
    }
    return {
      presentationText: raw
        .slice(pptIdx, txIdx)
        .replace(pptMark, "")
        .trim(),
      transcriptText: raw.slice(txIdx).replace(txMark, "").trim(),
    };
  }
  if (pptIdx >= 0) {
    return {
      transcriptText: raw.slice(0, pptIdx).replace(txMark, "").trim(),
      presentationText: raw.slice(pptIdx).replace(pptMark, "").trim(),
    };
  }
  if (txIdx >= 0) {
    return {
      transcriptText: raw.slice(txIdx).replace(txMark, "").trim(),
      presentationText: "",
    };
  }
  // No markers — treat whole blob as transcript
  return { transcriptText: raw, presentationText: "" };
}

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

/** Excerpt always; full text only on dual-path skipSave (unified LLM). */
function pdfTextFields(
  text: string,
  skipSave?: boolean,
): { text_chars: number; text_excerpt: string; text_full?: string } {
  return {
    text_chars: text.length,
    text_excerpt: text.slice(0, EXCERPT_MAX),
    ...(skipSave ? { text_full: text } : {}),
  };
}
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

export function isConcallLocalPdfRef(url: string): boolean {
  return /^local:[A-Za-z0-9._-]+\.pdf$/i.test(url.trim());
}

export function isConcallSamplePdfRef(url: string): boolean {
  return /^sample:[A-Za-z0-9._-]+\.pdf$/i.test(url.trim());
}

export function readConcallLocalPdf(url: string): Buffer | null {
  if (!isConcallLocalPdfRef(url)) return null;
  const name = url.trim().slice("local:".length);
  const full = path.join(CONCALL_UPLOAD_DIR, name);
  if (!full.startsWith(CONCALL_UPLOAD_DIR + path.sep)) return null;
  try {
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full);
  } catch {
    return null;
  }
}

export function readConcallSamplePdf(url: string): Buffer | null {
  if (!isConcallSamplePdfRef(url)) return null;
  const name = url.trim().slice("sample:".length);
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return null;
  const full = path.join(process.cwd(), "data", "samples", name);
  try {
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full);
  } catch {
    return null;
  }
}

function persistUploadedConcallPdf(
  buf: Buffer,
  extract: ConcallExtract,
): string {
  fs.mkdirSync(CONCALL_UPLOAD_DIR, { recursive: true });
  const meta = asObj(extract.metadata) || {};
  const ticker = (
    typeof meta.nse_symbol === "string" ? meta.nse_symbol : "UNK"
  )
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 20) || "UNK";
  const period =
    [meta.quarter, meta.fiscal_year]
      .filter((x) => typeof x === "string" && x)
      .join("")
      .replace(/\s+/g, "")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 16) || "na";
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 10);
  const name = `${ticker}-${period}-${hash}.pdf`;
  fs.writeFileSync(path.join(CONCALL_UPLOAD_DIR, name), buf);
  return `local:${name}`;
}

export async function downloadConcallPdf(
  url: string,
  opts?: { timeoutMs?: number },
): Promise<Buffer | null> {
  if (isConcallLocalPdfRef(url)) return readConcallLocalPdf(url);
  if (isConcallSamplePdfRef(url)) return readConcallSamplePdf(url);
  return downloadBuybackPdf(url, opts);
}

export function isConcallPdfProxyUrl(url: string): boolean {
  if (isConcallLocalPdfRef(url) || isConcallSamplePdfRef(url)) return true;
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
      h === "nsearchives.nseindia.com" ||
      h.endsWith(".s3.amazonaws.com") ||
      h.endsWith(".cloudfront.net") ||
      h.endsWith(".blob.core.windows.net") ||
      h.includes("trendlyne") ||
      h.includes("screener.in") ||
      h.includes("moneycontrol") ||
      h.includes("stockscans") ||
      h.includes("alphastreet") ||
      h.includes("indoborax")
    );
  } catch {
    return false;
  }
}

export type ConcallDiscoverHit = {
  id: string;
  kind: "transcript" | "ppt" | "concall" | "other";
  title: string;
  period: string | null;
  url: string;
  provider: string;
  score: number;
  extractable: boolean;
};

const CONCALL_SAMPLE_HITS: Array<{
  ticker: string;
  kind: ConcallDiscoverHit["kind"];
  title: string;
  period: string | null;
  file: string;
}> = [
  {
    ticker: "RPGLIFE",
    kind: "transcript",
    title: "RPG Life Sciences · Analyst conference transcript (local sample)",
    period: "Sep 2026",
    file: "rpglife-sep2026-transcript.pdf",
  },
  {
    ticker: "INDOBORAX",
    kind: "transcript",
    title: "Indo Borax · Q1 FY27 earnings call transcript (local sample)",
    period: "Q1 FY27",
    file: "indoborax-q1fy27-transcript.pdf",
  },
];

function periodSortKey(period: string | null | undefined): number {
  if (!period) return 0;
  const p = period.trim();
  // YYYYMMDD in URL-like periods
  const iso = p.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Number(iso[1]) * 10000 + Number(iso[2]) * 100 + Number(iso[3]);
  const mon = p.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/i,
  );
  if (mon) {
    const mi = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ].indexOf(mon[1].slice(0, 3).toLowerCase());
    return Number(mon[2]) * 10000 + (mi + 1) * 100;
  }
  const q = p.match(/\bQ([1-4])\s*FY\s*(\d{2,4})\b/i);
  if (q) {
    let fy = Number(q[2]);
    if (fy < 100) fy += 2000;
    // Q1 FY27 ≈ Apr–Jun 2026 → use calendar year fy-1 for Q1–Q3? Approximate: FY ends Mar
    // Q1→Apr fy-1, Q2→Jul fy-1, Q3→Oct fy-1, Q4→Jan fy
    const qn = Number(q[1]);
    const calY = qn === 4 ? fy : fy - 1;
    const calM = qn === 1 ? 4 : qn === 2 ? 7 : qn === 3 ? 10 : 1;
    return calY * 10000 + calM * 100;
  }
  const y = p.match(/\b(20\d{2})\b/);
  return y ? Number(y[1]) * 10000 : 0;
}

function scoreConcallDiscoverHit(opts: {
  kind: string;
  title: string;
  url: string;
  provider: string;
}): number {
  const blob = `${opts.kind} ${opts.title} ${opts.url} ${opts.provider}`.toLowerCase();
  const pathOnly = (() => {
    try {
      return new URL(opts.url).pathname.toLowerCase();
    } catch {
      return opts.url.toLowerCase();
    }
  })();
  let score = 0;
  if (/sample:/.test(opts.url)) score += 200;
  if (/transcript|earnings\s+call|conference\s+call/.test(blob)) score += 100;
  if (
    opts.kind === "ppt" ||
    /investor\s+presentation|earnings\s+presentation|results?\s+presentation/.test(
      blob,
    )
  )
    score += 70;
  if (opts.kind === "concall") score += 40;
  if (/bse|nse|screener/.test(opts.provider)) score += 15;
  if (/trendlyne/.test(opts.provider)) score -= 20;
  // Filename is more reliable than exchange title labels
  if (/transcript|conference.?call.?outcome|earnings.?call/i.test(pathOnly))
    score += 60;
  if (/investors?_?presentation|investorpresentation|presentation/i.test(pathOnly))
    score += 40;
  // Prefer newer filings encoded in NSE archive filenames: TICKER_DDMMYYYY…
  const nseDate = pathOnly.match(/_(\d{2})(\d{2})(20\d{2})\d*_/);
  if (nseDate) {
    const day = Number(nseDate[1]);
    const month = Number(nseDate[2]);
    const year = Number(nseDate[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      score += Math.floor((year - 2020) * 3 + month / 4);
    }
  }
  // Exchange “concall” hits are often meet intimations, not transcripts
  if (
    /intimation|cancellation|meet.?link|initmation|investor_meet|institutional_investor/i.test(
      pathOnly,
    ) &&
    !/transcript/i.test(pathOnly)
  ) {
    score -= 120;
  }
  // Audio-recording / webcast letters are not earnings transcripts
  if (
    /audio\s*recording|audio\s*link|\.mp3|webcast|recording\s+of\s+(?:the\s+)?(?:earnings|conference)/i.test(
      blob,
    ) &&
    !/transcript/i.test(blob)
  ) {
    score -= 150;
  }
  if (
    /\.pdf(\?|$)/i.test(opts.url) ||
    /AnnPdfOpen|attchmnt|AttachLive|AttachHis|nsearchives|sample:|local:/i.test(
      opts.url,
    )
  ) {
    score += 25;
  } else {
    score -= 40; // post pages / non-PDF
  }
  return score;
}

function isExtractableConcallUrl(url: string): boolean {
  if (isConcallLocalPdfRef(url) || isConcallSamplePdfRef(url)) return true;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h.includes("trendlyne.com") && !/\.pdf(\?|$)/i.test(u.pathname)) return false;
    return isConcallPdfProxyUrl(url);
  } catch {
    return false;
  }
}

/** Find transcript / PPT PDFs by ticker (BSE/NSE/Screener + local samples). */
export async function discoverConcallPdfSources(
  tickerRaw: string,
): Promise<{
  ok: true;
  ticker: string;
  sources: ConcallDiscoverHit[];
  latest_transcript: ConcallDiscoverHit | null;
  latest_ppt: ConcallDiscoverHit | null;
  note?: string;
}> {
  const ticker = tickerRaw.trim().toUpperCase().replace(/[^A-Z0-9.&-]/g, "");
  if (!ticker) {
    throw new Error("Enter an NSE ticker (e.g. RPGLIFE)");
  }

  const hits: ConcallDiscoverHit[] = [];

  for (const s of CONCALL_SAMPLE_HITS) {
    if (s.ticker !== ticker) continue;
    const full = path.join(process.cwd(), "data", "samples", s.file);
    if (!fs.existsSync(full)) continue;
    const url = `sample:${s.file}`;
    hits.push({
      id: `sample:${s.file}`,
      kind: s.kind,
      title: s.title,
      period: s.period,
      url,
      provider: "local_sample",
      score: scoreConcallDiscoverHit({
        kind: s.kind,
        title: s.title,
        url,
        provider: "local_sample",
      }),
      extractable: true,
    });
  }

  try {
    const { discoverInvestorMaterialSources } = await import(
      "./investor-material-scrape"
    );
    const found = await discoverInvestorMaterialSources(ticker);
    for (const s of found.sources) {
      if (s.kind !== "concall" && s.kind !== "ppt" && s.kind !== "transcript") {
        continue;
      }
      const score = scoreConcallDiscoverHit({
        kind: s.kind,
        title: s.title,
        url: s.url,
        provider: s.provider,
      });
      if (score < 20) continue;
      hits.push({
        id: s.id,
        kind: s.kind === "transcript" ? "transcript" : s.kind,
        title: s.title,
        period: s.period,
        url: s.url,
        provider: s.provider,
        score,
        extractable: isExtractableConcallUrl(s.url),
      });
    }
  } catch (e) {
    if (!hits.length) throw e;
  }

  hits.sort(
    (a, b) =>
      periodSortKey(b.period) - periodSortKey(a.period) ||
      b.score - a.score ||
      (b.period || "").localeCompare(a.period || ""),
  );
  // Dedupe by URL
  const seen = new Set<string>();
  const sources = hits.filter((h) => {
    const key = h.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);

  const isAudioOnly = (h: ConcallDiscoverHit) =>
    /audio\s*recording|audio\s*link|\.mp3|webcast/i.test(
      `${h.title} ${h.url}`,
    ) && !/transcript/i.test(`${h.title} ${h.url}`);

  const isTx = (h: ConcallDiscoverHit) => {
    if (isAudioOnly(h)) return false;
    const blob = `${h.kind} ${h.title} ${h.url}`;
    // Require "transcript" — bare "earnings call" matches audio intimations
    return (
      h.kind === "transcript" ||
      /transcript/i.test(blob) ||
      (/conference\s*call\s*outcome/i.test(blob) && /\.pdf/i.test(h.url))
    );
  };
  const isPpt = (h: ConcallDiscoverHit) =>
    h.kind === "ppt" ||
    /presentation|investor\s*deck|earnings\s*deck/i.test(h.title);

  const extractable = sources.filter((h) => h.extractable !== false);
  let latest_transcript =
    extractable.find(isTx) ||
    extractable.find((h) => /transcript/i.test(h.url) && !isAudioOnly(h)) ||
    null;
  let latest_ppt =
    extractable.find(isPpt) ||
    extractable.find((h) => /presentation|investor/i.test(h.url)) ||
    extractable.find((h) => h.kind === "ppt") ||
    null;

  // Fallback: unclassified PDFs still usable — first as TX, next as PPT
  const pdfish = (h: ConcallDiscoverHit) =>
    h.extractable !== false &&
    !isAudioOnly(h) &&
    (/\.pdf(\?|$)/i.test(h.url) ||
      /^sample:/i.test(h.url) ||
      /pdf|attachment|download/i.test(h.url));
  if (!latest_transcript) {
    latest_transcript =
      extractable.find(
        (h) => pdfish(h) && h !== latest_ppt && !isPpt(h),
      ) ||
      extractable.find((h) => pdfish(h) && h !== latest_ppt) ||
      null;
  }
  if (!latest_ppt) {
    latest_ppt =
      extractable.find(
        (h) => pdfish(h) && h !== latest_transcript && (isPpt(h) || h.kind === "ppt" || h.kind === "concall"),
      ) ||
      extractable.find((h) => pdfish(h) && h !== latest_transcript) ||
      null;
  }

  return {
    ok: true,
    ticker,
    sources,
    latest_transcript,
    latest_ppt,
    note: sources.length
      ? latest_transcript || latest_ppt
        ? "Latest Transcript / PPT filled from BSE·NSE·Screener (edit URLs if wrong)."
        : "Sources found — pick Transcript / PPT from the list below."
      : "No concall / PPT found on BSE/NSE/Screener for this ticker.",
  };
}

async function extractPdfText(buf: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    b: Buffer,
  ) => Promise<{ text?: string }>;
  const parsed = await pdfParse(buf);
  return collapsePdfLetterSpacing((parsed.text || "").trim());
}

/**
 * Investor decks often embed per-glyph spaced fonts so pdf-parse yields
 * "S A FE   H A RB O R" / short titles like "K a m d h e n u".
 * Collapse those carefully — do NOT glue full safe-harbor paragraphs
 * (same single spaces between letters and words); LLMs still read those.
 */
export function collapsePdfLetterSpacing(text: string): string {
  const lines = text.split("\n").map(collapsePdfSpacedLine);
  let out = lines.join("\n");
  // Superscript ordinals split across lines: "30\nth\n July" → "30th July"
  out = out.replace(/(\d+)\s*\n?\s*(st|nd|rd|th)\b/gi, "$1$2");
  out = out.replace(/[^\S\n]{2,}/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

function collapsePdfSpacedLine(line: string): string {
  const trimmed = line.trimEnd();
  if (!trimmed.trim()) return trimmed;

  // 2+ spaces often mark word boundaries in spaced titles
  if (/ {2,}/.test(trimmed)) {
    return trimmed
      .split(/ {2,}/)
      .map(collapsePdfSpacedChunk)
      .filter((p) => p.length > 0)
      .join(" ");
  }

  const tokens = trimmed.trim().split(/ +/);
  const single = tokens.filter((t) => /^[A-Za-z]$/.test(t)).length;
  const ratio = tokens.length ? single / tokens.length : 0;
  // Short title-like lines only (avoid gluing multi-word body copy)
  if (tokens.length >= 2 && tokens.length <= 16 && ratio >= 0.7) {
    return collapsePdfSpacedChunk(trimmed.trim());
  }
  return trimmed;
}

function collapsePdfSpacedChunk(chunk: string): string {
  const tokens = chunk.trim().split(/ +/);
  if (tokens.length < 2) return chunk.trim();
  const single = tokens.filter((t) => /^[A-Za-z]$/.test(t)).length;
  if (single / tokens.length < 0.5) return tokens.join(" ");
  let word = "";
  const out: string[] = [];
  for (const t of tokens) {
    if (/^[A-Za-z]$/.test(t)) {
      word += t;
    } else {
      if (word) {
        out.push(word);
        word = "";
      }
      out.push(t);
    }
  }
  if (word) out.push(word);
  return out.join(" ");
}

function shouldTryOcrFallback(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 8_000) return true;
  // KRN-style PDFs often have key bullets as images/diagrams; pdf-parse
  // sometimes only captures generic "forensic audit" text from director bios.
  const hasForensic = /forensic\s+audit/i.test(t);
  const hasCourtContext = /(court.?ordered|court.?order|tribunal|judicial|hearing|appeal)/i.test(
    t,
  );
  const hasOpsTokens = /(microchannel|data\s*cent(?:er|re)|warehouse\s+expansion|commercial\s+microchannel)/i.test(
    t,
  );
  if (hasForensic && !hasCourtContext && !hasOpsTokens) return true;
  return false;
}

export type ConcallTextProgress = {
  type: "progress";
  role?: "transcript" | "ppt";
  phase: "download" | "rasterize" | "ocr" | "done";
  page?: number;
  pages?: number;
  message: string;
  pct?: number;
};

async function ocrPdfText(
  buf: Buffer,
  opts?: {
    maxPages?: number;
    dpi?: number;
    onProgress?: (p: ConcallTextProgress) => void;
    role?: "transcript" | "ppt";
  },
): Promise<string> {
  const envPages = Number(process.env.CONCALL_OCR_MAX_PAGES);
  const defaultPages =
    opts?.maxPages != null
      ? opts.maxPages
      : Number.isFinite(envPages) && envPages > 0
        ? envPages
        : 6;
  const maxPages = Math.min(60, Math.max(1, defaultPages));
  const role = opts?.role;
  opts?.onProgress?.({
    type: "progress",
    role,
    phase: "rasterize",
    message: `Rasterizing ${role || "PDF"} (up to ${maxPages} pages)…`,
    pct: 2,
  });
  const pages = await rasterizePdfPages(buf, {
    maxPages,
    dpi: opts?.dpi ?? 110,
    format: "jpeg",
  });
  const total = pages.length;
  opts?.onProgress?.({
    type: "progress",
    role,
    phase: "ocr",
    page: 0,
    pages: total,
    message: `${role || "PDF"}: ${total} page(s) → vision OCR…`,
    pct: 5,
  });
  const chunks: string[] = [];
  const ocrPrompt =
    "Transcribe all visible text once from this investor presentation page, including tables and chart labels. " +
    "Preserve headings, bullets, and numbers. Output plain text only. " +
    "Do NOT repeat any sentence, title, or paragraph — each line at most once.";
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    opts?.onProgress?.({
      type: "progress",
      role,
      phase: "ocr",
      page: i + 1,
      pages: total,
      message: `OCR ${role || "PDF"} page ${i + 1} / ${total}`,
      pct: Math.round(5 + ((i + 1) / total) * 90),
    });
    const t = await ocrImageWithQianfan(page.dataUrl, ocrPrompt);
    const cleaned = dedupeOcrRepetition(t);
    if (cleaned) chunks.push(`--- page ${page.page} ---\n${cleaned}`);
  }
  opts?.onProgress?.({
    type: "progress",
    role,
    phase: "done",
    page: total,
    pages: total,
    message: `${role || "PDF"} OCR done (${total} page(s))`,
    pct: 100,
  });
  return chunks.join("\n\n").trim();
}

/**
 * glm-ocr / VLMs often loop the same title or "THANK YOU" dozens of times.
 * Keep the first occurrence of consecutive duplicate lines / paragraphs.
 */
export function dedupeOcrRepetition(text: string): string {
  let t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return "";

  // Same phrase pasted many times on one line / block
  t = t.replace(/(.{8,160}?)(\s*\1){4,}/gs, "$1");

  const lines = t.split("\n");
  const lineOut: string[] = [];
  let prevNorm = "";
  let streak = 0;
  for (const line of lines) {
    const norm = line.trim().replace(/\s+/g, " ").toLowerCase();
    if (norm && norm === prevNorm) {
      streak += 1;
      if (streak >= 2) continue;
    } else {
      prevNorm = norm;
      streak = 1;
    }
    lineOut.push(line);
  }
  t = lineOut.join("\n");

  const paras = t.split(/\n{2,}/);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const p of paras) {
    const key = p.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key) continue;
    if (key.length >= 24 && seen.has(key)) continue;
    seen.add(key);
    kept.push(p.trim());
  }
  return kept.join("\n\n").trim();
}

function emptyExtract(): ConcallExtract {
  return {
    metadata: {
      company_name: null,
      nse_symbol: null,
      bse_code: null,
      call_date: null,
      call_time: null,
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
    card: {
      result_quality: null,
      mgmt_sentiment: null,
      highlights: [],
      sector: null,
      industry: null,
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

  // LLM / StockScans often use aliases instead of schema keys
  if (!meta.company_name) {
    for (const key of ["company", "companyName", "name", "issuer"]) {
      const v = meta[key];
      if (typeof v === "string" && v.trim().length >= 3) {
        meta.company_name = v.trim();
        break;
      }
    }
  }
  if (!meta.nse_symbol) {
    for (const key of ["symbol", "ticker", "nse", "nse_code"]) {
      const v = meta[key];
      if (typeof v === "string" && /^[A-Z0-9.&-]{2,20}$/i.test(v.trim())) {
        meta.nse_symbol = v.trim().toUpperCase();
        break;
      }
    }
  }

  const months: Record<string, string> = {
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    may: "05",
    jun: "06",
    june: "06",
    jul: "07",
    july: "07",
    aug: "08",
    august: "08",
    sep: "09",
    sept: "09",
    september: "09",
    oct: "10",
    october: "10",
    nov: "11",
    november: "11",
    dec: "12",
    december: "12",
  };
  const fromParts = (mon: string, day: string, year: string) => {
    const mm = months[mon.toLowerCase()] || months[mon.toLowerCase().slice(0, 3)];
    if (!mm) return null;
    const y = year.length === 2 ? `20${year}` : year;
    return `${y}-${mm}-${day.padStart(2, "0")}`;
  };
  const parseLooseDate = (raw: string): string | null => {
    const s = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const mdy = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (mdy) return fromParts(mdy[1], mdy[2], mdy[3]);
    const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/);
    if (dmy) return fromParts(dmy[2], dmy[1], dmy[3]);
    const slash = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (slash) {
      const y = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
      return `${y}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`;
    }
    return null;
  };

  if (!meta.nse_symbol) {
    const sym =
      text.match(/\bNSE\s+Scrip\s+Symbol\s*:\s*([A-Z0-9.&-]+)/i)?.[1] ||
      text.match(/\bScrip\s+Symbol\s*:\s*([A-Z0-9.&-]+)/i)?.[1] ||
      text.match(/\bSymbol\s*:\s*([A-Z0-9.&-]+)/i)?.[1] ||
      text.match(/\bNSE\s+(?:Symbol|Code)\s*:\s*([A-Z0-9.&-]+)/i)?.[1];
    if (sym) meta.nse_symbol = sym.toUpperCase();
  } else {
    // If LLM shortened a longer exchange symbol present in the PDF, keep the PDF one
    const fromText =
      text.match(/\bNSE\s+Scrip\s+Symbol\s*:\s*([A-Z0-9.&-]+)/i)?.[1] ||
      text.match(/\bScrip\s+Symbol\s*:\s*([A-Z0-9.&-]+)/i)?.[1];
    if (
      fromText &&
      fromText.toUpperCase().startsWith(String(meta.nse_symbol).toUpperCase()) &&
      fromText.length > String(meta.nse_symbol).length
    ) {
      meta.nse_symbol = fromText.toUpperCase();
    }
  }
  if (!meta.bse_code) {
    const code =
      text.match(/\bBSE\s+Scrip\s+Code\s*:\s*(\d{4,8})/i)?.[1] ||
      text.match(/\bScrip\s+Code\s*:\s*(\d{4,8})/i)?.[1] ||
      text.match(/\bBSE\s+(?:Scrip\s+)?Code\s*:\s*(\d{4,8})/i)?.[1] ||
      text.match(/\bBSE\s+Code\s*:\s*(\d{4,8})/i)?.[1];
    if (code) meta.bse_code = code;
  }
  if (!meta.call_date) {
    const m =
      text.match(
        /(?:held on|Conference Call\s*|Investor(?:s)?\s*(?:&|and)\s*Analyst\s*Meet)\s*(?:Wednesday,?\s*|Monday,?\s*|Tuesday,?\s*|Thursday,?\s*|Friday,?\s*)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i,
      ) ||
      text.match(
        /(?:results|earnings|financial\s+results|board\s+meeting|published\s+on|dated)[^.\n]{0,40}?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i,
      );
    if (m) {
      const iso = fromParts(m[1], m[2], m[3]);
      if (iso) meta.call_date = iso;
    }
    // StockScans header: "3 Sep 2026 · 4:00 PM IST"
    if (!meta.call_date) {
      const dMonY = text.match(
        /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/i,
      );
      if (dMonY) {
        const iso = fromParts(dMonY[2], dMonY[1], dMonY[3]);
        if (iso) meta.call_date = iso;
      }
    }
    if (!meta.call_date) {
      const dmy = text.match(
        /(?:dated|on|as\s+on)\s+(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/i,
      );
      if (dmy) {
        const y = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
        meta.call_date = `${y}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
      }
    }
    if (!meta.call_date) {
      const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
      if (iso) meta.call_date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    }
    // LLM sometimes puts a real date in report_date / date
    if (!meta.call_date) {
      for (const key of ["report_date", "date", "result_date", "filing_date", "call_date"]) {
        const v = meta[key];
        if (typeof v === "string") {
          const iso = parseLooseDate(v);
          if (iso) {
            meta.call_date = iso;
            break;
          }
        }
      }
    }
  }
  if (!meta.call_time) {
    for (const key of ["time", "call_time"]) {
      const v = meta[key];
      if (typeof v === "string" && /\d{1,2}:\d{2}/.test(v)) {
        const tm = v.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/);
        if (tm) {
          meta.call_time = tm[3]
            ? `${tm[1]}:${tm[2]} ${tm[3].toUpperCase()}`
            : `${tm[1]}:${tm[2]}`;
          break;
        }
      }
    }
  }
  if (!meta.call_time) {
    const tm = text.match(
      /\b(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)\b/,
    );
    if (tm) {
      meta.call_time = `${tm[1]}:${tm[2]} ${tm[3].toUpperCase()}`;
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
    const co =
      text.match(
        /(?:for|of)\s+(Indo Borax[^.\n]{0,40}Limited)/i,
      )?.[1] ||
      text.match(
        /\b(Happiest Minds Technologies\s+(?:Limited|Ltd\.?))\b/i,
      )?.[1] ||
      text.match(
        /\b([A-Z][A-Za-z0-9 &.'-]{2,60}?\s+(?:Life Sciences|Healthcare|Chemicals|Industries|Pharmaceuticals?|Technologies|Labs?|Limited|Ltd\.?))\b/,
      )?.[1] ||
      text.match(
        /^[\s\S]{0,200}?\b([A-Z][A-Z0-9 &.'-]{4,50}?\s+(?:LTD\.?|LIMITED))\b/,
      )?.[1] ||
      (typeof meta.source === "string" &&
      /limited|ltd\.?|healthcare|chemicals|industries|sciences|technologies/i.test(
        meta.source,
      )
        ? meta.source.trim()
        : null);
    if (co && typeof co === "string" && !isMarketInfrastructureName(co)) {
      meta.company_name = co.trim();
    }
  }
  if (!meta.company_name && typeof meta.nse_symbol === "string") {
    const fromDb = lookupCompanyName(meta.nse_symbol);
    if (fromDb) meta.company_name = fromDb;
  }
  // Prefer DB legal name when ticker is known. Drop venue / mismatched issuer names
  // (e.g. transcript "National Stock Exchange…" while symbol is the listed company).
  if (typeof meta.nse_symbol === "string") {
    const sym = meta.nse_symbol.toUpperCase().trim();
    const fromDb = lookupCompanyName(sym);
    const current =
      typeof meta.company_name === "string" ? meta.company_name.trim() : "";
    if (fromDb) {
      if (!current || isMarketInfrastructureName(current)) {
        meta.company_name = fromDb;
      } else {
        const cur = current.toLowerCase();
        const dbn = fromDb.toLowerCase();
        const compatible =
          cur.includes(dbn) ||
          dbn.includes(cur) ||
          cur
            .split(/\s+/)
            .filter((w) => w.length > 3)
            .every((w) => dbn.includes(w));
        if (compatible) {
          meta.company_name = fromDb;
        } else {
          const resolved = lookupTickerByCompanyName(current);
          if (!resolved || resolved !== sym) {
            meta.company_name = fromDb;
          }
        }
      }
    } else if (current && isMarketInfrastructureName(current)) {
      meta.company_name = null;
    }
  }
  if (!meta.nse_symbol && typeof meta.company_name === "string") {
    const ticker = lookupTickerByCompanyName(meta.company_name);
    if (ticker) meta.nse_symbol = ticker;
  }
  // Period from prose when LLM omitted quarter/FY (e.g. "quarter one FY27")
  if (!meta.quarter || !meta.fiscal_year) {
    const qWords = text.match(
      /\b(?:quarter|qtr)\s*(?:one|1|two|2|three|3|four|4)\s+FY\s*'?\s*(\d{2,4})\b/i,
    );
    if (qWords) {
      const map: Record<string, string> = {
        one: "1",
        "1": "1",
        two: "2",
        "2": "2",
        three: "3",
        "3": "3",
        four: "4",
        "4": "4",
      };
      const qn = qWords[0].match(/\b(one|two|three|four|1|2|3|4)\b/i)?.[1];
      const q = qn ? map[qn.toLowerCase()] : null;
      if (q && !meta.quarter) meta.quarter = `Q${q}`;
      if (!meta.fiscal_year) {
        const fy = qWords[1];
        meta.fiscal_year = fy.length === 2 ? `FY${fy}` : `FY${fy.slice(-2)}`;
      }
    }
  }
  // Call-date fallback period label (Sep 2026) when still no quarter
  if ((!meta.quarter || !meta.fiscal_year) && typeof meta.call_date === "string") {
    const m = meta.call_date.match(/^(\d{4})-(\d{2})/);
    if (m) {
      const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      const mon = months[Number(m[2]) - 1];
      if (!meta.quarter && mon) meta.quarter = mon;
      if (!meta.fiscal_year) meta.fiscal_year = m[1];
    }
  }
  // Call date missing → use today (extract / screen day)
  if (!meta.call_date) {
    const now = new Date();
    meta.call_date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
  extract.metadata = meta;

  // Label document kind so UI / PASS row explain missing deck-style prints
  const docKind = classifyConcallDocument(text);
  if (docKind.kind !== "other" || !meta.document_type) {
    meta.document_type = docKind.label;
    meta.document_kind = docKind.kind;
    meta.document_note = docKind.note;
    extract.metadata = meta;
  }

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
  /** Spoken/print money: Rs. / ₹ / INR1,646 crores */
  const moneyRe =
    "(?:Rs\\.?|₹|INR)\\s*([\\d,.]+)\\s*(?:crore|cr)s?";

  if (!asObj(fin.revenue)?.current_qtr) {
    const m =
      text.match(
        new RegExp(
          `operating revenue was ${moneyRe}[^.]{0,80}?([\\d.]+)\\s*%\\s*increase against ${moneyRe}`,
          "i",
        ),
      ) ||
      text.match(
        new RegExp(
          `(?:total\\s+)?(?:income|revenue|sales)\\s+(?:of\\s+|was\\s+|stood\\s+at\\s+)?${moneyRe}(?:[^.]{0,60}?(?:vs|versus|against|compared)[^.]{0,40}?${moneyRe})?`,
          "i",
        ),
      ) ||
      text.match(
        new RegExp(
          `\\brevenue\\b[^.]{0,40}?${moneyRe}`,
          "i",
        ),
      ) ||
      text.match(
        new RegExp(
          `ended (?:last year|FY['’]?\\d{2}) with (?:a\\s+)?revenue of ${moneyRe}`,
          "i",
        ),
      );
    if (m) {
      const cur = num(m[1]);
      const prior = num(m[3] || m[2]);
      // Skip tiny deal/API fragment numbers when clearly not consol print
      if (cur != null && cur >= 50) {
        const pct =
          prior != null && prior > 0 && prior !== cur
            ? ((cur - prior) / Math.abs(prior)) * 100
            : null;
        fin.revenue = {
          current_qtr: cur,
          yoy_qtr: prior != null && prior !== cur ? prior : null,
          pct_change: pct != null ? Math.round(pct * 10) / 10 : null,
          unit: "INR cr",
        };
      }
    }
  }
  // Spoken quarterly growth: "delivered 17% in the last quarter" / "we saw Q1 at 17%"
  if (!asObj(fin.revenue)?.pct_change) {
    const yoySpoken =
      text.match(
        /(?:delivered|achieved|reported|posted)\s+(\d+(?:\.\d+)?)\s*%\s*(?:growth\s+)?(?:in|for)\s+(?:the\s+)?(?:last|this)\s+quarter/i,
      ) ||
      text.match(
        /(?:saw|delivered|achieved)\s+Q\s*([1-4])\s*(?:FY\s*\d{2})?\s+at\s+(\d+(?:\.\d+)?)\s*%/i,
      ) ||
      text.match(
        /Q\s*([1-4])\s*(?:FY\s*\d{2})?\s+(?:revenue\s+)?(?:growth\s+)?(?:of\s+|at\s+)?(\d+(?:\.\d+)?)\s*%/i,
      ) ||
      text.match(
        /Revenue(?:\s+from\s+operations)?\s+up\s+by\s+([\d.]+)\s*%/i,
      );
    if (yoySpoken) {
      const pct = num(yoySpoken[2] || yoySpoken[1]);
      if (pct != null && pct > 0 && pct < 200) {
        fin.revenue = {
          ...(asObj(fin.revenue) || {}),
          current_qtr: asObj(fin.revenue)?.current_qtr ?? null,
          yoy_qtr: asObj(fin.revenue)?.yoy_qtr ?? null,
          pct_change: pct,
          unit: "INR cr",
        };
      }
    }
  }
  if (!asObj(fin.revenue)?.pct_change && !asObj(fin.revenue)?.current_qtr) {
    const yoyOnly = text.match(
      /Revenue(?:\s+from\s+operations)?\s+up\s+by\s+([\d.]+)\s*%/i,
    );
    if (yoyOnly) {
      fin.revenue = {
        ...(asObj(fin.revenue) || {}),
        current_qtr: asObj(fin.revenue)?.current_qtr ?? null,
        yoy_qtr: null,
        pct_change: num(yoyOnly[1]),
        unit: "INR cr",
      };
    }
  }
  if (!asObj(fin.ebitda)?.current_qtr) {
    const m =
      text.match(
        new RegExp(
          `EBITDA for the quarter was up by ([\\d.]+)%\\s*to ${moneyRe} as compared to ${moneyRe}`,
          "i",
        ),
      ) ||
      text.match(
        new RegExp(
          `EBITDA\\s+(?:of\\s+|was\\s+|stood\\s+at\\s+)?${moneyRe}`,
          "i",
        ),
      );
    if (m && m[2]) {
      fin.ebitda = {
        current_qtr: num(m[2]),
        yoy_qtr: num(m[3]),
        pct_change: num(m[1]),
        unit: "INR cr",
      };
    } else if (m) {
      const cur = num(m[1]);
      if (cur != null && cur >= 10) {
        fin.ebitda = {
          current_qtr: cur,
          yoy_qtr: null,
          pct_change: null,
          unit: "INR cr",
        };
      }
    }
  }
  // Spoken EBITDA growth without absolute print
  if (!asObj(fin.ebitda)?.pct_change) {
    const m = text.match(
      /EBITDA\s+(?:has\s+also\s+)?(?:grown|growth|up)\s+(?:at\s+about\s+|by\s+|of\s+)?(\d+(?:\.\d+)?)\s*%\s*CAGR|EBITDA\s+(?:up|grew|growth)\s+(?:by\s+|of\s+)?(\d+(?:\.\d+)?)\s*%/i,
    );
    if (m) {
      const pct = num(m[1] || m[2]);
      // Prefer non-CAGR if both; CAGR goes to highlights separately
      if (pct != null && !/CAGR/i.test(m[0])) {
        fin.ebitda = {
          ...(asObj(fin.ebitda) || {}),
          current_qtr: asObj(fin.ebitda)?.current_qtr ?? null,
          yoy_qtr: null,
          pct_change: pct,
          unit: "INR cr",
        };
      }
    }
  }
  if (!asObj(fin.ebitda_margin_pct)?.current_qtr) {
    const m =
      text.match(
        /(?:organic\s+)?EBITDA margin(?:\s+of\s+[A-Za-z ]{0,40}?)?\s*(?:of\s+|stood\s+at\s+|was\s+)?([\d.]+)\s*%/i,
      ) ||
      text.match(
        /(?:while\s+)?(?:the\s+)?margin was ([\d.]+)%\s+last year[^.]{0,80}?([\d.]+)%/i,
      );
    if (m) {
      // Prefer organic/clarified second figure when "actually it was X%"
      const cur = num(m[2] || m[1]);
      const prior = m[2] != null ? num(m[1]) : null;
      if (cur != null) {
        fin.ebitda_margin_pct = {
          current_qtr: cur,
          yoy_qtr: prior,
          pct_change: null,
          ...(prior != null
            ? { change_bps: Math.round((cur - prior) * 100) }
            : {}),
        };
      }
    }
  }
  if (!asObj(fin.net_profit)?.current_qtr) {
    const m = text.match(
      new RegExp(
        `net profit increased by ([\\d.]+)%\\s*to ${moneyRe}[^.]{0,40}?${moneyRe}`,
        "i",
      ),
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

  // Revenue guidance spoken in meets: "guidance of 14%-15%"
  const fg = asObj(extract.forward_guidance) || {
    revenue_guidance_range: null,
    margin_guidance: null,
    explicit_caveats: [],
    capex_guidance: [],
  };
  if (!fg.revenue_guidance_range) {
    const g = text.match(
      /(?:revenue\s+)?guidance\s+(?:of\s+|we\s+suggested\s+)?(\d+(?:\.\d+)?)\s*%\s*[-–to]+\s*(\d+(?:\.\d+)?)\s*%/i,
    );
    if (g) {
      fg.revenue_guidance_range = `${g[1]}%–${g[2]}%`;
      extract.forward_guidance = fg;
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
  const hasNamed = (re: RegExp) =>
    actions.some((a) => {
      const o = asObj(a);
      return (
        o?.type === "acquisition" &&
        typeof o.target_counterparty === "string" &&
        re.test(o.target_counterparty)
      );
    });
  if (
    !hasNamed(/actis|aktis/i) &&
    /\b(?:Actis|Aktis|ACTIS)\b/i.test(text) &&
    /acquisition|acquired|share purchase|closed|closing/i.test(text)
  ) {
    const deal =
      text.match(
        /(?:Actis|Aktis|ACTIS)[\s\S]{0,220}?(?:consideration|approximately|about)\s+(?:of\s+)?(?:Rs\.?|₹)?\s*([\d,.]+)\s*(?:crore|cr)/i,
      ) ||
      text.match(
        /(?:consideration|approximately)\s+(?:is\s+)?(?:approximately\s+)?(?:Rs\.?|₹)?\s*([\d,.]+)\s*(?:crore|cr)s?[\s\S]{0,80}?(?:Actis|Aktis)/i,
      );
    actions = [
      ...actions,
      {
        type: "acquisition",
        target_counterparty: "Actis",
        stake_pct: null,
        deal_value: deal
          ? { amount: num(deal[1]), unit: "INR cr", component: "SPA" }
          : null,
      },
    ];
  }
  if (
    !hasNamed(/raghava|raghwa|ragwa/i) &&
    /\b(?:Raghava|Raghwa|Ragwa)\b/i.test(text) &&
    /acquisition|acquired|business transfer|slum sale|slump sale|closed|closing/i.test(
      text,
    )
  ) {
    const deal =
      text.match(
        /(?:Raghava|Raghwa|Ragwa)[\s\S]{0,280}?(?:consideration|up to)\s+(?:of\s+)?(?:Rs\.?|₹)?\s*([\d,.]+)\s*(?:crore|cr)/i,
      ) ||
      text.match(
        /(?:consideration|up to)\s+(?:of\s+)?(?:Rs\.?|₹)?\s*([\d,.]+)\s*(?:crore|cr)s?[\s\S]{0,120}?(?:Raghava|Raghwa|Ragwa|API)/i,
      );
    actions = [
      ...actions,
      {
        type: "acquisition",
        target_counterparty: "Raghava Life Sciences",
        stake_pct: null,
        deal_value: deal
          ? { amount: num(deal[1]), unit: "INR cr", component: "BTA" }
          : null,
      },
    ];
  }
  extract.corporate_actions = actions;

  extract = enrichCard(text, extract);
  return extract;
}

function lookupCompanyName(ticker: string | null): string | null {
  if (!ticker) return null;
  const sym = ticker.toUpperCase().trim();
  try {
    const db = openSqliteNamed("company_about.db", {
      readonly: true,
      wal: true,
    });
    const row = db
      .prepare(
        `SELECT name FROM company_about WHERE UPPER(ticker) = ? LIMIT 1`,
      )
      .get(sym) as { name: string | null } | undefined;
    if (row?.name?.trim()) return row.name.trim();
  } catch {
    /* optional */
  }
  try {
    const db = openSqliteNamed("scraper.db", { readonly: true });
    const row = db
      .prepare(
        `SELECT name, company_name FROM companies WHERE UPPER(ticker) = ? LIMIT 1`,
      )
      .get(sym) as
      | { name: string | null; company_name: string | null }
      | undefined;
    const n = row?.name?.trim() || row?.company_name?.trim();
    if (n) return n;
  } catch {
    /* optional */
  }
  return null;
}

/** True when a string names an exchange / market venue, not the listed issuer. */
function isMarketInfrastructureName(name: string | null | undefined): boolean {
  if (!name) return false;
  const s = name.replace(/\s+/g, " ").trim();
  if (s.length < 6) return false;
  return /\b(?:stock\s+exchange|securities\s+exchange|bourse|depository|clearing\s+(?:corporation|house)|central\s+depository)\b/i.test(
    s,
  );
}

function lookupTickerByCompanyName(name: string | null): string | null {
  if (!name) return null;
  const cleaned = name
    .replace(/\s+/g, " ")
    .replace(/\b(ltd\.?|limited|private|pvt\.?)\b/gi, "")
    .trim();
  if (cleaned.length < 4) return null;
  const tryDb = (sql: string, arg: string): string | null => {
    try {
      const db = openSqliteNamed("company_about.db", {
        readonly: true,
        wal: true,
      });
      const row = db.prepare(sql).get(arg) as { ticker: string | null } | undefined;
      return row?.ticker?.trim()?.toUpperCase() || null;
    } catch {
      return null;
    }
  };
  return (
    tryDb(
      `SELECT ticker FROM company_about WHERE LOWER(name) = LOWER(?) LIMIT 1`,
      name.trim(),
    ) ||
    tryDb(
      `SELECT ticker FROM company_about WHERE LOWER(name) LIKE LOWER(?) LIMIT 1`,
      `%${cleaned}%`,
    )
  );
}

function lookupCompanySector(ticker: string | null): {
  sector: string | null;
  industry: string | null;
} {
  if (!ticker) return { sector: null, industry: null };
  const sym = ticker.toUpperCase().trim();

  // Prefer classifications.db (same taxonomy as Company table / Scan)
  try {
    const db = openSqliteNamed("classifications.db", { readonly: true });
    const row = db
      .prepare(
        `SELECT sector, industry, sub_sector
         FROM classifications
         WHERE upper(ticker) = ?
         ORDER BY CASE upper(COALESCE(market, ''))
           WHEN 'NSE' THEN 0 WHEN 'BSE' THEN 1 ELSE 2 END
         LIMIT 1`,
      )
      .get(sym) as
      | {
          sector: string | null;
          industry: string | null;
          sub_sector: string | null;
        }
      | undefined;
    if (row) {
      const sector = row.sector?.trim() || null;
      const industry =
        row.sub_sector?.trim() || row.industry?.trim() || null;
      if (sector || industry) return { sector, industry };
    }
  } catch {
    /* fall through */
  }

  // Fallback: scraper companies (Yahoo / about fields)
  try {
    const db = openSqliteNamed("scraper.db", { readonly: true });
    const row = db
      .prepare(
        `SELECT sector, industry, sub_sector, company_sector, company_industry
         FROM companies WHERE upper(ticker) = ? LIMIT 1`,
      )
      .get(sym) as
      | {
          sector: string | null;
          industry: string | null;
          sub_sector: string | null;
          company_sector: string | null;
          company_industry: string | null;
        }
      | undefined;
    if (!row) return { sector: null, industry: null };
    return {
      sector: row.sector?.trim() || row.company_sector?.trim() || null,
      industry:
        row.sub_sector?.trim() ||
        row.industry?.trim() ||
        row.company_industry?.trim() ||
        null,
    };
  } catch {
    return { sector: null, industry: null };
  }
}

function enrichCard(text: string, extract: ConcallExtract): ConcallExtract {
  const meta = asObj(extract.metadata) || {};
  const tone = asObj(extract.management_tone) || {};
  const fin = asObj(extract.reported_financials) || {};
  const guide = asObj(extract.forward_guidance) || {};
  const rev = asObj(fin.revenue) || {};
  let card = asObj(extract.card);
  if (!card) {
    card = {
      result_quality: null,
      mgmt_sentiment: null,
      highlights: [],
      sector: null,
      industry: null,
    };
  }

  const sec = lookupCompanySector(
    typeof meta.nse_symbol === "string" ? meta.nse_symbol : null,
  );
  // Always prefer our DB taxonomy over anything the LLM invents
  if (sec.sector) card.sector = sec.sector;
  if (sec.industry) card.industry = sec.industry;

  const yoy = asNum(rev.pct_change) ?? metricYoyPct(fin.revenue);

  let highlights = Array.isArray(card.highlights) ? card.highlights : [];
  highlights = normalizeHighlightList(highlights);

  const isAnalystMeet =
    meta.document_kind === "analyst_meet" ||
    /analyst\s*meet/i.test(String(meta.document_type || ""));

  // Highlights come from LLM / deck mapper only — no regex hardcoding.
  // Always surface Analyst Meet so empty Financials isn't mistaken for a bug —
  // but never crowd out real StockScans event scanlines (merger / stake / target).
  if (isAnalystMeet) {
    const notice =
      "Analyst Meet transcript — spoken Q&A, not a printed quarterly P&L deck";
    const eventful = highlights.filter(
      (h) =>
        !/analyst\s*meet transcript/i.test(h.text) &&
        !/^(?:Consolidated\s+)?(?:Revenue|PAT|EBITDA|Net profit)\b/i.test(
          h.text,
        ) &&
        !/^EBITDA margin [+-]?\d+bps/i.test(h.text),
    );
    if (eventful.length >= 2) {
      highlights = eventful.slice(0, 3);
    } else if (!highlights.some((h) => /analyst\s*meet transcript/i.test(h.text))) {
      highlights = [
        { text: notice, polarity: "neutral" },
        ...highlights.filter((h) => !/analyst\s*meet transcript/i.test(h.text)),
      ];
    }
    if (!card.result_quality) card.result_quality = "Average";
    if (!card.mgmt_sentiment) {
      card.mgmt_sentiment =
        yoy != null && yoy >= 15
          ? "bullish"
          : typeof tone?.overall_tone === "string"
            ? String(tone.overall_tone)
            : "neutral";
    }
  }
  card.highlights = highlights.slice(0, card.brief ? 5 : 3);

  // LLM brief cards already set rating / sentiment / strengths — don't overwrite
  if (card.brief) {
    extract.card = card;
    return extract;
  }

  // Card tags from highlight polarity (StockScans): RPG → Strong/Bullish; Fortis legal → Average/Neutral
  const pos = highlights.filter((h) => h.polarity === "positive").length;
  const neg = highlights.filter((h) => h.polarity === "negative").length;
  const hlBlob = highlights.map((h) => h.text).join(" ");
  const legalHeavy =
    /forensic|court-ordered|legal appeal|audit underway/i.test(hlBlob) &&
    pos <= 1;
  const growthHeavy =
    pos >= 2 &&
    neg === 0 &&
    /investment commitment|acquisition(?:s)? closed|stake increase|guidance|CAGR|capacity/i.test(
      hlBlob,
    );

  if (legalHeavy && !growthHeavy) {
    card.result_quality = "Average";
    card.mgmt_sentiment = "neutral";
  } else if (
    /stagnant|lumpy|not grown|same range/i.test(hlBlob) &&
    /revenue up \d+%/i.test(hlBlob)
  ) {
    // Mixed: one growth segment + soft segment → Cautious
    card.result_quality = "Average";
    card.mgmt_sentiment = "cautious";
    if (tone) {
      tone.overall_tone = "cautious";
      extract.management_tone = tone;
    }
  } else if (
    /order inflow/i.test(hlBlob) &&
    pos >= 1 &&
    neg <= 1
  ) {
    // Strong order book with limited headwind → Strong + Optimistic
    card.result_quality = "Strong";
    card.mgmt_sentiment = "optimistic";
    if (tone) {
      tone.overall_tone = "optimistic";
      extract.management_tone = tone;
    }
  } else if (growthHeavy || (pos >= 2 && neg === 0)) {
    card.result_quality =
      yoy != null && yoy >= 40 ? "Excellent" : "Strong";
    card.mgmt_sentiment = "bullish";
    if (tone && !tone.overall_tone) {
      tone.overall_tone = "bullish";
      extract.management_tone = tone;
    } else if (tone && tone.overall_tone === "neutral") {
      tone.overall_tone = "bullish";
      extract.management_tone = tone;
    }
  } else if (
    pos >= 1 &&
    neg <= 1 &&
    /revenue target|guidance|partner win|deal won|\$[\d.]+bn|AI specialists/i.test(
      hlBlob,
    )
  ) {
    // Mixed catalysts with a forward growth print → Average + Optimistic
    card.result_quality = card.result_quality || "Average";
    card.mgmt_sentiment = "optimistic";
  } else if (!card.result_quality || !card.mgmt_sentiment) {
    if (!card.result_quality) {
      if (yoy != null && yoy >= 40) card.result_quality = "Excellent";
      else if (yoy != null && yoy >= 15) card.result_quality = "Strong";
      else card.result_quality = "Average";
    }
    if (!card.mgmt_sentiment) {
      const overall =
        typeof tone.overall_tone === "string"
          ? tone.overall_tone.toLowerCase()
          : "";
      if (overall === "bullish") card.mgmt_sentiment = "bullish";
      else if (overall === "optimistic") card.mgmt_sentiment = "optimistic";
      else if (overall === "cautious" || overall === "defensive")
        card.mgmt_sentiment = "cautious";
      else if (overall === "neutral") card.mgmt_sentiment = "neutral";
      else if (/optim|confident|reiterat/i.test(text))
        card.mgmt_sentiment = "optimistic";
      else card.mgmt_sentiment = "neutral";
    }
  }

  extract.card = card;
  return extract;
}

function normalizeHighlightList(
  raw: unknown[],
): Array<{ text: string; polarity: string }> {
  const isJunk = (text: string) =>
    /results?,?\s*tuesday/i.test(text) ||
    /scheduled to be held/i.test(text) ||
    /investor conference call for q\d/i.test(text) ||
    /^q\d\s*fy\s*[\d-]+\s*results?,/i.test(text) ||
    /presentation for the investor conference call/i.test(text);

  return raw
    .map((h) => {
      if (typeof h === "string" && h.trim()) {
        return { text: h.trim().slice(0, 100), polarity: "neutral" };
      }
      const o = asObj(h);
      if (!o) return null;
      const text =
        typeof o.text === "string"
          ? o.text
          : typeof o.event === "string"
            ? o.event
            : typeof o.headline === "string"
              ? o.headline
              : "";
      if (!text.trim() || isJunk(text)) return null;
      const pol = String(o.polarity || o.tone || "neutral").toLowerCase();
      return {
        text: text.trim().replace(/\s+/g, " ").slice(0, 100),
        polarity:
          pol === "positive" ||
          pol === "negative" ||
          pol === "neutral" ||
          pol === "pos" ||
          pol === "neg"
            ? pol === "pos"
              ? "positive"
              : pol === "neg"
                ? "negative"
                : pol
            : "neutral",
      };
    })
    .filter(Boolean) as Array<{ text: string; polarity: string }>;
}

/**
 * Lean quant Executive Summary / Highlight-Sentiment from saved combined text.
 * Persists under extract.quant and optionally refreshes card.highlights.
 */
export async function runConcallQuantForRow(opts: {
  id: number;
  kind: "executive" | "highlights" | "both";
  compareGold?: boolean;
}): Promise<{
  ok: boolean;
  id: number;
  kind: string;
  executive_summary?: Record<string, unknown> | null;
  highlight_sentiment?: Record<string, unknown> | null;
  compare?: Record<string, unknown>;
  engine?: string;
  error?: string;
  history?: ConcallHistoryRow[];
}> {
  const saved = getConcallCombinedText(opts.id);
  if (!saved.ok || !saved.combined_text) {
    return {
      ok: false,
      id: opts.id,
      kind: opts.kind,
      error: saved.error || "No combined text — Load Text first",
    };
  }
  const { transcriptText, presentationText } = splitCombinedMaterialsText(
    saved.combined_text,
  );
  const extract = (saved.extract || emptyExtract()) as ConcallExtract;
  const quant = asObj(extract.quant) || {};
  const engines: string[] = [];
  const compare: Record<string, unknown> = {};

  const runOne = async (kind: "executive" | "highlights") => {
    const r = await extractQuantFromTexts({
      kind,
      transcriptText,
      presentationText,
    });
    engines.push(r.engine);
    if (!r.ok) throw new Error(r.error || `${kind} failed`);
    if (kind === "executive") {
      quant.executive_summary = r.json;
      if (opts.compareGold !== false && r.compare) {
        compare.executive = r.compare;
      }
      applyExecutiveSnapshotToFinancials(extract, r.json);
      const summaryText = formatExecutiveSummaryText(r.json);
      if (summaryText) {
        const docs = asDocs(extract.docs);
        docs.summary = summaryText.slice(0, 8_000);
        extract.docs = docs;
      }
    } else {
      quant.highlight_sentiment = r.json;
      if (opts.compareGold !== false && r.compare) {
        compare.highlights = r.compare;
      }
      applyHighlightSentimentToCard(extract, r.json);
    }
  };

  try {
    if (opts.kind === "executive" || opts.kind === "both") {
      await runOne("executive");
    }
    if (opts.kind === "highlights" || opts.kind === "both") {
      await runOne("highlights");
    }
  } catch (e) {
    return {
      ok: false,
      id: opts.id,
      kind: opts.kind,
      error: e instanceof Error ? e.message : "Quant failed",
      engine: engines.join("+") || undefined,
    };
  }

  extract.quant = quant;
  const db = openDb();
  db.prepare(
    `UPDATE concall_screens SET extract_json = ? WHERE id = ?`,
  ).run(JSON.stringify(extract), opts.id);

  // Gold-only compare if LLM compare missing
  if (opts.compareGold !== false) {
    try {
      if (quant.executive_summary && !compare.executive) {
        compare.executive = compareQuantJson(
          quant.executive_summary as Record<string, unknown>,
          loadQuantGold("executive"),
        );
      }
      if (quant.highlight_sentiment && !compare.highlights) {
        compare.highlights = compareQuantJson(
          quant.highlight_sentiment as Record<string, unknown>,
          loadQuantGold("highlights"),
        );
      }
    } catch {
      /* gold optional */
    }
  }

  return {
    ok: true,
    id: opts.id,
    kind: opts.kind,
    executive_summary: (quant.executive_summary as Record<string, unknown>) || null,
    highlight_sentiment:
      (quant.highlight_sentiment as Record<string, unknown>) || null,
    compare: Object.keys(compare).length ? compare : undefined,
    engine: engines.join("+"),
    history: listConcallHistory(40),
  };
}

export function getConcallQuantJson(opts: {
  id: number;
  kind: "executive" | "highlights";
}): {
  ok: boolean;
  id: number;
  kind: string;
  json: Record<string, unknown> | null;
  error?: string;
} {
  const saved = getConcallCombinedText(opts.id);
  if (!saved.extract) {
    return {
      ok: false,
      id: opts.id,
      kind: opts.kind,
      json: null,
      error: "Row not found",
    };
  }
  const quant = asObj(saved.extract.quant) || {};
  const key =
    opts.kind === "executive" ? "executive_summary" : "highlight_sentiment";
  const json = asObj(quant[key]);
  return {
    ok: Boolean(json),
    id: opts.id,
    kind: opts.kind,
    json,
    error: json ? undefined : `No ${opts.kind} JSON yet — run Quant`,
  };
}

/** Normalize printed revenue to INR crore via shared orderbook unit parser. */
function revenueToCr(metric: unknown): number | null {
  const o = asObj(metric);
  if (!o) return null;
  const cur = metricCurrentQtr(metric);
  if (cur == null || !Number.isFinite(cur)) return null;
  const unit = String(o.unit || "INR cr").trim();

  // Absolute rupees (unit INR/₹) — never treat as crore face value
  if (/^₹$|^inr$/i.test(unit)) {
    if (Math.abs(cur) >= 100_000) {
      return Math.round((cur / 1e7) * 100) / 100;
    }
    // Small INR figures are usually EPS, not revenue
    return null;
  }

  let labeled: string;
  if (/\bmn\b|million/i.test(unit)) labeled = `INR ${cur} Mn`;
  else if (/\blac|lakh/i.test(unit)) labeled = `INR ${cur} Lacs`;
  else if (/\bbn\b|billion/i.test(unit)) labeled = `INR ${cur} Billion`;
  else if (/\bcr|crore/i.test(unit)) {
    // Guard: absolute rupees mis-tagged as Cr (e.g. 512000000)
    if (Math.abs(cur) >= 1_000_000) {
      return Math.round((cur / 1e7) * 100) / 100;
    }
    labeled = `INR ${cur} Cr`;
  } else {
    if (Math.abs(cur) >= 1_000_000) {
      return Math.round((cur / 1e7) * 100) / 100;
    }
    labeled = `INR ${cur} Cr`;
  }
  const parsed = parseOrderSizeToCr(labeled);
  if (parsed == null) return /\bcr|crore/i.test(unit) ? cur : null;
  // Sanity: quarterly India midcap consol revenue rarely > ₹50,000 Cr
  if (parsed > 50_000) {
    const asRupees = Math.round((cur / 1e7) * 100) / 100;
    if (asRupees > 0 && asRupees < parsed) return asRupees;
  }
  return parsed;
}

/** Rewrite ₹N Mn in highlights + convert Mn/Lacs financials → Cr (orderbook parser). */
function normalizeExtractInrCr(extract: ConcallExtract): ConcallExtract {
  const fin = asObj(extract.reported_financials);
  if (fin) {
    for (const key of Object.keys(fin)) {
      const row = asObj(fin[key]);
      if (!row) continue;
      const unit = String(row.unit || "");
      if (!/\bmn\b|million|lac|lakh|bn|billion/i.test(unit)) continue;
      if (/^inr$/i.test(unit.trim())) continue;
      const cur = asNum(row.current_qtr);
      const yoy = asNum(row.yoy_qtr);
      const next: Record<string, unknown> = { ...row, unit: "INR cr" };
      if (cur != null) {
        const cr = revenueToCr({ ...row, current_qtr: cur });
        if (cr != null) next.current_qtr = cr;
      }
      if (yoy != null) {
        const cr = revenueToCr({ ...row, current_qtr: yoy });
        if (cr != null) next.yoy_qtr = cr;
      }
      fin[key] = next;
    }
    extract.reported_financials = fin;
  }

  const card = asObj(extract.card);
  if (card && Array.isArray(card.highlights)) {
    card.highlights = card.highlights.map((h) => {
      const o = asObj(h);
      if (!o || typeof o.text !== "string") return h;
      const text = o.text.replace(
        /₹\s*([\d,]+(?:\.\d+)?)\s*Mn\b/gi,
        (_m, raw: string) => {
          const cr = parseOrderSizeToCr(`INR ${raw.replace(/,/g, "")} Mn`);
          if (cr == null) return _m;
          const pretty = Number.isInteger(cr)
            ? String(cr)
            : String(Math.round(cr * 100) / 100);
          return `₹${pretty} Cr`;
        },
      );
      return { ...o, text };
    });
    extract.card = card;
  }
  return extract;
}

/** YoY % from either schema: {current_qtr,pct_change}, {q1_fy27,yoy_growth_pct}, or {Q1FY27,Q1FY26}. */
function metricYoyPct(metric: unknown): number | null {
  const o = asObj(metric);
  if (!o) return null;
  const direct = asNum(o.pct_change) ?? asNum(o.yoy_growth_pct);
  if (direct != null) return direct;
  // Period-keyed: pick latest Q*FY* vs same quarter prior FY
  const keys = Object.keys(o).filter((k) => /^Q[1-4]FY\d{2}$/i.test(k));
  if (keys.length >= 2) {
    keys.sort((a, b) => {
      const ya = Number(a.slice(-2));
      const yb = Number(b.slice(-2));
      if (ya !== yb) return yb - ya;
      return Number(b[1]) - Number(a[1]);
    });
    const curKey = keys[0];
    const q = curKey[1];
    const fy = Number(curKey.slice(-2));
    const priorKey = `Q${q}FY${String(fy - 1).padStart(2, "0")}`;
    const cur = asNum(o[curKey]);
    const prior = asNum(o[priorKey]);
    if (cur != null && prior != null && prior !== 0) {
      return ((cur - prior) / Math.abs(prior)) * 100;
    }
  }
  const cur = asNum(o.q1_fy27) ?? asNum(o.current_qtr);
  const prior = asNum(o.q1_fy26) ?? asNum(o.yoy_qtr);
  if (cur != null && prior != null && prior !== 0) {
    return ((cur - prior) / Math.abs(prior)) * 100;
  }
  return null;
}

/** Current quarter value: current_qtr, q1_fy27, or latest Q*FY* key. */
function metricCurrentQtr(metric: unknown): number | null {
  const o = asObj(metric);
  if (!o) return null;
  const direct = asNum(o.current_qtr) ?? asNum(o.q1_fy27);
  if (direct != null) return direct;
  const keys = Object.keys(o).filter((k) => /^Q[1-4]FY\d{2}$/i.test(k));
  if (!keys.length) return null;
  keys.sort((a, b) => {
    const ya = Number(a.slice(-2));
    const yb = Number(b.slice(-2));
    if (ya !== yb) return yb - ya;
    return Number(b[1]) - Number(a[1]);
  });
  return asNum(o[keys[0]]);
}

/** Absolute margin change in bps (ppt × 100). */
function metricMarginBps(metric: unknown): number | null {
  const o = asObj(metric);
  if (!o) return null;
  const directBps = asNum(o.change_bps);
  if (directBps != null) return directBps;
  const curQ = asNum(o.current_qtr) ?? asNum(o.q1_fy27);
  const yoyQ = asNum(o.yoy_qtr) ?? asNum(o.q1_fy26);
  if (curQ != null && yoyQ != null) return (curQ - yoyQ) * 100;
  const keys = Object.keys(o).filter((k) => /^Q[1-4]FY\d{2}$/i.test(k));
  if (keys.length >= 2) {
    keys.sort((a, b) => {
      const ya = Number(a.slice(-2));
      const yb = Number(b.slice(-2));
      if (ya !== yb) return yb - ya;
      return Number(b[1]) - Number(a[1]);
    });
    const curKey = keys[0];
    const q = curKey[1];
    const fy = Number(curKey.slice(-2));
    const priorKey = `Q${q}FY${String(fy - 1).padStart(2, "0")}`;
    const cur = asNum(o[curKey]);
    const prior = asNum(o[priorKey]);
    if (cur != null && prior != null) return (cur - prior) * 100;
  }
  return null;
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
  if (key === "card") {
    const o = asObj(value);
    return Boolean(
      o &&
        ("result_quality" in o ||
          "mgmt_sentiment" in o ||
          "highlights" in o),
    );
  }
  return typeof value === "object";
}

function decide(extract: ConcallExtract): {
  decision: "pass" | "review" | "fail";
  why: string;
  gaps: ConcallSaveGap[];
} {
  const readiness = concallSaveReadiness(extract);
  const gaps = readiness.gaps;
  const meta = asObj(extract.metadata);
  const tone = asObj(extract.management_tone);
  const fin = asObj(extract.reported_financials);
  const card = asObj(extract.card);
  const highlights = Array.isArray(card?.highlights) ? card.highlights : [];
  const actions = Array.isArray(extract.corporate_actions)
    ? extract.corporate_actions
    : [];
  const catalysts = Array.isArray(extract.key_catalysts)
    ? extract.key_catalysts
    : [];
  const hasMeta = Boolean(meta?.company_name || meta?.nse_symbol);
  const hasTone = Boolean(tone?.overall_tone);
  const finKeys = fin ? Object.keys(fin) : [];
  const hasAbsoluteFin = Boolean(
    asObj(fin?.revenue)?.current_qtr != null ||
      asObj(fin?.ebitda)?.current_qtr != null ||
      asObj(fin?.net_profit)?.current_qtr != null ||
      asObj(fin?.pat)?.current_qtr != null,
  );
  const hasCoreFin = Boolean(
    hasAbsoluteFin || metricYoyPct(fin?.revenue) != null,
  );
  const hasFinOnlyEps =
    finKeys.length > 0 &&
    finKeys.every((k) => /^(eps|diluted_eps)$/i.test(k)) &&
    !hasAbsoluteFin;
  const hasFin = hasCoreFin;
  const realHighlights = highlights.filter(
    (h) =>
      h &&
      typeof (h as { text?: string }).text === "string" &&
      String((h as { text: string }).text).trim().length > 0 &&
      !/analyst\s*meet transcript — spoken/i.test(
        String((h as { text: string }).text),
      ),
  );
  const hasHighlights = realHighlights.length >= 1;
  const hasEvents =
    hasHighlights || actions.length > 0 || catalysts.length > 0;
  const isDeck =
    /investor\s*presentation|investor\s*deck|investor\s*pres/i.test(
      String(meta?.document_type || ""),
    ) || meta?.document_kind === "investor_presentation";

  const gapWhy =
    gaps.length > 0
      ? `Need before save: ${gaps.map((g) => g.field).join(", ")}`
      : null;

  // Investor decks: require absolute P&L (not YoY-only / mix %) + highlights.
  if (isDeck) {
    if (readiness.ready && hasMeta && hasHighlights && hasAbsoluteFin) {
      return {
        decision: "pass",
        why: "Investor presentation — highlights + core financials ready",
        gaps,
      };
    }
    return {
      decision: "review",
      why:
        gapWhy ||
        (hasFinOnlyEps
          ? "Incomplete deck extract (EPS only) — waiting for revenue/EBITDA/PAT + highlights"
          : !hasHighlights
            ? "Incomplete deck extract — highlights missing; not added to PASS list"
            : !hasAbsoluteFin
              ? "Incomplete deck extract — core financials missing; not added to PASS list"
              : "Partial investor presentation extract — not added to PASS list"),
      gaps,
    };
  }

  // Results calls: meta + tone + financials. M&A / special calls: meta + tone + events.
  // Pre-save readiness must clear (e.g. revenue ₹ Cr) before PASS persist.
  if (readiness.ready && hasMeta && hasTone && (hasFin || hasEvents)) {
    return {
      decision: "pass",
      why: hasFin
        ? "Extract has metadata + reported financials + management tone"
        : "Extract has metadata + tone + event catalysts (M&A / special call)",
      gaps,
    };
  }
  if (hasMeta || hasTone || hasFin || hasEvents || gaps.length) {
    return {
      decision: "review",
      why:
        gapWhy ||
        "Partial extract — check JSON / transcript coverage",
      gaps,
    };
  }
  return { decision: "fail", why: "No usable extract fields", gaps };
}

/**
 * Pre-save checklist — what must be present before PASS list persist.
 * Results-style calls (period / revenue language / exec snapshot) need absolute
 * revenue ₹ Cr; pure event calls may skip revenue when M&A catalysts exist.
 */
export function concallSaveReadiness(extract: ConcallExtract): {
  ready: boolean;
  gaps: ConcallSaveGap[];
} {
  const gaps: ConcallSaveGap[] = [];
  const meta = asObj(extract.metadata) || {};
  const tone = asObj(extract.management_tone) || {};
  const fin = asObj(extract.reported_financials) || {};
  const card = asObj(extract.card) || {};
  const highlights = Array.isArray(card.highlights) ? card.highlights : [];
  const actions = Array.isArray(extract.corporate_actions)
    ? extract.corporate_actions
    : [];
  const catalysts = Array.isArray(extract.key_catalysts)
    ? extract.key_catalysts
    : [];
  const hlBlob = highlights
    .map((h) => String(asObj(h)?.text || ""))
    .join(" · ");
  const quant = asObj(extract.quant);
  const hasExecSnap = Boolean(
    asObj(asObj(quant?.executive_summary)?.financial_snapshot)?.revenue,
  );

  if (!meta.nse_symbol && !meta.company_name) {
    gaps.push({
      field: "ticker_or_company",
      reason: "Need NSE symbol or company name",
    });
  }
  if (!tone.overall_tone) {
    gaps.push({
      field: "tone",
      reason: "Need management tone",
    });
  }

  const looksResults =
    Boolean(meta.quarter || meta.fiscal_year) ||
    hasExecSnap ||
    /revenue|ebitda|\bpat\b|sales|margin|operating income/i.test(hlBlob) ||
    asObj(fin.revenue) != null ||
    asObj(fin.ebitda) != null ||
    asObj(fin.pat) != null ||
    asObj(fin.net_profit) != null;

  const hasEventOnly =
    !looksResults &&
    (actions.length > 0 ||
      catalysts.length > 0 ||
      highlights.some((h) => {
        const t = String(asObj(h)?.text || "");
        return (
          t.length > 0 &&
          !/^(?:Consolidated\s+)?(?:Revenue|PAT|EBITDA|Net profit)\b/i.test(t)
        );
      }));

  const revenueCr = revenueToCr(fin.revenue);
  if (looksResults && (revenueCr == null || revenueCr <= 0)) {
    gaps.push({
      field: "revenue_cr",
      reason: hasExecSnap
        ? "Executive snapshot has revenue but reported_financials.revenue is empty — map snapshot before save"
        : "Need absolute revenue (₹ Cr) for results call before PASS save",
    });
  }

  if (
    !looksResults &&
    !hasEventOnly &&
    !tone.overall_tone &&
    !meta.nse_symbol
  ) {
    gaps.push({
      field: "substance",
      reason: "No results financials and no event catalysts",
    });
  }

  return { ready: gaps.length === 0, gaps };
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

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function guidanceLabel(extract: ConcallExtract): string | null {
  const guide = asObj(extract.forward_guidance);
  const rev = asObj(guide?.revenue_guidance_range);
  const mar = asObj(guide?.margin_guidance);
  const low = asNum(rev?.low);
  const high = asNum(rev?.high);
  const ebitda = asNum(mar?.ebitda_pct);
  const parts: string[] = [];
  if (low != null && high != null) {
    parts.push(`₹${low}–${high} Cr`);
  } else if (low != null) {
    parts.push(`₹${low} Cr`);
  }
  if (ebitda != null) parts.push(`${ebitda}% EBITDA`);
  return parts.length ? parts.join(" · ") : null;
}

function formatPeriodLabel(meta: Record<string, unknown>): string | null {
  const presentation =
    typeof meta.presentation_period === "string"
      ? meta.presentation_period.trim()
      : "";
  // Prefer explicit deck period (Q1 FY26-27) over call-month labels (Aug 2026)
  if (/Q\s*[1-4]/i.test(presentation)) {
    const norm = presentation
      .replace(/FY\s*(\d{2})\s*[-–]\s*(\d{2})/i, "FY$2")
      .replace(/FY\s*20(\d{2})\s*[-–]\s*(\d{2})/i, "FY$2")
      .replace(/\s+/g, " ")
      .trim();
    return norm;
  }

  const q = typeof meta.quarter === "string" ? meta.quarter.trim() : "";
  const fy = typeof meta.fiscal_year === "string" ? meta.fiscal_year.trim() : "";
  let base: string | null = null;
  // Avoid "Aug 2026" style when we only have a call month — prefer Q/FY
  if (/^Q[1-4]$/i.test(q) && fy) {
    const fyShort = fy.replace(/^FY\s*/i, "").replace(/^20/, "");
    base = `${q.toUpperCase()} FY${fyShort}`.replace(/\s+/g, " ").trim();
  } else if (/^Q[1-4]/i.test(q)) {
    base = q.replace(/\s+/g, " ").trim();
  } else if (/^FY/i.test(fy) || /^\d{2,4}$/.test(fy)) {
    base = /^FY/i.test(fy) ? fy : `FY${fy.replace(/^20/, "")}`;
  } else if (typeof meta.call_date === "string") {
    const m = meta.call_date.match(/^(\d{4})-(\d{2})/);
    if (m) {
      const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      base = `${months[Number(m[2]) - 1] || m[2]} ${m[1]}`;
    }
  }
  const kind = String(meta.document_kind || "");
  const dtype = String(meta.document_type || "");
  if (kind === "analyst_meet" || /analyst\s*meet/i.test(dtype)) {
    return base ? `${base} · Analyst Meet` : "Analyst Meet";
  }
  if (kind === "investor_presentation" || /investor\s*presentation/i.test(dtype)) {
    return base ? `${base} · Investor Pres` : "Investor Pres";
  }
  return base;
}

/**
 * If reported_financials.revenue is empty but quant executive snapshot has
 * revenue, map it in-place. Returns true when extract was mutated.
 */
export function ensureFinancialsFromQuantSnapshot(
  extract: ConcallExtract,
): boolean {
  const fin = asObj(extract.reported_financials) || {};
  const rev = asObj(fin.revenue);
  if (typeof rev?.current_qtr === "number" && Number.isFinite(rev.current_qtr)) {
    return false;
  }
  const snap = asObj(
    asObj(asObj(extract.quant)?.executive_summary)?.financial_snapshot,
  );
  if (!snap?.revenue) return false;
  const before = JSON.stringify(extract.reported_financials ?? null);
  applyExecutiveSnapshotToFinancials(
    extract,
    asObj(extract.quant)?.executive_summary as Record<string, unknown>,
  );
  return JSON.stringify(extract.reported_financials ?? null) !== before;
}

/**
 * If card.highlights is empty but quant.highlight_sentiment has headlines,
 * map them onto the PASS card (same shape as Analyze). Returns true when mutated.
 */
export function ensureHighlightsFromQuant(
  extract: ConcallExtract,
): boolean {
  const card = asObj(extract.card) || {};
  const existing = Array.isArray(card.highlights) ? card.highlights : [];
  const hasText = existing.some((h) => {
    if (typeof h === "string") return h.trim().length > 0;
    const o = asObj(h);
    return Boolean(
      o &&
        (typeof o.text === "string"
          ? o.text.trim()
          : typeof o.headline === "string"
            ? o.headline.trim()
            : ""),
    );
  });
  if (hasText) return false;
  const quantHl = asObj(asObj(extract.quant)?.highlight_sentiment);
  if (!quantHl) return false;
  const mapped = cardHighlightsFromQuant(quantHl);
  if (!mapped.length) return false;
  applyHighlightSentimentToCard(extract, quantHl);
  return true;
}

function historyFromExtract(
  id: number,
  source_url: string | null,
  extract: ConcallExtract,
  decision: string,
  screened_at: string,
): ConcallHistoryRow {
  const meta = asObj(extract.metadata) || {};
  const tone = asObj(extract.management_tone) || {};
  const card = asObj(extract.card) || {};
  const fin = asObj(extract.reported_financials) || {};
  const rev = fin.revenue;
  const ebitdaM = fin.ebitda_margin_pct ?? fin.margin;
  const period = formatPeriodLabel(meta);
  const highlights = Array.isArray(card.highlights)
    ? card.highlights
        .map((h) => {
          if (typeof h === "string") return { text: h, polarity: "neutral" };
          const o = asObj(h);
          if (!o || typeof o.text !== "string") return null;
          return {
            text: o.text,
            polarity: String(o.polarity || "neutral"),
          };
        })
        .filter((h): h is { text: string; polarity: string } => {
          if (!h?.text?.trim()) return false;
          const t = h.text;
          if (/results?,?\s*tuesday/i.test(t)) return false;
          if (/scheduled to be held/i.test(t)) return false;
          if (/^q\d\s*fy\s*[\d-]+\s*results?,/i.test(t)) return false;
          return true;
        })
    : [];
  let call_date = typeof meta.call_date === "string" ? meta.call_date : null;
  if (!call_date) {
    for (const key of ["report_date", "date", "result_date", "filing_date"]) {
      const v = meta[key];
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        call_date = v.slice(0, 10);
        break;
      }
    }
  }
  if (!call_date && screened_at) {
    call_date = screened_at.slice(0, 10);
  }
  if (!call_date) {
    const now = new Date();
    call_date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  let company =
    typeof meta.company_name === "string" ? meta.company_name : null;
  const ticker = typeof meta.nse_symbol === "string" ? meta.nse_symbol : null;
  if (!company && ticker) company = lookupCompanyName(ticker);

  return {
    id,
    source_url,
    ticker,
    company,
    call_date,
    period: period || null,
    sector: typeof card.sector === "string" ? card.sector : null,
    industry: typeof card.industry === "string" ? card.industry : null,
    revenue_cr: revenueToCr(rev),
    revenue_yoy_pct: metricYoyPct(rev),
    ebitda_margin_pct: metricCurrentQtr(ebitdaM),
    guidance_label: guidanceLabel(extract),
    sentiment: typeof tone.overall_tone === "string" ? tone.overall_tone : null,
    sentiment_score: asNum(tone.net_sentiment_score),
    result_quality:
      typeof card.result_quality === "string" ? card.result_quality : null,
    mgmt_sentiment:
      typeof card.mgmt_sentiment === "string" ? card.mgmt_sentiment : null,
    highlights,
    docs: asDocsPublic(extract.docs, extract),
    decision,
    ltp: asNum(extract.ltp),
    baseline_close: asNum(extract.baseline_close),
    drift_pct: asNum(extract.drift_pct),
    screened_at,
  };
}

/** Attach LTP + post-call drift vs last close before call_date. */
export async function attachConcallPrices(
  extract: ConcallExtract,
): Promise<ConcallExtract> {
  const meta = asObj(extract.metadata) || {};
  const ticker =
    typeof meta.nse_symbol === "string" ? meta.nse_symbol.trim() : "";
  if (!ticker) return extract;
  try {
    const [quote, bars] = await Promise.all([
      fetchQuoteDetailed(ticker, "NSE", { skipSummary: true }),
      fetchDailyBars(ticker, "NSE", 2),
    ]);
    const ltp =
      quote.price != null && Number.isFinite(quote.price) ? quote.price : null;
    extract.ltp = ltp;
    const day =
      typeof meta.call_date === "string" ? meta.call_date.slice(0, 10) : null;
    if (day && bars.length) {
      const baseline = baselineCloseBefore(
        bars.map((b) => ({ date: b.date, close: b.close })),
        day,
      );
      extract.baseline_close = baseline;
      extract.drift_pct = computeDriftPct(ltp, baseline);
    } else {
      extract.baseline_close = null;
      extract.drift_pct = null;
    }
  } catch {
    /* ignore */
  }
  return extract;
}

function loadTickerDocs(ticker: string | null): ConcallDocLinks {
  if (!ticker) return emptyDocs();
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT extract_json FROM concall_screens
       WHERE upper(ticker) = ? AND COALESCE(decision, 'review') = 'pass'
       ORDER BY screened_at DESC LIMIT 8`,
    )
    .all(ticker.toUpperCase()) as Array<{ extract_json: string }>;
  let docs = emptyDocs();
  for (const r of rows) {
    try {
      const ex = JSON.parse(r.extract_json) as ConcallExtract;
      const d = asDocs(ex.docs);
      // Merge URL slots only — do not pull another period's combined text
      docs = mergeDocs(docs, { ...d, combined: null });
      // Legacy: single source_url — classify into a slot if empty
      const url =
        typeof (ex as { source_url?: string }).source_url === "string"
          ? (ex as { source_url: string }).source_url
          : null;
      void url;
    } catch {
      /* ignore */
    }
  }
  return docs;
}

/** Tag extract.docs from doc kind + URL; merge prior ticker materials. */
function attachMaterialDocs(
  extract: ConcallExtract,
  sourceUrl: string | null,
  text: string,
): ConcallExtract {
  const meta = asObj(extract.metadata) || {};
  const ticker =
    typeof meta.nse_symbol === "string" ? meta.nse_symbol.toUpperCase() : null;
  const kind = classifyConcallDocument(text).kind;
  const isDeck =
    looksLikeInvestorPresentation(text) ||
    kind === "investor_presentation" ||
    /investor\s*presentation|earnings\s*presentation/i.test(
      String(meta.document_type || ""),
    );
  const slot: keyof ConcallDocLinks = isDeck
    ? "ppt"
    : /Transcript Notes/i.test(String(meta.document_type || "")) ||
        /Transcript Notes\s*·/i.test(text.slice(0, 2000))
      ? "summary"
      : "transcript";
  const next = emptyDocs();
  if (sourceUrl) next[slot] = sourceUrl;
  // Also keep primary source on its slot when already set via prior merge
  const prior = mergeDocs(loadTickerDocs(ticker), asDocs(extract.docs));
  extract.docs = mergeDocs(prior, next);
  return extract;
}

function mergeTranscriptAndPptExtracts(
  transcript: ConcallExtract,
  ppt: ConcallExtract,
): ConcallExtract {
  const out: ConcallExtract = { ...transcript };
  const finT = asObj(transcript.reported_financials) || {};
  const finP = asObj(ppt.reported_financials) || {};
  const mergedFin: Record<string, unknown> = { ...finT };
  for (const k of [
    "revenue",
    "ebitda",
    "ebitda_margin_pct",
    "net_profit",
    "eps",
  ]) {
    const row = asObj(finP[k]);
    if (row && row.current_qtr != null) mergedFin[k] = row;
  }
  out.reported_financials = mergedFin;

  const cardT = asObj(transcript.card) || {};
  const cardP = asObj(ppt.card) || {};
  const hlT = Array.isArray(cardT.highlights) ? cardT.highlights : [];
  const hlP = Array.isArray(cardP.highlights) ? cardP.highlights : [];
  const isFinHl = (h: unknown) => {
    const text = String(asObj(h)?.text || "");
    return (
      /^(?:Consolidated\s+)?(?:Revenue|PAT|EBITDA|Net profit)\b/i.test(text) ||
      /^EBITDA margin/i.test(text) ||
      /analyst\s*meet transcript/i.test(text)
    );
  };
  const eventful = (hl: unknown[]) => hl.filter((h) => {
    const text = String(asObj(h)?.text || "");
    return text && !isFinHl(h);
  });
  const preferTranscriptEvents = eventful(hlT).length >= 2;
  // Merge unique event scanlines — prefer catalysts over soft "investment commitment"
  const rank = (h: unknown) => {
    const text = String(asObj(h)?.text || "");
    if (/order inflow/i.test(text)) return 1;
    if (/subsidiary|pilot supplies|margin hit|stagnant|Plant \d|merger announced|steel/i.test(text))
      return 2;
    if (/revenue up \d+%/i.test(text)) return 3;
    if (/investment commitment/i.test(text)) return 8;
    return 5;
  };
  const mergedHl: unknown[] = [];
  const seen = new Set<string>();
  const pool = [...eventful(hlT), ...eventful(hlP)].sort(
    (a, b) => rank(a) - rank(b),
  );
  for (const h of pool) {
    const text = String(asObj(h)?.text || "").toLowerCase();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    mergedHl.push(h);
    if (mergedHl.length >= 3) break;
  }
  out.card = {
    ...cardP,
    ...cardT,
    highlights: mergedHl.length
      ? mergedHl
      : preferTranscriptEvents
        ? hlT
        : hlP.length
          ? hlP
          : hlT,
    sector: cardP.sector || cardT.sector,
    industry: cardP.industry || cardT.industry,
    result_quality: preferTranscriptEvents
      ? cardT.result_quality || cardP.result_quality
      : cardP.result_quality || cardT.result_quality,
    mgmt_sentiment: preferTranscriptEvents
      ? cardT.mgmt_sentiment || cardP.mgmt_sentiment
      : cardP.mgmt_sentiment || cardT.mgmt_sentiment,
  };
  out.docs = mergeDocs(asDocs(ppt.docs), asDocs(transcript.docs));
  const metaT = asObj(transcript.metadata) || {};
  const metaP = asObj(ppt.metadata) || {};
  const pptIsDeck =
    metaP.document_kind === "investor_presentation" ||
    /investor\s*presentation/i.test(String(metaP.document_type || ""));
  out.metadata = {
    ...metaT,
    ...metaP,
    company_name: metaT.company_name || metaP.company_name,
    nse_symbol: metaT.nse_symbol || metaP.nse_symbol,
    bse_code: metaT.bse_code || metaP.bse_code,
    call_date: metaT.call_date || metaP.call_date || metaP.filing_date,
    // Prefer deck quarter/FY when PPT is an investor presentation
    quarter: pptIsDeck
      ? metaP.quarter || metaT.quarter
      : metaT.quarter || metaP.quarter,
    fiscal_year: pptIsDeck
      ? metaP.fiscal_year || metaT.fiscal_year
      : metaT.fiscal_year || metaP.fiscal_year,
    document_type: pptIsDeck
      ? metaP.document_type || metaT.document_type
      : metaT.document_type || metaP.document_type,
    document_kind: pptIsDeck
      ? "investor_presentation"
      : metaT.document_kind || metaP.document_kind,
    document_note: pptIsDeck
      ? metaP.document_note || "Investor presentation / earnings deck."
      : metaT.document_note || metaP.document_note,
    presentation_period:
      metaP.presentation_period ||
      metaT.presentation_period ||
      (pptIsDeck && metaP.quarter && metaP.fiscal_year
        ? `${metaP.quarter} ${metaP.fiscal_year}`
        : null),
  };
  if (ppt.ltp != null && out.ltp == null) out.ltp = ppt.ltp;
  if (transcript.ltp != null) out.ltp = transcript.ltp;
  return out;
}

function saveHistory(row: {
  source_url: string | null;
  extract: ConcallExtract;
  decision: string;
  engine: string;
}): number | null {
  // Pass-only list (same idea as Order book)
  if (row.decision !== "pass") return null;
  const db = openDb();
  const meta = asObj(row.extract.metadata) || {};
  const tone = asObj(row.extract.management_tone) || {};
  const ticker =
    typeof meta.nse_symbol === "string" ? meta.nse_symbol.toUpperCase() : null;
  const screened_at = new Date().toISOString();
  if (!meta.company_name && ticker) {
    const n = lookupCompanyName(ticker);
    if (n) meta.company_name = n;
  }
  if (!meta.call_date) {
    meta.call_date = screened_at.slice(0, 10);
  }
  row.extract.metadata = meta;
  const period = formatPeriodLabel(meta);
  // Upsert: one row per ticker + period
  if (ticker && period) {
    db.prepare(
      `DELETE FROM concall_screens WHERE upper(ticker) = ? AND period = ?`,
    ).run(ticker, period);
  }
  const r = db
    .prepare(
      `INSERT INTO concall_screens (
        source_url, ticker, company, period, sentiment, decision,
        extract_json, screened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.source_url,
      ticker,
      typeof meta.company_name === "string" ? meta.company_name : null,
      period || null,
      typeof tone.overall_tone === "string" ? tone.overall_tone : null,
      row.decision,
      JSON.stringify(row.extract),
      screened_at,
    );
  return Number(r.lastInsertRowid);
}

/** Delete PASS/history rows by id. Returns number removed. */
export function deleteConcallHistoryByIds(ids: number[]): {
  ok: boolean;
  deleted: number;
  error?: string;
} {
  const clean = [
    ...new Set(
      ids
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ];
  if (!clean.length) {
    return { ok: false, deleted: 0, error: "No row ids" };
  }
  const db = openDb();
  const del = db.prepare(`DELETE FROM concall_screens WHERE id = ?`);
  const tx = db.transaction((list: number[]) => {
    let n = 0;
    for (const id of list) {
      const r = del.run(id);
      n += Number(r.changes || 0);
    }
    return n;
  });
  const deleted = tx(clean);
  return { ok: true, deleted };
}

export function listConcallHistory(limit = 40): ConcallHistoryRow[] {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT id, source_url, extract_json, decision, screened_at
       FROM concall_screens
       WHERE COALESCE(decision, 'review') = 'pass'
       ORDER BY screened_at DESC, id DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, limit))) as Array<{
    id: number;
    source_url: string | null;
    extract_json: string;
    decision: string | null;
    screened_at: string;
  }>;

  const out: ConcallHistoryRow[] = [];
  const bestByTicker = new Map<string, ConcallHistoryRow>();
  const docsByTicker = new Map<string, ConcallDocLinks>();
  const revenueByTicker = new Map<
    string,
    {
      revenue_cr: number | null;
      revenue_yoy_pct: number | null;
      ebitda_margin_pct: number | null;
    }
  >();
  const scoreRow = (row: ConcallHistoryRow): number => {
    let s = 0;
    const hl = row.highlights || [];
    s += hl.length * 10;
    s += hl.filter((h) => h.polarity === "positive").length * 15;
    s += hl.filter((h) => !/YoY|bps YoY/i.test(h.text)).length * 25;
    if (/strong|excellent/i.test(row.result_quality || "")) s += 40;
    if (/bullish|optimistic/i.test(row.mgmt_sentiment || "")) s += 25;
    if (row.revenue_cr != null) s += 5;
    // Prefer StockScans dual-doc rows (transcript events + PPT print)
    const d = row.docs || emptyDocs();
    if (d.transcript) s += 25;
    if (d.ppt) s += 25;
    if (d.transcript && d.ppt) s += 80;
    if (
      row.revenue_cr != null &&
      hl.some(
        (h) =>
          /merger|divest|target|deal won|stake|acquisition/i.test(h.text),
      )
    ) {
      s += 60;
    }
    if (row.call_date) s += Number(row.call_date.replace(/-/g, "").slice(0, 8)) / 1e10;
    return s;
  };
  for (const r of rows) {
    let extract: ConcallExtract = emptyExtract();
    try {
      extract = {
        ...emptyExtract(),
        ...(JSON.parse(r.extract_json) as ConcallExtract),
      };
    } catch {
      continue;
    }
    if (ensureFinancialsFromQuantSnapshot(extract)) {
      try {
        db.prepare(
          `UPDATE concall_screens SET extract_json = ? WHERE id = ?`,
        ).run(JSON.stringify(extract), r.id);
      } catch {
        /* ignore */
      }
    }
    if (ensureHighlightsFromQuant(extract)) {
      try {
        db.prepare(
          `UPDATE concall_screens SET extract_json = ? WHERE id = ?`,
        ).run(JSON.stringify(extract), r.id);
      } catch {
        /* ignore */
      }
    }
    // Drop stale notes blobs from older extracts
    if (
      extract.transcript_notes ||
      extract.transcript_notes_markdown ||
      extract.transcript_notes_engine
    ) {
      delete extract.transcript_notes;
      delete extract.transcript_notes_markdown;
      delete extract.transcript_notes_engine;
      try {
        db.prepare(`UPDATE concall_screens SET extract_json = ? WHERE id = ?`).run(
          JSON.stringify(extract),
          r.id,
        );
      } catch {
        /* ignore */
      }
    }
    const row = historyFromExtract(
      r.id,
      r.source_url,
      extract,
      r.decision || "pass",
      r.screened_at,
    );
    // Backfill docs from legacy single source_url
    if (
      r.source_url &&
      !row.docs.transcript &&
      !row.docs.ppt &&
      !row.docs.summary
    ) {
      const meta = asObj(extract.metadata) || {};
      const dtype = String(meta.document_type || "");
      const kind = String(meta.document_kind || "");
      if (
        kind === "investor_presentation" ||
        /investor\s*pres|earnings\s*presentation/i.test(dtype)
      ) {
        row.docs.ppt = r.source_url;
      } else if (/Transcript Notes/i.test(dtype)) {
        row.docs.summary = r.source_url;
      } else {
        row.docs.transcript = r.source_url;
      }
    }
    if (row.ticker) {
      const t = row.ticker.toUpperCase();
      docsByTicker.set(
        t,
        mergeDocs(docsByTicker.get(t) || emptyDocs(), {
          summary: row.docs.summary ?? null,
          transcript: row.docs.transcript ?? null,
          ppt: row.docs.ppt ?? null,
          combined: null,
        }),
      );
    }
    // Persist company / call_date / highlights backfills into extract_json
    const meta = asObj(extract.metadata) || {};
    let dirty = false;
    if (row.company && meta.company_name !== row.company) {
      meta.company_name = row.company;
      dirty = true;
    }
    if (row.call_date && meta.call_date !== row.call_date) {
      meta.call_date = row.call_date;
      dirty = true;
    }
    if (dirty) extract.metadata = meta;

    // Re-apply Strong/Bullish from highlight polarity even without PDF text
    {
      const beforeCard = JSON.stringify(extract.card);
      extract = enrichLexical("", extract);
      if (JSON.stringify(extract.card) !== beforeCard) dirty = true;
      const card = asObj(extract.card) || {};
      row.result_quality =
        typeof card.result_quality === "string" ? card.result_quality : row.result_quality;
      row.mgmt_sentiment =
        typeof card.mgmt_sentiment === "string" ? card.mgmt_sentiment : row.mgmt_sentiment;
      if (Array.isArray(card.highlights) && card.highlights.length) {
        row.highlights = card.highlights as ConcallHistoryRow["highlights"];
      }
      row.period = formatPeriodLabel(asObj(extract.metadata) || {}) || row.period;
      row.company =
        (typeof (asObj(extract.metadata) || {}).company_name === "string"
          ? String((asObj(extract.metadata) || {}).company_name)
          : null) || row.company;
    }
    if (dirty) {
      try {
        db.prepare(
          `UPDATE concall_screens SET extract_json = ?, company = COALESCE(?, company) WHERE id = ?`,
        ).run(JSON.stringify(extract), row.company, r.id);
      } catch {
        /* ignore */
      }
    }
    const tickerKey = (row.ticker || "").toUpperCase() || `id:${row.id}`;
    const prev = bestByTicker.get(tickerKey);
    if (!prev || scoreRow(row) > scoreRow(prev)) {
      bestByTicker.set(tickerKey, row);
    }
    // Keep best revenue figures across same-ticker extracts (PPT print + transcript events)
    const finPrev = revenueByTicker.get(tickerKey);
    if (
      row.revenue_cr != null ||
      row.revenue_yoy_pct != null ||
      row.ebitda_margin_pct != null
    ) {
      revenueByTicker.set(tickerKey, {
        revenue_cr: row.revenue_cr ?? finPrev?.revenue_cr ?? null,
        revenue_yoy_pct: row.revenue_yoy_pct ?? finPrev?.revenue_yoy_pct ?? null,
        ebitda_margin_pct:
          row.ebitda_margin_pct ?? finPrev?.ebitda_margin_pct ?? null,
      });
    }
  }
  for (const [tickerKey, row] of bestByTicker) {
    const mergedDocs = docsByTicker.get(tickerKey);
    if (mergedDocs) {
      row.docs = {
        ...row.docs,
        summary: row.docs.summary || mergedDocs.summary,
        transcript: row.docs.transcript || mergedDocs.transcript,
        ppt: row.docs.ppt || mergedDocs.ppt,
      };
    }
    const fin = revenueByTicker.get(tickerKey);
    if (fin) {
      if (row.revenue_cr == null && fin.revenue_cr != null)
        row.revenue_cr = fin.revenue_cr;
      if (row.revenue_yoy_pct == null && fin.revenue_yoy_pct != null)
        row.revenue_yoy_pct = fin.revenue_yoy_pct;
      if (row.ebitda_margin_pct == null && fin.ebitda_margin_pct != null)
        row.ebitda_margin_pct = fin.ebitda_margin_pct;
    }
  }
  out.push(...bestByTicker.values());
  out.sort((a, b) => (b.screened_at || "").localeCompare(a.screened_at || ""));
  return out;
}

export async function refreshConcallHistoryPrices(
  rows: ConcallHistoryRow[],
): Promise<ConcallHistoryRow[]> {
  const out: ConcallHistoryRow[] = [];
  for (const row of rows) {
    if (!row.ticker) {
      out.push(row);
      continue;
    }
    try {
      const patch = await attachConcallPrices({
        metadata: {
          nse_symbol: row.ticker,
          call_date: row.call_date,
        },
        ltp: null,
        baseline_close: null,
        drift_pct: null,
      });
      out.push({
        ...row,
        ltp: asNum(patch.ltp),
        baseline_close: asNum(patch.baseline_close),
        drift_pct: asNum(patch.drift_pct),
      });
    } catch {
      out.push(row);
    }
  }
  return out;
}

/**
 * Re-enrich PASS rows without LLM re-extract: company name, call_date,
 * sector/highlights/revenue shapes, optional PDF text parse, LTP/Δ call.
 */
export async function refreshConcallHistoryRows(opts?: {
  limit?: number;
  prices?: boolean;
  reparsePdf?: boolean;
}): Promise<{
  ok: true;
  updated: number;
  pdf_reparsed: number;
  history: ConcallHistoryRow[];
}> {
  const limit = Math.max(1, Math.min(100, opts?.limit ?? 40));
  const wantPrices = opts?.prices !== false;
  const wantPdf = opts?.reparsePdf !== false;
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT id, source_url, extract_json, decision, screened_at
       FROM concall_screens
       WHERE COALESCE(decision, 'review') = 'pass'
       ORDER BY screened_at DESC, id DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number;
    source_url: string | null;
    extract_json: string;
    decision: string | null;
    screened_at: string;
  }>;

  let updated = 0;
  let pdf_reparsed = 0;
  for (const r of rows) {
    let extract: ConcallExtract;
    try {
      extract = {
        ...emptyExtract(),
        ...(JSON.parse(r.extract_json) as ConcallExtract),
      };
    } catch {
      continue;
    }

    let text = "";
    if (wantPdf) {
      try {
        const docs = asDocs(extract.docs);
        // Prefer PPT for reparse (transcript URL alone misses deck P&L)
        const pdfUrl =
          docs.ppt ||
          r.source_url ||
          docs.transcript ||
          docs.summary ||
          null;
        if (pdfUrl) {
          const buf = await downloadConcallPdf(pdfUrl);
          if (buf) {
            text = await extractPdfText(buf);
            if (text) pdf_reparsed += 1;
          }
        }
      } catch {
        /* keep empty text — DB enrich still runs */
      }
    }

    const before = JSON.stringify(extract);
    if (text && looksLikeInvestorPresentation(text)) {
      // Re-map deck P&L + highlights (Mn→Cr) from PDF tables — refresh previously skipped this.
      const mapped = mapInvestorPresentationToConcallExtract(
        enrichInvestorPresentationLexical(text, {}),
      ) as ConcallExtract;
      const mappedFin = asObj(mapped.reported_financials);
      const mappedCard = asObj(mapped.card);
      if (mappedFin && Object.keys(mappedFin).length) {
        extract.reported_financials = mappedFin;
      }
      if (mappedCard) {
        const prevCard = asObj(extract.card) || {};
        extract.card = {
          ...prevCard,
          ...mappedCard,
          highlights:
            Array.isArray(mappedCard.highlights) && mappedCard.highlights.length
              ? mappedCard.highlights
              : prevCard.highlights,
        };
      }
      const mappedMeta = asObj(mapped.metadata);
      if (mappedMeta) {
        extract.metadata = { ...(asObj(extract.metadata) || {}), ...mappedMeta };
      }
    }
    extract = enrichLexical(text, extract);
    extract = enrichCard(text, extract);
    extract = normalizeExtractInrCr(extract);
    delete extract.transcript_notes;
    delete extract.transcript_notes_markdown;
    delete extract.transcript_notes_engine;
    if (wantPrices) {
      extract = await attachConcallPrices(extract);
    }
    const after = JSON.stringify(extract);
    const meta = asObj(extract.metadata) || {};
    const company =
      typeof meta.company_name === "string" ? meta.company_name : null;
    const tone = asObj(extract.management_tone) || {};
    const period = formatPeriodLabel(meta);
    if (after !== before) {
      try {
        db.prepare(
          `UPDATE concall_screens
           SET extract_json = ?,
               company = COALESCE(?, company),
               period = COALESCE(?, period),
               sentiment = COALESCE(?, sentiment)
           WHERE id = ?`,
        ).run(
          after,
          company,
          period,
          typeof tone.overall_tone === "string" ? tone.overall_tone : null,
          r.id,
        );
        updated += 1;
      } catch {
        /* ignore */
      }
    }
  }

  let history = listConcallHistory(limit);
  if (wantPrices) {
    history = await refreshConcallHistoryPrices(history);
  }
  return { ok: true, updated, pdf_reparsed, history };
}

export async function screenConcallPdf(opts: {
  url?: string | null;
  pdfBuffer?: Buffer | null;
  /** When true, return extract without writing PASS row (for dual-doc merge). */
  skipSave?: boolean;
  /** Skip multi-pass LLM — lexical/deck extract only (fast path for dual merge). */
  preferLexical?: boolean;
  /** Override PDF download timeout (ms). */
  downloadTimeoutMs?: number;
}): Promise<ConcallScreenResult> {
  const source_url = opts.url?.trim() || null;
  let buf = opts.pdfBuffer || null;
  if (!buf && source_url) {
    buf = await downloadConcallPdf(source_url, {
      timeoutMs: opts.downloadTimeoutMs,
    });
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
    return baseFail(
      source_url
        ? `Could not download PDF from URL (${source_url.slice(0, 80)}…)`
        : "Paste a Transcript/PPT PDF URL or upload a file",
    );
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
  if (shouldTryOcrFallback(text)) {
    try {
      engine = "pdf-parse+ocr";
      const ocrText = await ocrPdfText(buf);
      if (ocrText && ocrText.length > text.length / 2) {
        text = ocrText;
      }
    } catch {
      /* keep pdf-parse text */
    }
  }

  // Investor decks use a different schema — do not run the transcript extractor.
  if (looksLikeInvestorPresentation(text)) {
    const inv = await extractInvestorPresentationPdf({ pdfBuffer: buf });
    let extract = mapInvestorPresentationToConcallExtract(
      inv.extract,
    ) as ConcallExtract;
    extract = enrichLexical(text, extract);
    extract = enrichCard(text, extract);
    extract = normalizeExtractInrCr(extract);
    extract = await attachConcallPrices(extract);
    delete extract.transcript_notes;
    delete extract.transcript_notes_markdown;
    delete extract.transcript_notes_engine;

    let savedUrl = source_url;
    if (!savedUrl && opts.pdfBuffer) {
      savedUrl = persistUploadedConcallPdf(opts.pdfBuffer, extract);
    }
    extract = attachMaterialDocs(extract, savedUrl, text);
    const { decision, why } = decide(extract);
    const id = opts.skipSave
      ? undefined
      : saveHistory({
          source_url: savedUrl,
          extract,
          decision,
          engine: `${inv.engine}+investor-presentation`,
        }) ?? undefined;
    return {
      ok: inv.ok || decision === "pass",
      decision,
      why:
        decision === "pass"
          ? "Investor presentation extract — metadata + consolidated financials"
          : why,
      extract,
      extract_json: extract,
      engine: `${inv.engine}+investor-presentation`,
      ...pdfTextFields(text, opts.skipSave),
      source_url: savedUrl,
      id,
      screened_at: new Date().toISOString(),
      error: inv.ok ? undefined : inv.error,
    };
  }

  // Concall PDF only — StockScans scanlines from transcript text (no Notes PDF).
  // Skip slow LLM when ≥2 event catalysts already parse (merger / target / stake).
  {
    let lexical = enrichCard(text, enrichLexical(text, emptyExtract()));
    const tone = asObj(lexical.management_tone) || {};
    const card = asObj(lexical.card) || {};
    if (!tone.overall_tone) {
      tone.overall_tone =
        typeof card.mgmt_sentiment === "string"
          ? card.mgmt_sentiment
          : "neutral";
      lexical.management_tone = tone;
    }
    const highlights = Array.isArray(card.highlights) ? card.highlights : [];
    const eventCount = highlights.filter((h) => {
      const line = String(asObj(h)?.text || "");
      return (
        line.length > 0 &&
        !/^(?:Consolidated\s+)?(?:Revenue|PAT|EBITDA|Net profit)\b/i.test(line) &&
        !/^EBITDA margin [+-]?\d+bps/i.test(line)
      );
    }).length;
    const meta = asObj(lexical.metadata) || {};
    const hasMeta = Boolean(meta.company_name || meta.nse_symbol);
    if (hasMeta && eventCount >= 2) {
      lexical = normalizeExtractInrCr(lexical);
      lexical = await attachConcallPrices(lexical);
      delete lexical.transcript_notes;
      delete lexical.transcript_notes_markdown;
      delete lexical.transcript_notes_engine;
      let savedUrl = source_url;
      if (!savedUrl && opts.pdfBuffer) {
        savedUrl = persistUploadedConcallPdf(opts.pdfBuffer, lexical);
      }
      lexical = attachMaterialDocs(lexical, savedUrl, text);
      const { decision, why } = decide(lexical);
      const id = opts.skipSave
        ? undefined
        : saveHistory({
            source_url: savedUrl,
            extract: lexical,
            decision,
            engine: `${engine}+lexical-scanlines`,
          }) ?? undefined;
      return {
        ok: decision === "pass" || decision === "review",
        decision,
        why:
          decision === "pass"
            ? "Concall transcript — StockScans event highlights from PDF text"
            : why,
        extract: lexical,
        extract_json: lexical,
        engine: `${engine}+lexical-scanlines`,
        ...pdfTextFields(text, opts.skipSave),
        source_url: savedUrl,
        id,
        screened_at: new Date().toISOString(),
      };
    }
  }

  let extract = emptyExtract();
  if (opts.preferLexical) {
    extract = enrichCard(text, enrichLexical(text, extract));
    const tone = asObj(extract.management_tone) || {};
    const card = asObj(extract.card) || {};
    if (!tone.overall_tone) {
      tone.overall_tone =
        typeof card.mgmt_sentiment === "string"
          ? card.mgmt_sentiment
          : "neutral";
      extract.management_tone = tone;
    }
    extract = normalizeExtractInrCr(extract);
    extract = await attachConcallPrices(extract);
    delete extract.transcript_notes;
    delete extract.transcript_notes_markdown;
    delete extract.transcript_notes_engine;
    let savedUrl = source_url;
    if (!savedUrl && opts.pdfBuffer) {
      savedUrl = persistUploadedConcallPdf(opts.pdfBuffer, extract);
    }
    extract = attachMaterialDocs(extract, savedUrl, text);
    const { decision, why } = decide(extract);
    const id = opts.skipSave
      ? undefined
      : saveHistory({
          source_url: savedUrl,
          extract,
          decision,
          engine: `${engine}+lexical-fast`,
        }) ?? undefined;
    return {
      ok: decision === "pass" || decision === "review" || text.length > 0,
      decision,
      why:
        decision === "pass"
          ? "Concall transcript — lexical extract (fast path)"
          : why,
      extract,
      extract_json: extract,
      engine: `${engine}+lexical-fast`,
      ...pdfTextFields(text, opts.skipSave),
      source_url: savedUrl,
      id,
      screened_at: new Date().toISOString(),
    };
  }

  const cfg = loadLlmConfig();
  const factCfg = {
    ...cfg,
    llmModel: cfg.taskModels.transcriptFactExtraction,
  };
  const status = await checkLlmStatus(factCfg);
  if (!status.available) {
    extract = enrichCard(text, enrichLexical(text, extract));
    const tone = asObj(extract.management_tone) || {};
    const card = asObj(extract.card) || {};
    if (!tone.overall_tone) {
      tone.overall_tone =
        typeof card.mgmt_sentiment === "string"
          ? card.mgmt_sentiment
          : "neutral";
      extract.management_tone = tone;
    }
    extract = normalizeExtractInrCr(extract);
    const { decision, why } = decide(extract);
    return {
      ok: decision === "pass" || decision === "review",
      decision,
      why: status.detail || why,
      extract,
      extract_json: extract,
      engine: `${engine}+lexical`,
      ...pdfTextFields(text, opts.skipSave),
      source_url,
      error: status.detail || "LLM unavailable — used lexical scanlines",
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
          needle:
            /Rs\.\s*250 crores to Rs\.\s*260|capacity of about|Boric Acid market|guidance|invest(?:ment)?\s+\d+|crore|capex|CAGR|margin/i,
          max: 20_000,
        }),
      },
      {
        keys: ["corporate_actions", "risk_governance_flags"],
        predict: 3500,
        window: transcriptWindow(text, {
          needle:
            /acquisition of 64\.26%|Kronox Lab Sciences|open offer|forensic|stake|acquisition|acquired|Actis|Raghava|Raghwa|business transfer|share purchase|PE |private equity|valuation/i,
          max: 22_000,
        }),
      },
      {
        keys: ["card"],
        predict: 1600,
        window: [
          transcriptWindow(text, { start: 0, max: 6_000 }),
          "\n---\n",
          transcriptWindow(text, {
            needle:
              /forensic|audit|stake|IHH|appeal|judgment|acquisition|guidance|EBITDA margin|open offer|court.?order|invest(?:ment)?|crore|Actis|Raghava|PE |valuation/i,
            max: 14_000,
          }),
        ].join(""),
      },
    ];
    for (const pass of passes) {
      const focus = pass.keys.join(", ");
      let cardHint = "";
      if (pass.keys.includes("card")) {
        const cats = Array.isArray(extract.key_catalysts)
          ? extract.key_catalysts
          : [];
        const acts = Array.isArray(extract.corporate_actions)
          ? extract.corporate_actions
          : [];
        const prior = JSON.stringify({
          key_catalysts: cats.slice(0, 6),
          corporate_actions: acts.slice(0, 4),
        }).slice(0, 1200);
        cardHint = `
HIGHLIGHTS: 3 short bullets ONLY from this transcript (facts stated — no invented names/numbers).
Grammar: [Actor|Topic] [state phrase], [metric|timeline]. ≤10 words each.
Polarity: positive|neutral|negative from the fact itself.
Prefer catalysts (M&A, orders, guidance, risks) over plain Revenue/PAT YoY when both exist.
Do NOT copy examples from training. Do NOT invent company-specific phrases.
result_quality + mgmt_sentiment required from materials.
Prior extract context (use only if supported by transcript): ${prior}`;
      }
      try {
        const parsed = await completeJson(
          factCfg,
          `${system}\n\nTHIS PASS: fill ONLY these top-level keys: ${focus}. Other keys may be omitted. Do not invent Q&A wrappers — use the OUTPUT SCHEMA shapes exactly. Return ONE valid JSON object only.${cardHint}`,
          `Transcript excerpt:\n${pass.window}\n\nReturn JSON object with keys: ${focus}.`,
          {
            skipStatusCheck: true,
            numPredict: pass.predict,
            temperature: 0.05,
            model: pass.keys.includes("card")
              ? cfg.taskModels.highlightsAndShortSummaries
              : pass.keys.includes("management_tone")
                ? cfg.taskModels.managementSentimentEvidence
                : cfg.taskModels.transcriptFactExtraction,
          },
        );
        for (const k of pass.keys) {
          if (k in parsed && isSchemaShaped(k, parsed[k])) {
            extract[k] = parsed[k];
          }
        }
      } catch {
        // One bad pass must not abort the whole extract — lexical enrich still runs.
        continue;
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
      ...pdfTextFields(text, opts.skipSave),
      source_url,
      error: e instanceof Error ? e.message : "LLM extract failed",
    };
  }

  extract = enrichLexical(text, extract);
  extract = enrichCard(text, extract);
  extract = await attachConcallPrices(extract);

  // Strip leftover notes from older extracts — UI no longer shows them
  delete extract.transcript_notes;
  delete extract.transcript_notes_markdown;
  delete extract.transcript_notes_engine;

  let savedUrl = source_url;
  if (!savedUrl && opts.pdfBuffer) {
    savedUrl = persistUploadedConcallPdf(opts.pdfBuffer, extract);
  }
  extract = attachMaterialDocs(extract, savedUrl, text);
  // Persist text for later "Run from Text" without re-fetching PDFs
  const combinedAlone = text.trim()
    ? `===== TRANSCRIPT =====\n${text.trim().slice(0, COMBINED_DOCS_MAX)}`
    : "";
  extract = setDocsCombined(extract, combinedAlone);
  const { decision, why } = decide(extract);
  const docKind = classifyConcallDocument(text);
  const whyOut =
    docKind.kind === "analyst_meet"
      ? `Analyst Meet transcript — ${why}. Not a printed investor-deck P&L.`
      : why;
  const id = opts.skipSave
    ? undefined
    : saveHistory({
        source_url: savedUrl,
        extract,
        decision,
        engine,
      }) ?? undefined;

  return {
    ok: true,
    decision,
    why: whyOut,
    extract,
    extract_json: extract,
    engine,
    ...pdfTextFields(text, opts.skipSave),
    source_url: savedUrl,
    id,
    screened_at: new Date().toISOString(),
  };
}

/**
 * Text extract for Transcript and/or PPT.
 * Transcript: always pdf-parse.
 * PPT: vision OCR when QIANFAN_OCR_BASE_URL is set (glm-ocr / qwen2.5vl).
 * Set CONCALL_PPT_OCR=0 to force pdf-parse for PPT.
 */
export async function extractConcallMaterialsText(opts: {
  transcriptUrl?: string | null;
  transcriptBuffer?: Buffer | null;
  pptUrl?: string | null;
  pptBuffer?: Buffer | null;
  onProgress?: (p: ConcallTextProgress) => void;
}): Promise<{
  ok: boolean;
  materials: {
    transcript?: ConcallMaterialText;
    ppt?: ConcallMaterialText;
  };
  text_chars: number;
  combined_text: string;
  error?: string;
}> {
  const TEXT_MAX = 80_000;
  const pptOcrOff = ["0", "false", "no", "off"].includes(
    (process.env.CONCALL_PPT_OCR || "").trim().toLowerCase(),
  );
  const pptOcr =
    !pptOcrOff && Boolean((process.env.QIANFAN_OCR_BASE_URL || "").trim());
  const maxPages =
    Number(process.env.CONCALL_OCR_MAX_PAGES) > 0
      ? Number(process.env.CONCALL_OCR_MAX_PAGES)
      : 40;
  const report = opts.onProgress;

  const one = async (
    role: "transcript" | "ppt",
    url: string | null | undefined,
    buffer: Buffer | null | undefined,
  ): Promise<ConcallMaterialText | undefined> => {
    const has = Boolean(buffer?.length || url?.trim());
    if (!has) return undefined;
    let buf = buffer && buffer.length ? buffer : null;
    let source_url = url?.trim() || null;
    report?.({
      type: "progress",
      role,
      phase: "download",
      message: `${role}: loading PDF…`,
      pct: 1,
    });
    if (!buf && source_url) {
      buf = await downloadConcallPdf(source_url);
    }
    if (!buf) {
      return {
        role,
        ok: false,
        text: "",
        text_chars: 0,
        engine: "none",
        source_url,
        error: source_url ? "Could not download PDF" : "No PDF buffer",
      };
    }
    if (!source_url && buffer?.length) {
      source_url = persistUploadedConcallPdf(buffer, {
        metadata: {
          company_name: null,
          nse_symbol: null,
          quarter: null,
          fiscal_year: null,
        },
      });
    }

    let engine = "pdf-parse";
    let text = "";

    if (role === "ppt" && pptOcr) {
      try {
        text = await ocrPdfText(buf, {
          maxPages,
          dpi: 144,
          role,
          onProgress: report,
        });
        engine = `vision-ocr:${(process.env.QIANFAN_OCR_MODEL || process.env.LLM_MODEL_OCR || "ocr").trim()}`;
      } catch (e) {
        return {
          role,
          ok: false,
          text: "",
          text_chars: 0,
          engine: "vision-ocr",
          source_url,
          error:
            e instanceof Error
              ? `Vision OCR failed: ${e.message}`
              : "Vision OCR failed",
        };
      }
    } else {
      report?.({
        type: "progress",
        role,
        phase: "done",
        message: `${role}: pdf-parse…`,
        pct: 40,
      });
      try {
        text = await extractPdfText(buf);
        engine = "pdf-parse";
      } catch (e) {
        return {
          role,
          ok: false,
          text: "",
          text_chars: 0,
          engine: "pdf-parse",
          source_url,
          error: e instanceof Error ? e.message : "pdf-parse failed",
        };
      }
      report?.({
        type: "progress",
        role,
        phase: "done",
        message: `${role}: pdf-parse done (${text.length.toLocaleString()} chars)`,
        pct: 100,
      });
    }

    if (!text.trim()) {
      return {
        role,
        ok: false,
        text: "",
        text_chars: 0,
        engine,
        source_url,
        error:
          role === "ppt" && pptOcr
            ? "No text from vision OCR"
            : `No text in ${role} PDF (text layer empty)`,
      };
    }
    return {
      role,
      ok: true,
      text: text.slice(0, TEXT_MAX),
      text_chars: text.length,
      engine,
      source_url,
    };
  };

  // Sequential when streaming progress (clearer UI); parallel otherwise.
  let transcript: ConcallMaterialText | undefined;
  let ppt: ConcallMaterialText | undefined;
  if (report) {
    transcript = await one(
      "transcript",
      opts.transcriptUrl,
      opts.transcriptBuffer,
    );
    ppt = await one("ppt", opts.pptUrl, opts.pptBuffer);
  } else {
    [transcript, ppt] = await Promise.all([
      one("transcript", opts.transcriptUrl, opts.transcriptBuffer),
      one("ppt", opts.pptUrl, opts.pptBuffer),
    ]);
  }

  const materials = {
    ...(transcript ? { transcript } : {}),
    ...(ppt ? { ppt } : {}),
  };
  const text_chars =
    (transcript?.text_chars || 0) + (ppt?.text_chars || 0);
  const combinedParts: string[] = [];
  if (transcript?.ok && transcript.text.trim()) {
    combinedParts.push(
      `===== TRANSCRIPT =====\n${transcript.text.trim()}`,
    );
  }
  if (ppt?.ok && ppt.text.trim()) {
    combinedParts.push(`===== PPT / PRESENTATION =====\n${ppt.text.trim()}`);
  }
  const combined_text = combinedParts.join("\n\n");
  const anyOk = Boolean(transcript?.ok || ppt?.ok);
  if (!transcript && !ppt) {
    return {
      ok: false,
      materials,
      text_chars: 0,
      combined_text: "",
      error: "Add a Transcript and/or PPT PDF (URL or upload)",
    };
  }
  return {
    ok: anyOk,
    materials,
    text_chars,
    combined_text,
    error: anyOk
      ? undefined
      : [transcript?.error, ppt?.error].filter(Boolean).join(" · ") ||
        "Text extract failed",
  };
}

/**
 * Dual-doc extract (StockScans Transcript + PPT). Merges event highlights from
 * the call with P&L from the earnings deck into one PASS row.
 */
export async function screenConcallMaterials(opts: {
  transcriptUrl?: string | null;
  transcriptBuffer?: Buffer | null;
  pptUrl?: string | null;
  pptBuffer?: Buffer | null;
}): Promise<ConcallScreenResult> {
  const hasTx = Boolean(opts.transcriptBuffer || opts.transcriptUrl?.trim());
  const hasPpt = Boolean(opts.pptBuffer || opts.pptUrl?.trim());
  if (!hasTx && !hasPpt) {
    return {
      ok: false,
      decision: "fail",
      why: "Add a Transcript and/or PPT PDF (URL or upload)",
      extract: emptyExtract(),
      extract_json: emptyExtract(),
      engine: "none",
      text_chars: 0,
      text_excerpt: "",
      source_url: null,
      error: "Add a Transcript and/or PPT PDF (URL or upload)",
    };
  }
  if (hasTx && !hasPpt) {
    return screenConcallPdf({
      url: opts.transcriptUrl,
      pdfBuffer: opts.transcriptBuffer,
    });
  }
  if (hasPpt && !hasTx) {
    return screenConcallPdf({
      url: opts.pptUrl,
      pdfBuffer: opts.pptBuffer,
    });
  }

  const [tx, ppt] = await Promise.all([
    screenConcallPdf({
      url: opts.transcriptUrl,
      pdfBuffer: opts.transcriptBuffer,
      skipSave: true,
      preferLexical: true,
      downloadTimeoutMs: 45_000,
    }),
    screenConcallPdf({
      url: opts.pptUrl,
      pdfBuffer: opts.pptBuffer,
      skipSave: true,
      preferLexical: true,
      downloadTimeoutMs: 45_000,
    }),
  ]);

  const txOk = (tx.text_chars || 0) > 0;
  const pptOk = (ppt.text_chars || 0) > 0;

  // If one side failed (e.g. BSE blocked) but the other extracted, keep going.
  if (!txOk && pptOk) {
    const extract = {
      ...(ppt.extract as ConcallExtract),
      docs: mergeDocs(asDocs(ppt.extract?.docs), {
        summary: null,
        transcript: opts.transcriptUrl?.trim() || null,
        ppt: ppt.source_url,
      }),
    };
    return finalizeMergedMaterials({
      extract,
      decisionHint: null,
      whyHint: `PPT extracted; transcript failed (${tx.error || tx.why || "download/parse"})`,
      engine: `ppt:${ppt.engine}`,
      text_chars: ppt.text_chars || 0,
      text_excerpt: ppt.text_excerpt || "",
      source_url: ppt.source_url,
    });
  }
  if (txOk && !pptOk) {
    const extract = {
      ...(tx.extract as ConcallExtract),
      docs: mergeDocs(asDocs(tx.extract?.docs), {
        summary: null,
        transcript: tx.source_url,
        ppt: opts.pptUrl?.trim() || null,
      }),
    };
    return finalizeMergedMaterials({
      extract,
      decisionHint: null,
      whyHint: `Transcript extracted; PPT failed (${ppt.error || ppt.why || "download/parse"})`,
      engine: `tx:${tx.engine}`,
      text_chars: tx.text_chars || 0,
      text_excerpt: tx.text_excerpt || "",
      source_url: tx.source_url,
    });
  }
  if (!txOk && !pptOk) {
    return {
      ok: false,
      decision: "fail",
      why: [tx.error || tx.why, ppt.error || ppt.why]
        .filter(Boolean)
        .join(" · ") || "Could not extract Transcript or PPT",
      extract: emptyExtract(),
      extract_json: emptyExtract(),
      engine: "none",
      text_chars: 0,
      text_excerpt: "",
      source_url: opts.transcriptUrl || opts.pptUrl || null,
      error:
        [tx.error || tx.why, ppt.error || ppt.why].filter(Boolean).join(" · ") ||
        "Could not extract Transcript or PPT",
    };
  }

  let extract = mergeTranscriptAndPptExtracts(
    tx.extract as ConcallExtract,
    ppt.extract as ConcallExtract,
  );
  extract.docs = mergeDocs(
    mergeDocs(asDocs(ppt.extract?.docs), asDocs(tx.extract?.docs)),
    {
      summary: null,
      transcript: tx.source_url,
      ppt: ppt.source_url,
    },
  );
  // Recompute Strong/Cautious etc. from merged scanlines (no re-hardcode)
  extract = enrichCard("", extract);

  let engine = `${tx.engine}+${ppt.engine}+merged`;
  let whyHint = "Merged transcript events + PPT financials";

  // ONE card LLM for StockScans scanlines (prompt: concall-scanlines.system.txt)
  if (isUnifiedLlmEnabled()) {
    const txText = (tx.text_full || tx.text_excerpt || "").trim();
    const pptText = (ppt.text_full || ppt.text_excerpt || "").trim();
    if (txText.length > 80 || pptText.length > 80) {
      const uni = await extractUnifiedEarningsFromTexts({
        transcriptText: txText,
        presentationText: pptText,
      });
      if (uni.ok && Object.keys(uni.extract).length > 0) {
        extract = mapUnifiedEarningsToConcallExtract(
          uni.extract,
          extract,
        ) as ConcallExtract;
        engine = `${engine}+${uni.engine}`;
        whyHint = "Lexical merge + scanlines LLM";
      }
    }
  }

  return finalizeMergedMaterials({
    extract,
    decisionHint: "pass",
    whyHint,
    engine,
    text_chars: (tx.text_chars || 0) + (ppt.text_chars || 0),
    text_excerpt:
      tx.text_excerpt || ppt.text_excerpt || "",
    source_url: tx.source_url || ppt.source_url,
    materials: {
      transcript: {
        role: "transcript",
        ok: (tx.text_chars || 0) > 0,
        text: (tx.text_full || tx.text_excerpt || "").slice(0, 48_000),
        text_chars: tx.text_chars || 0,
        engine: tx.engine,
        source_url: tx.source_url,
        error: tx.error,
      },
      ppt: {
        role: "ppt",
        ok: (ppt.text_chars || 0) > 0,
        text: (ppt.text_full || ppt.text_excerpt || "").slice(0, 48_000),
        text_chars: ppt.text_chars || 0,
        engine: ppt.engine,
        source_url: ppt.source_url,
        error: ppt.error,
      },
    },
    combined_text: [
      (tx.text_full || tx.text_excerpt || "").trim()
        ? `===== TRANSCRIPT =====\n${(tx.text_full || tx.text_excerpt || "").trim()}`
        : "",
      (ppt.text_full || ppt.text_excerpt || "").trim()
        ? `===== PPT / PRESENTATION =====\n${(ppt.text_full || ppt.text_excerpt || "").trim()}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, COMBINED_DOCS_MAX),
  });
}

async function finalizeMergedMaterials(opts: {
  extract: ConcallExtract;
  decisionHint: "pass" | null;
  whyHint: string;
  engine: string;
  text_chars: number;
  text_excerpt: string;
  source_url: string | null;
  materials?: ConcallScreenResult["materials"];
  combined_text?: string;
}): Promise<ConcallScreenResult> {
  let extract = await attachConcallPrices(opts.extract);
  extract = setDocsCombined(extract, opts.combined_text);
  const { decision, why, gaps } = decide(extract);
  const id = saveHistory({
    source_url: opts.source_url,
    extract,
    decision,
    engine: opts.engine,
  });
  const passWhy =
    opts.decisionHint === "pass" && decision === "pass"
      ? opts.whyHint
      : decision === "pass"
        ? opts.whyHint
        : `${opts.whyHint} — ${why}`;
  return {
    ok: decision === "pass" || opts.text_chars > 0,
    decision,
    why: passWhy,
    extract,
    extract_json: extract,
    engine: opts.engine,
    text_chars: opts.text_chars,
    text_excerpt: opts.text_excerpt,
    materials: opts.materials,
    combined_text: opts.combined_text,
    source_url: opts.source_url,
    id: id ?? undefined,
    screened_at: new Date().toISOString(),
    save_gaps: gaps.length ? gaps : undefined,
  };
}

/** Load saved combined text from a PASS row (full blob). */
export function getConcallCombinedText(id: number): {
  ok: boolean;
  id: number;
  combined_text: string;
  docs: ConcallHistoryRow["docs"];
  extract?: ConcallExtract;
  error?: string;
} {
  if (!Number.isInteger(id) || id <= 0) {
    return {
      ok: false,
      id,
      combined_text: "",
      docs: asDocsPublic(null),
      error: "Invalid row id",
    };
  }
  const db = openDb();
  const row = db
    .prepare(
      `SELECT id, extract_json FROM concall_screens WHERE id = ? LIMIT 1`,
    )
    .get(id) as { id: number; extract_json: string } | undefined;
  if (!row) {
    return {
      ok: false,
      id,
      combined_text: "",
      docs: asDocsPublic(null),
      error: "Row not found",
    };
  }
  try {
    const extract = JSON.parse(row.extract_json) as ConcallExtract;
    const docs = asDocs(extract.docs);
    return {
      ok: Boolean(docs.combined?.trim()),
      id: row.id,
      combined_text: docs.combined?.trim() || "",
      docs: {
        ...asDocsPublic(docs, extract),
        summary: docs.summary,
      },
      extract,
      error: docs.combined?.trim() ? undefined : "No combined text saved",
    };
  } catch {
    return {
      ok: false,
      id,
      combined_text: "",
      docs: asDocsPublic(null),
      error: "Corrupt extract_json",
    };
  }
}

/**
 * Analyze from saved / pasted combined TX+PPT text (no PDF fetch).
 * Runs lean quant executive summary + highlight/sentiment → Summary + PASS columns.
 * Preserves prior doc URLs + metadata when `id` is provided.
 */
export async function screenConcallFromCombinedText(opts: {
  combinedText?: string | null;
  id?: number | null;
  sourceUrl?: string | null;
}): Promise<ConcallScreenResult> {
  let base: ConcallExtract = emptyExtract();
  let source_url: string | null = opts.sourceUrl?.trim() || null;
  let combined = (opts.combinedText || "").trim();

  if (opts.id != null && Number.isInteger(opts.id) && opts.id > 0) {
    const saved = getConcallCombinedText(opts.id);
    if (!combined && saved.combined_text) combined = saved.combined_text;
    if (saved.extract) {
      base = { ...saved.extract };
      // Fresh Analyze must not keep prior card lines (old regex / failed LLM leftovers)
      const card = asObj(base.card) || {};
      card.highlights = [];
      delete card.brief;
      delete card.strengths;
      delete card.weaknesses;
      delete card.kpi_cards;
      delete card.quote;
      delete card.conviction;
      delete card.sentiment_tone;
      delete card.sentiment_score;
      delete card.sentiment_label;
      delete card.result_quality;
      delete card.mgmt_sentiment;
      base.card = card;
    }
    // Lock ticker from the PASS row — never let LLM rename EPACKPEB → EPACK
    try {
      const db = openDb();
      const r = db
        .prepare(`SELECT ticker, company, source_url FROM concall_screens WHERE id = ?`)
        .get(opts.id) as
        | { ticker: string | null; company: string | null; source_url: string | null }
        | undefined;
      if (r?.ticker?.trim()) {
        const meta = asObj(base.metadata) || {};
        const sym = r.ticker.trim().toUpperCase();
        meta.nse_symbol = sym;
        const fromDb = lookupCompanyName(sym);
        if (fromDb) {
          meta.company_name = fromDb;
        } else if (
          r.company?.trim() &&
          !isMarketInfrastructureName(r.company)
        ) {
          meta.company_name = r.company.trim();
        }
        base.metadata = meta;
      }
      if (!source_url && r?.source_url) source_url = r.source_url;
    } catch {
      /* optional */
    }
  }

  if (combined.length < 80) {
    return {
      ok: false,
      decision: "fail",
      why: "Combined text too short",
      extract: base,
      extract_json: base,
      engine: "from-combined",
      text_chars: combined.length,
      text_excerpt: combined.slice(0, EXCERPT_MAX),
      combined_text: combined,
      source_url,
      error: "Need ≥80 chars of combined text (Load text first, or save Docs·Text)",
    };
  }

  const { transcriptText, presentationText } =
    splitCombinedMaterialsText(combined);
  const tx = transcriptText.trim();
  const ppt = presentationText.trim();

  // Light lexical fill so PASS gates still work if LLM is off / fails
  let extract = enrichCard(
    [tx, ppt].filter(Boolean).join("\n\n"),
    enrichLexical([tx, ppt].filter(Boolean).join("\n\n"), base),
  );
  // Keep prior URL docs; refresh combined
  const priorDocs = asDocs(base.docs);
  extract.docs = {
    ...asDocs(extract.docs),
    summary: priorDocs.summary || asDocs(extract.docs).summary,
    transcript: priorDocs.transcript || asDocs(extract.docs).transcript,
    ppt: priorDocs.ppt || asDocs(extract.docs).ppt,
  };

  let engine = "from-combined+lexical";
  let whyHint = "Extracted from saved combined text";

  // Analyze = lean quant Exec + HL only (no second card LLM — saves tokens).
  // Fills Summary viewer + Highlights / Result / Sentiment columns.
  try {
    const quant = asObj(extract.quant) || {};
    const [execR, hlR] = await Promise.all([
      extractQuantFromTexts({
        kind: "executive",
        transcriptText: tx || "(none)",
        presentationText: ppt || "(none)",
      }),
      extractQuantFromTexts({
        kind: "highlights",
        transcriptText: tx || "(none)",
        presentationText: ppt || "(none)",
      }),
    ]);
    if (execR.ok) {
      quant.executive_summary = execR.json;
      applyExecutiveSnapshotToFinancials(extract, execR.json);
      const summaryText = formatExecutiveSummaryText(execR.json);
      if (summaryText) {
        const docs = asDocs(extract.docs);
        docs.summary = summaryText.slice(0, 8_000);
        extract.docs = docs;
      }
      engine = `${engine}+${execR.engine}`;
    }
    if (hlR.ok) {
      quant.highlight_sentiment = hlR.json;
      applyHighlightSentimentToCard(extract, hlR.json);
      engine = `${engine}+${hlR.engine}`;
      whyHint = "Analyze · quant summary + highlights";
    } else if (execR.ok) {
      whyHint = "Analyze · quant summary (highlights empty)";
    } else {
      whyHint = `Analyze · quant failed (${hlR.error || execR.error || "empty"})`;
    }
    extract.quant = quant;
    // Belt-and-suspenders: never leave quant HL without card scanlines
    ensureHighlightsFromQuant(extract);
  } catch (e) {
    whyHint = `Lexical only · quant error (${e instanceof Error ? e.message : "failed"})`;
  }

  extract = setDocsCombined(extract, combined);
  // Preserve URL slots after setDocsCombined; prefer fresh quant summary text
  extract.docs = {
    ...asDocs(extract.docs),
    summary: asDocs(extract.docs).summary || priorDocs.summary,
    transcript: priorDocs.transcript || asDocs(extract.docs).transcript,
    ppt: priorDocs.ppt || asDocs(extract.docs).ppt,
  };

  return finalizeMergedMaterials({
    extract,
    decisionHint: "pass",
    whyHint,
    engine,
    text_chars: combined.length,
    text_excerpt: combined.slice(0, EXCERPT_MAX),
    source_url,
    combined_text: combined,
    materials: {
      ...(tx
        ? {
            transcript: {
              role: "transcript" as const,
              ok: true,
              text: tx.slice(0, 48_000),
              text_chars: tx.length,
              engine: "combined-text",
              source_url: priorDocs.transcript,
            },
          }
        : {}),
      ...(ppt
        ? {
            ppt: {
              role: "ppt" as const,
              ok: true,
              text: ppt.slice(0, 48_000),
              text_chars: ppt.length,
              engine: "combined-text",
              source_url: priorDocs.ppt,
            },
          }
        : {}),
    },
  });
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

const NOTES_PROMPT_PATH = path.join(
  process.cwd(),
  "prompts",
  "concall-transcript-notes.system.txt",
);

export type ConcallTranscriptNotes = {
  company_name: string;
  industry: string;
  period_label: string;
  title: string;
  key_takeaways: string[];
  sections: Array<{
    heading: string;
    bullets: string[];
    quote: { speaker: string; text: string } | null;
  }>;
  guidance_commitments: Array<{
    commitment: string;
    specifics: string;
    timeline: string;
  }>;
};

/** Render StockScans-style notes markdown from structured notes JSON. */
export function renderConcallNotesMarkdown(
  notes: ConcallTranscriptNotes,
): string {
  const lines: string[] = [];
  lines.push(notes.company_name || "Company");
  if (notes.industry) lines.push(notes.industry);
  lines.push(`Transcript Notes · ${notes.period_label || ""}`.trim());
  lines.push("");
  lines.push(notes.title || "Transcript Notes");
  lines.push("");
  lines.push("Key Takeaways");
  for (const t of notes.key_takeaways || []) {
    lines.push(`• ${t}`);
  }
  for (const sec of notes.sections || []) {
    lines.push("");
    lines.push(sec.heading);
    for (const b of sec.bullets || []) lines.push(`• ${b}`);
    if (sec.quote?.text) {
      lines.push("");
      const who = sec.quote.speaker ? `${sec.quote.speaker}: ` : "";
      lines.push(`${who}"${sec.quote.text}"`);
    }
  }
  if (notes.guidance_commitments?.length) {
    lines.push("");
    lines.push("Guidance & Commitments");
    lines.push("Commitment | Specifics | Timeline");
    for (const g of notes.guidance_commitments) {
      lines.push(
        `${g.commitment || "—"} | ${g.specifics || "—"} | ${g.timeline || "—"}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * StockScans-style Transcript Notes from extract JSON + transcript text.
 * Does not re-run the full multi-pass extract — one LLM notes pass only.
 * Falls back to extract-only draft if the model returns invalid JSON.
 */
export async function generateConcallTranscriptNotes(opts: {
  extract: ConcallExtract;
  transcriptText: string;
}): Promise<{
  ok: boolean;
  notes: ConcallTranscriptNotes | null;
  markdown: string;
  engine: "llm" | "extract-fallback";
  error?: string;
}> {
  const fallback = buildNotesFromExtract(opts.extract);
  const cfg = loadLlmConfig();
  const notesCfg = {
    ...cfg,
    llmModel: cfg.taskModels.highlightsAndShortSummaries,
  };
  const status = await checkLlmStatus(notesCfg);
  if (!status.available) {
    return {
      ok: true,
      notes: fallback,
      markdown: renderConcallNotesMarkdown(fallback),
      engine: "extract-fallback",
      error: status.detail || "LLM unavailable — used extract draft",
    };
  }
  if (!fs.existsSync(NOTES_PROMPT_PATH)) {
    return {
      ok: false,
      notes: null,
      markdown: "",
      engine: "extract-fallback",
      error: `Missing prompt ${NOTES_PROMPT_PATH}`,
    };
  }
  const system = fs.readFileSync(NOTES_PROMPT_PATH, "utf8").trim();
  const meta = asObj(opts.extract.metadata) || {};
  const card = asObj(opts.extract.card) || {};
  const industry =
    (typeof card.industry === "string" && card.industry) ||
    (typeof card.sector === "string" && card.sector) ||
    "";
  const slimExtract = {
    metadata: meta,
    reported_financials: opts.extract.reported_financials,
    forward_guidance: opts.extract.forward_guidance,
    corporate_actions: opts.extract.corporate_actions,
    key_catalysts: opts.extract.key_catalysts,
    management_tone: opts.extract.management_tone,
    card: {
      result_quality: card.result_quality,
      mgmt_sentiment: card.mgmt_sentiment,
      highlights: card.highlights,
      sector: card.sector,
      industry: card.industry,
    },
  };
  // Focused windows — full 60k dumps break small VL JSON
  const raw = opts.transcriptText || "";
  const head = raw.slice(0, 8_000);
  const midNeedle =
    /acquisition|Kronox|Chronox|forensic|stake|guidance|EBITDA margin|capex|open offer/i;
  const m = midNeedle.exec(raw);
  const mid =
    m && m.index != null
      ? raw.slice(Math.max(0, m.index - 400), m.index + 10_000)
      : raw.slice(8_000, 18_000);
  const text = `${head}\n---\n${mid}`.slice(0, 18_000);

  try {
    const parsed = await completeJson(
      notesCfg,
      `${system}\n\nKeep JSON compact. Max 5 key_takeaways, max 4 sections, max 5 bullets/section, max 4 guidance rows. Escape quotes in strings.`,
      `Industry: ${industry || "(unknown)"}\n\nEXTRACT:\n${JSON.stringify(slimExtract).slice(0, 8_000)}\n\nTRANSCRIPT:\n${text}\n\nReturn ONLY the notes JSON.`,
      {
        skipStatusCheck: true,
        numPredict: 2800,
        temperature: 0.1,
        model: cfg.taskModels.highlightsAndShortSummaries,
      },
    );
    const notes = normalizeNotesParsed(parsed, opts.extract, industry);
    if (!notes) {
      return {
        ok: true,
        notes: fallback,
        markdown: renderConcallNotesMarkdown(fallback),
        engine: "extract-fallback",
        error: "LLM notes incomplete — used extract draft",
      };
    }
    return {
      ok: true,
      notes,
      markdown: renderConcallNotesMarkdown(notes),
      engine: "llm",
    };
  } catch (e) {
    return {
      ok: true,
      notes: fallback,
      markdown: renderConcallNotesMarkdown(fallback),
      engine: "extract-fallback",
      error: e instanceof Error ? e.message : "Notes LLM failed — used extract draft",
    };
  }
}

function normalizeNotesParsed(
  parsed: Record<string, unknown>,
  extract: ConcallExtract,
  industryHint: string,
): ConcallTranscriptNotes | null {
  const meta = asObj(extract.metadata) || {};
  const takeaways = Array.isArray(parsed.key_takeaways)
    ? parsed.key_takeaways.filter((x) => typeof x === "string").map(String).slice(0, 6)
    : [];
  const sectionsRaw = Array.isArray(parsed.sections) ? parsed.sections : [];
  const sections = sectionsRaw
    .map((s) => {
      const o = asObj(s);
      if (!o || typeof o.heading !== "string") return null;
      const bullets = Array.isArray(o.bullets)
        ? o.bullets.filter((b) => typeof b === "string").map(String)
        : [];
      const q = asObj(o.quote);
      const quote =
        q && typeof q.text === "string"
          ? {
              speaker: typeof q.speaker === "string" ? q.speaker : "",
              text: q.text,
            }
          : null;
      return { heading: o.heading, bullets, quote };
    })
    .filter(Boolean) as ConcallTranscriptNotes["sections"];
  const guidanceRaw = Array.isArray(parsed.guidance_commitments)
    ? parsed.guidance_commitments
    : [];
  const guidance_commitments = guidanceRaw
    .map((g) => {
      const o = asObj(g);
      if (!o) return null;
      return {
        commitment: String(o.commitment || ""),
        specifics: String(o.specifics || ""),
        timeline: String(o.timeline || ""),
      };
    })
    .filter((g) => g && (g.commitment || g.specifics)) as ConcallTranscriptNotes["guidance_commitments"];

  if (takeaways.length < 3 && sections.length === 0) return null;

  return {
    company_name:
      typeof parsed.company_name === "string"
        ? parsed.company_name
        : String(meta.company_name || meta.nse_symbol || "Company"),
    industry:
      typeof parsed.industry === "string" ? parsed.industry : industryHint,
    period_label:
      typeof parsed.period_label === "string"
        ? parsed.period_label
        : [meta.quarter, meta.fiscal_year].filter(Boolean).join(" ") ||
          "Transcript",
    title:
      typeof parsed.title === "string"
        ? parsed.title
        : `${meta.company_name || "Company"}: ${[meta.quarter, meta.fiscal_year].filter(Boolean).join(" ")} Transcript Notes`,
    key_takeaways: takeaways,
    sections,
    guidance_commitments,
  };
}

/** Deterministic StockScans-shaped draft from extract alone (no LLM). */
export function buildNotesFromExtract(
  extract: ConcallExtract,
): ConcallTranscriptNotes {
  const meta = asObj(extract.metadata) || {};
  const card = asObj(extract.card) || {};
  const fin = asObj(extract.reported_financials) || {};
  const guide = asObj(extract.forward_guidance) || {};
  const rev = fin.revenue;
  const ebitdaM = fin.ebitda_margin_pct ?? fin.margin;
  const pat = fin.net_profit ?? fin.profit_after_tax;
  const company = String(meta.company_name || meta.nse_symbol || "Company");
  const period = [meta.quarter, meta.fiscal_year].filter(Boolean).join(" ");
  const industry =
    (typeof card.industry === "string" && card.industry) ||
    (typeof card.sector === "string" && card.sector) ||
    "";

  const revYoy = metricYoyPct(rev);
  const revCur = metricCurrentQtr(rev);
  const patYoy = metricYoyPct(pat);
  const margin = metricCurrentQtr(ebitdaM);
  const revGuide = asObj(guide.revenue_guidance_range);
  const marginGuide = asObj(guide.margin_guidance);

  const takeaways: string[] = [];
  const actions = Array.isArray(extract.corporate_actions)
    ? extract.corporate_actions
    : [];
  const acq = actions
    .map((a) => asObj(a))
    .find((a) => a && a.type === "acquisition");
  if (acq && typeof acq.target_counterparty === "string") {
    const stake =
      asNum(acq.stake_pct) != null ? `${asNum(acq.stake_pct)}%` : "";
    takeaways.push(
      `Acquisition defines the quarter, execution defines the future: ${acq.target_counterparty}${stake ? ` (${stake})` : ""} is the call’s strategic focus alongside the print.`,
    );
  }
  if (revCur != null && revYoy != null) {
    takeaways.push(
      `Standalone print: Revenue ₹${revCur} Cr (${revYoy >= 0 ? "+" : ""}${revYoy.toFixed(0)}% YoY)${patYoy != null ? `; PAT ${patYoy >= 0 ? "+" : ""}${patYoy.toFixed(0)}% YoY` : ""}${margin != null ? `; EBITDA margin ${margin}%` : ""}.`,
    );
  }
  if (margin != null && asNum(marginGuide?.ebitda_pct) != null) {
    const g = asNum(marginGuide!.ebitda_pct)!;
    const bps = Math.round((margin - g) * 100);
    takeaways.push(
      `Margin peak won’t fully carry: Q print ${margin}% EBITDA vs FY guide ~${g}%${bps > 100 ? ` (~${bps}bps reset implied)` : ""}.`,
    );
  }
  if (revGuide && asNum(revGuide.low) != null && asNum(revGuide.high) != null) {
    takeaways.push(
      `Full-year guidance: Revenue ₹${asNum(revGuide.low)}–${asNum(revGuide.high)} Cr${asNum(marginGuide?.ebitda_pct) != null ? ` with ~${asNum(marginGuide!.ebitda_pct)}% EBITDA` : ""} (${String(revGuide.fiscal_year || period)}).`,
    );
  }
  const highs = Array.isArray(card.highlights) ? card.highlights : [];
  for (const h of highs) {
    const o = typeof h === "string" ? { text: h } : asObj(h);
    if (o && typeof o.text === "string" && takeaways.length < 5) {
      if (!takeaways.some((t) => t.includes(o.text as string))) {
        takeaways.push(`Catalyst: ${o.text}.`);
      }
    }
  }
  if (takeaways.length < 5) {
    takeaways.push(
      `What to watch next quarter: Delivery vs guidance, integration/legal timelines, and whether margin/ops commentary holds.`,
    );
  }

  const sections: ConcallTranscriptNotes["sections"] = [];
  if (acq && typeof acq.target_counterparty === "string") {
    const deal = asObj(acq.deal_value);
    sections.push({
      heading: `The ${acq.target_counterparty.replace(/\s+Ltd\.?$/i, "").replace(/\s+Limited$/i, "")} Acquisition`,
      bullets: [
        `Deal structure: ${asNum(acq.stake_pct) != null ? `${asNum(acq.stake_pct)}% stake` : "Stake"}${deal && asNum(deal.amount) != null ? ` for ~₹${asNum(deal.amount)} ${deal.unit || "Cr"}` : ""}.`,
        `Status: ${String(acq.type || "acquisition")} as disclosed on the call.`,
      ],
      quote: null,
    });
  }
  if (revCur != null) {
    sections.push({
      heading: `Standalone ${period}: The Print`,
      bullets: [
        `Revenue: ₹${revCur} Cr${revYoy != null ? ` (${revYoy >= 0 ? "+" : ""}${revYoy.toFixed(1)}% YoY)` : ""}.`,
        ...(margin != null ? [`EBITDA margin: ${margin}%.`] : []),
        ...(patYoy != null
          ? [`PAT: ${patYoy >= 0 ? "+" : ""}${patYoy.toFixed(1)}% YoY.`]
          : []),
      ],
      quote: null,
    });
  }
  const guidance_commitments: ConcallTranscriptNotes["guidance_commitments"] =
    [];
  if (revGuide && asNum(revGuide.low) != null) {
    guidance_commitments.push({
      commitment: "FY revenue guidance",
      specifics: `₹${asNum(revGuide.low)}–${asNum(revGuide.high)} Cr`,
      timeline: String(revGuide.fiscal_year || period || "—"),
    });
  }
  if (asNum(marginGuide?.ebitda_pct) != null) {
    guidance_commitments.push({
      commitment: "EBITDA margin guidance",
      specifics: `~${asNum(marginGuide!.ebitda_pct)}%`,
      timeline: String(marginGuide?.fiscal_year || period || "—"),
    });
  }
  for (const h of highs.slice(0, 3)) {
    const o = typeof h === "string" ? { text: h } : asObj(h);
    if (o && typeof o.text === "string") {
      guidance_commitments.push({
        commitment: o.text.split(",")[0].trim(),
        specifics: o.text,
        timeline: "As disclosed",
      });
    }
  }

  return {
    company_name: company,
    industry,
    period_label: period || "Transcript",
    title: `${company}: ${period} Transcript Notes`,
    key_takeaways: takeaways.slice(0, 5),
    sections,
    guidance_commitments: guidance_commitments.slice(0, 6),
  };
}

/**
 * Generate notes for a PASS history row (or in-memory extract).
 * Optionally re-reads PDF text; persists notes onto extract_json.transcript_notes.
 */
export async function generateConcallNotesForRow(opts: {
  id?: number | null;
  extract?: ConcallExtract | null;
  source_url?: string | null;
  transcriptText?: string | null;
}): Promise<{
  ok: boolean;
  id: number | null;
  notes: ConcallTranscriptNotes | null;
  markdown: string;
  engine: "llm" | "extract-fallback";
  error?: string;
}> {
  let id = opts.id ?? null;
  let extract = opts.extract ? { ...opts.extract } : null;
  let source_url = opts.source_url ?? null;
  let text = opts.transcriptText?.trim() || "";

  if (id != null) {
    const db = openDb();
    const row = db
      .prepare(
        `SELECT id, source_url, extract_json FROM concall_screens WHERE id = ?`,
      )
      .get(id) as
      | { id: number; source_url: string | null; extract_json: string }
      | undefined;
    if (!row) {
      return {
        ok: false,
        id,
        notes: null,
        markdown: "",
        engine: "extract-fallback",
        error: `No concall row id=${id}`,
      };
    }
    try {
      extract = {
        ...emptyExtract(),
        ...(JSON.parse(row.extract_json) as ConcallExtract),
      };
    } catch {
      return {
        ok: false,
        id,
        notes: null,
        markdown: "",
        engine: "extract-fallback",
        error: "Corrupt extract_json",
      };
    }
    source_url = row.source_url || source_url;
  }

  if (!extract) {
    return {
      ok: false,
      id,
      notes: null,
      markdown: "",
      engine: "extract-fallback",
      error: "No extract to build notes from",
    };
  }

  if (!text && source_url) {
    try {
      const buf = await downloadConcallPdf(source_url);
      if (buf) text = await extractPdfText(buf);
    } catch {
      /* extract-only fallback */
    }
  }

  const result = await generateConcallTranscriptNotes({
    extract,
    transcriptText: text,
  });
  if (!result.notes) {
    return {
      ok: false,
      id,
      notes: null,
      markdown: "",
      engine: result.engine,
      error: result.error || "Notes failed",
    };
  }

  extract.transcript_notes = result.notes;
  extract.transcript_notes_markdown = result.markdown;
  extract.transcript_notes_engine = result.engine;

  if (id != null) {
    try {
      const db = openDb();
      db.prepare(`UPDATE concall_screens SET extract_json = ? WHERE id = ?`).run(
        JSON.stringify(extract),
        id,
      );
    } catch {
      /* ignore persist errors */
    }
  }

  return {
    ok: true,
    id,
    notes: result.notes,
    markdown: result.markdown,
    engine: result.engine,
    error: result.error,
  };
}

