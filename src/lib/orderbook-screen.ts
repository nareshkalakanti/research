/**
 * Order-win Research — Reg-30 Annexure A / order announcement PDFs.
 * Core fields: Awarding entity, Order size (as stated), Execution.
 */
import { ocrImageWithQianfan } from "./corporate-data-extract";
import { downloadBuybackPdf } from "./buyback-screen";
import { rasterizePdfPages } from "./pdf-rasterize";
import { fetchScreenerAnnual } from "./screener-annual";
import { openSqliteNamed } from "./sqlite-utils";
import { fetchDailyBars } from "./ohlc";
import { fetchQuoteDetailed } from "./yfinance";
import {
  baselineCloseBefore,
  computeDriftPct,
} from "./strategy/concall-drift-math";

export type FxCurrency = "USD" | "EUR" | "GBP";

/** Fallback INR per 1 foreign unit when filing omits FX. */
export const DEFAULT_FX_INR: Record<FxCurrency, number> = {
  USD: 88,
  EUR: 110.67,
  GBP: 112,
};

/** @deprecated use DEFAULT_FX_INR.USD */
export const DEFAULT_USD_INR_MARKET = DEFAULT_FX_INR.USD;

const FX_SANITY: Record<FxCurrency, [number, number]> = {
  USD: [50, 150],
  EUR: [70, 130],
  GBP: [80, 150],
};

/**
 * Free FX via open.er-api.com (no key).
 * Returns converted amount + rate (to INR by default).
 */
export async function convertCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency = "INR",
): Promise<{ converted: number; rate: number } | null> {
  const from = fromCurrency.trim().toUpperCase();
  const to = toCurrency.trim().toUpperCase();
  if (!from || !to || !Number.isFinite(amount)) return null;
  if (from === to) return { converted: amount, rate: 1 };
  try {
    const response = await fetch(
      `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      result?: string;
      rates?: Record<string, number>;
    };
    if (data.result && data.result !== "success") return null;
    const rate = data.rates?.[to];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      return null;
    }
    return { converted: amount * rate, rate };
  } catch {
    return null;
  }
}

/** Live USD/INR; null on failure (caller falls back to DEFAULT_FX_INR). */
export async function fetchUsdInrMarketRate(): Promise<number | null> {
  const rates = await fetchInrFxMarketRates();
  return rates.USD ?? null;
}

/** Live INR crosses — open.er-api.com first (free), Yahoo fallback. */
export async function fetchInrFxMarketRates(): Promise<
  Partial<Record<FxCurrency, number>>
> {
  const out: Partial<Record<FxCurrency, number>> = {};
  const currencies: FxCurrency[] = ["USD", "EUR", "GBP"];

  await Promise.all(
    currencies.map(async (cur) => {
      const conv = await convertCurrency(1, cur, "INR");
      if (!conv) return;
      const [lo, hi] = FX_SANITY[cur];
      if (conv.rate >= lo && conv.rate <= hi) {
        out[cur] = Math.round(conv.rate * 100) / 100;
      }
    }),
  );

  // Fill gaps via Yahoo if er-api missed any
  const missing = currencies.filter((c) => out[c] == null);
  if (missing.length) {
    try {
      const YahooFinance = (await import("yahoo-finance2")).default;
      const yf = new YahooFinance({
        suppressNotices: ["yahooSurvey"],
        validation: { logErrors: false, logOptionsErrors: false },
      });
      const yfSym: Record<FxCurrency, string> = {
        USD: "INR=X",
        EUR: "EURINR=X",
        GBP: "GBPINR=X",
      };
      await Promise.all(
        missing.map(async (cur) => {
          try {
            const q = await yf.quote(yfSym[cur]);
            const p =
              typeof q === "object" && q && "regularMarketPrice" in q
                ? Number(
                    (q as { regularMarketPrice?: number }).regularMarketPrice,
                  )
                : NaN;
            const [lo, hi] = FX_SANITY[cur];
            if (Number.isFinite(p) && p >= lo && p <= hi) {
              out[cur] = Math.round(p * 100) / 100;
            }
          } catch {
            /* ignore */
          }
        }),
      );
    } catch {
      /* yahoo optional */
    }
  }

  return out;
}

/**
 * Map numbered annexure rows (1. … 2. …) generically so row N is not skipped
 * when row N+1 exists (HLE: 6=execution, 7=size).
 */
export function parseNumberedAnnexureRows(flat: string): {
  awarding: string | null;
  size: string | null;
  execution: string | null;
} {
  const labelStart =
    "Name|Significant|Whether|Nature|Time|Broad|Value|Date|Particulars";
  const rowRe = new RegExp(
    String.raw`\b(\d{1,2})\.\s+((?:${labelStart})\b[\s\S]*?)(?=\s+\d{1,2}\.\s+(?:${labelStart})\b|$)`,
    "gi",
  );
  let awarding: string | null = null;
  let size: string | null = null;
  let execution: string | null = null;
  for (const m of flat.matchAll(rowRe)) {
    const body = (m[2] || "").replace(/\s+/g, " ").trim();
    if (!body) continue;
    if (
      !awarding &&
      /Name\s+of\s+the\s+entity\s+awarding/i.test(body)
    ) {
      awarding =
        body
          .replace(
            /^Name\s+of\s+the\s+entity\s+awarding\s+the\s+Order\(s\)\s*\/\s*Contract\(s\)\s*/i,
            "",
          )
          .replace(
            /^Name\s+of\s+the\s+entity\s+awarding\s+the\s+order(?:\(s\))?\s*\/\s*contract(?:\(s\))?\s*/i,
            "",
          )
          .trim() || null;
      if (awarding && looksLikeAnnexureNoise(awarding)) awarding = null;
    } else if (!execution && /Time\s+period\s+by\s+which/i.test(body)) {
      execution =
        body
          .replace(
            /^Time\s+period\s+by\s+which\s+the\s+Order\(s\)\s*\/\s*Contract\(s\)\s+is\s+to\s+be\s+executed\s*/i,
            "",
          )
          .replace(
            /^Time\s+period\s+by\s+which\s+the\s+order(?:\(s\))?\s*\/\s*contract(?:\(s\))?\s+is\s+to\s+be\s+executed\s*/i,
            "",
          )
          .trim() || null;
      if (execution && looksLikeAnnexureNoise(execution)) execution = null;
    } else if (!size && /Broad\s+consideration\s+or\s+size/i.test(body)) {
      size =
        body
          .replace(
            /^Broad\s+consideration\s+or\s+size\s+of\s+the\s+Order\(s\)\s*\/\s*Contract\(s\)\s*/i,
            "",
          )
          .replace(
            /^Broad\s+consideration\s+or\s+size\s+of\s+the\s+order(?:\(s\))?\s*\/\s*contract(?:\(s\))?\s*/i,
            "",
          )
          .trim() || null;
      if (size && looksLikeAnnexureNoise(size)) size = null;
    }
  }
  return { awarding, size, execution };
}

function detectFxCurrency(raw: string): FxCurrency | null {
  if (/\b(?:Euro|EUR|€)\b/i.test(raw)) return "EUR";
  if (/\b(?:GBP|£)\b/i.test(raw)) return "GBP";
  if (/\b(?:USD|US\$)\b/i.test(raw) || /(?:^|[\s(])\$(?=\s*\d)/.test(raw)) {
    return "USD";
  }
  return null;
}

/** Lump-sum foreign amount in millions (Euro 20.56 million, USD 244 million). */
export function parseForeignLumpSumMillions(
  raw: string,
): { currency: FxCurrency; millions: number } | null {
  const a = raw.match(
    /\b(?:Approx(?:\.|imate(?:ly)?)?\s+)?(Euro|EUR|€|USD|US\$|\$|GBP|£)\s*([\d,]+(?:\.\d+)?)\s*(?:million|mn|m)\b/i,
  );
  if (a) {
    const currency = detectFxCurrency(a[1]!) || detectFxCurrency(raw);
    const millions = Number(a[2]!.replace(/,/g, ""));
    if (currency && Number.isFinite(millions) && millions > 0) {
      return { currency, millions };
    }
  }
  const b = raw.match(
    /\b([\d,]+(?:\.\d+)?)\s*(?:million|mn)\s*(Euro|EUR|€|USD|US\$|GBP|£)\b/i,
  );
  if (b) {
    const currency = detectFxCurrency(b[2]!) || detectFxCurrency(raw);
    const millions = Number(b[1]!.replace(/,/g, ""));
    if (currency && Number.isFinite(millions) && millions > 0) {
      return { currency, millions };
    }
  }
  return null;
}

function extractFxFromFiling(
  flat: string,
  currency: FxCurrency,
): number | null {
  if (currency === "USD") return extractUsdInrRate(flat);
  const code =
    currency === "EUR" ? "(?:Euro|EUR|€)" : "(?:GBP|£|Pound)";
  const patterns = [
    new RegExp(
      String.raw`(?:1\s*)?${code}\s*=\s*(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d+)?)`,
      "i",
    ),
    new RegExp(
      String.raw`(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d+)?)\s*(?:per|\/)\s*${code}`,
      "i",
    ),
  ];
  for (const re of patterns) {
    const m = flat.match(re);
    if (!m?.[1]) continue;
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 40 && n < 200) return n;
  }
  return null;
}

/**
 * Convert foreign lump-sum (EUR/USD/GBP millions) → ₹ Cr using filing FX or
 * externally applied market rate.
 */
export function convertForeignLumpSumToCr(
  orderSize: string,
  flat: string,
  marketRates?: Partial<Record<FxCurrency, number>>,
): {
  size_cr: number;
  size_cr_label: string;
  size_note: string;
} | null {
  const parsed = parseForeignLumpSumMillions(orderSize);
  if (!parsed) return null;
  const filingFx = extractFxFromFiling(flat, parsed.currency);
  const market =
    marketRates?.[parsed.currency] ?? DEFAULT_FX_INR[parsed.currency];
  const fx = filingFx ?? market;
  const fxSource = filingFx != null ? "filing" : "market";
  // millions × INR/unit ÷ 10 = ₹ Cr
  const cr = Math.round(((parsed.millions * fx) / 10) * 10) / 10;
  const fxNote =
    fxSource === "filing"
      ? `₹${fx}/${parsed.currency} from filing`
      : `~₹${fx}/${parsed.currency}, rate not in filing, applied externally`;
  return {
    size_cr: cr,
    size_cr_label: `~${cr} (using ${fxNote})`,
    size_note: fxNote,
  };
}

/** Re-apply FX (live market) for USD day-rates and foreign lump sums. */
export function applyOrderbookMarketFx(
  extract: OrderbookExtract,
  flat: string,
  marketRates: Partial<Record<FxCurrency, number>>,
): OrderbookExtract {
  if (!extract.orders.length) return extract;
  let changed = false;
  const orders = extract.orders.map((row) => {
    let next = row;
    if (
      /USD|US\$|\$/i.test(row.order_size) &&
      /per\s+(day|month)\b/i.test(row.order_size)
    ) {
      const expanded = expandRateTimesDuration(
        row.order_size,
        row.execution,
        flat,
        { usdInrMarket: marketRates.USD ?? DEFAULT_FX_INR.USD },
      );
      if (expanded) {
        changed = true;
        next = {
          ...next,
          order_size: expanded.order_size,
          size_cr: expanded.size_cr,
          size_cr_label: expanded.size_cr_label,
        };
      }
    }
    if (
      detectFxCurrency(next.order_size) &&
      !/per\s+(day|month)\b/i.test(next.order_size)
    ) {
      const conv = convertForeignLumpSumToCr(next.order_size, flat, marketRates);
      if (conv) {
        changed = true;
        next = {
          ...next,
          size_cr: conv.size_cr,
          size_cr_label: conv.size_cr_label,
        };
      }
    }
    return next;
  });
  if (!changed) return extract;
  const primary = orders[0]!;
  return {
    ...extract,
    orders,
    order_size: primary.order_size,
    order_size_cr: sumOrderSizeCr(orders),
    order_size_note:
      primary.size_cr_label ||
      (primary.order_size === NOT_DISCLOSED ? null : primary.order_size),
  };
}

/** @deprecated use applyOrderbookMarketFx */
export function applyOrderbookUsdMarketFx(
  extract: OrderbookExtract,
  flat: string,
  usdInrMarket: number,
): OrderbookExtract {
  return applyOrderbookMarketFx(extract, flat, { USD: usdInrMarket });
}

export async function downloadOrderbookPdf(
  url: string,
): Promise<Buffer | null> {
  return downloadBuybackPdf(url);
}

export function isOrderbookPdfProxyUrl(url: string): boolean {
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
      h === "afcons.com" ||
      h.endsWith(".afcons.com") ||
      h === "zentechnologies.com" ||
      h.endsWith(".zentechnologies.com") ||
      h.endsWith(".s3.amazonaws.com") ||
      h.endsWith(".cloudfront.net")
    );
  } catch {
    return false;
  }
}

export const AFCONS_ORDER_SAMPLE_URL =
  "https://afcons.com/wp-content/uploads/2026/01/Afcons-Corrgindedum-Revised-Letter-For-DRDO-Order-dated-08.01.2025-1.pdf";

export const RSL_ORDER_SAMPLE_URL =
  "https://www.bseindia.com/xml-data/corpfiling/AttachLive/7b4d0691-83f6-4206-a090-3f8c8ccd8b88.pdf";

export const KPEL_ORDER_SAMPLE_URL =
  "https://www.bseindia.com/xml-data/corpfiling/AttachLive/0b6d398c-4541-4c3a-b5e1-4159c00d1b7b.pdf";

/** Cosmic CRF — BSE-only filing (Scrip Code, no NSE Symbol line). */
export const COSMIC_CRF_ORDER_SAMPLE_URL =
  "https://www.bseindia.com/xml-data/corpfiling/AttachLive/cade7f66-8ddd-4cd8-afc9-3b5ce934bf54.pdf";

/** Deep Industries — ONGC LOA; company only in signature line. */
export const DEEPINDS_ORDER_SAMPLE_URL =
  "https://www.bseindia.com/xml-data/corpfiling/AttachLive/69154b9c-1d62-41b1-9d10-10da2c4e25ee.pdf";

/** Zen Technologies — MoD order (₹120 Cr); company IR host. */
export const ZENTEC_ORDER_SAMPLE_URL =
  "https://www.zentechnologies.com/assets/uploads/files/intimation-of-receipt-of-order-from-ministry-of-defence-government-of-india-valued-at-120-crores.pdf";

/** Sical Logistics — CCL HEMM hire; absolute INR + 5y period. */
export const SICALLOG_ORDER_SAMPLE_URL =
  "https://www.bseindia.com/xml-data/corpfiling/AttachHis/a9a8d00d-a512-4e51-9ae3-56ada09bf179.pdf";

export const NOT_DISCLOSED = "Not disclosed";

/** Pass = required fields filled + Order/Sales ≥ 50% (Zen-style material). */
export const ORDERBOOK_PASS_MIN_PCT = 50;

/** One Annexure / contract block. */
export type OrderWinRow = {
  /** Client / body that gave the order. */
  awarding_entity: string;
  /** Monetary size as stated, or short work nature when ₹ Cr is separate. */
  order_size: string;
  /** Timeline as stated (or Not disclosed). */
  execution: string;
  /** Parsed ₹ Cr for this row when known. */
  size_cr: number | null;
  /** Display for Size as ₹ Cr when range / conversion note. */
  size_cr_label?: string | null;
  /** Vendor receiving the order, when filing is "we awarded to X". */
  contractor: string | null;
};

export type OrderbookExtract = {
  ticker: string | null;
  company: string | null;
  subject: string | null;
  /** Announcement / LOA / order date (YYYY-MM-DD when parsed). */
  order_date: string | null;
  /** All contracts found (multi-annexure). */
  orders: OrderWinRow[];
  /** Convenience = orders[0] or Not disclosed. */
  awarding_entity: string;
  order_size: string;
  execution: string;
  /** Parsed ₹ Cr when monetary (Lacs→Cr, Crores). */
  order_size_cr: number | null;
  order_size_note: string | null;
  execution_period: string | null;
  nature: string | null;
  domestic_or_international: string | null;
  related_party: string | null;
  promoter_interest: string | null;
  order_book_cr: number | null;
  as_of: string | null;
  sales_cr: number | null;
  sales_year: string | null;
  order_to_sales_pct: number | null;
  /** Latest traded price (refreshed). */
  ltp: number | null;
  /** Close before announcement day. */
  baseline_close: number | null;
  /** (LTP − baseline) / baseline % since announcement. */
  drift_pct: number | null;
  confidence: number;
};

export type OrderbookScreenResult = {
  ok: boolean;
  /** Pass = save to list (Strong vs sales). */
  decision: "pass" | "fail";
  extract: OrderbookExtract;
  engine: string;
  text_chars: number;
  text_excerpt: string;
  source_url: string | null;
  error?: string;
  id?: number;
  screened_at?: string;
  pending_fields: boolean;
  why: string;
  /** Core 3-field JSON rows for validation / UI. */
  core: Array<{
    "Awarding entity": string;
    "Order size": string;
    Execution: string;
  }>;
  /** Claude-style extract JSON (+ Size ₹ Cr / sales when available). */
  extract_json?: Record<string, string | number | null>;
};

function emptyExtract(): OrderbookExtract {
  return {
    ticker: null,
    company: null,
    subject: null,
    order_date: null,
    orders: [],
    awarding_entity: NOT_DISCLOSED,
    order_size: NOT_DISCLOSED,
    execution: NOT_DISCLOSED,
    order_size_cr: null,
    order_size_note: null,
    execution_period: null,
    nature: null,
    domestic_or_international: null,
    related_party: null,
    promoter_interest: null,
    order_book_cr: null,
    as_of: null,
    sales_cr: null,
    sales_year: null,
    order_to_sales_pct: null,
    ltp: null,
    baseline_close: null,
    drift_pct: null,
    confidence: 0,
  };
}

function ensureDb() {
  const db = openSqliteNamed("orderbook_screen.db", { wal: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS orderbook_screens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url TEXT,
      ticker TEXT,
      company TEXT,
      extract_json TEXT NOT NULL,
      engine TEXT,
      text_chars INTEGER,
      screened_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orderbook_screened
      ON orderbook_screens(screened_at DESC);
  `);
  return db;
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
  const pages = await rasterizePdfPages(buf, { maxPages: 8, dpi: 144 });
  const chunks: string[] = [];
  for (const page of pages) {
    const t = await ocrImageWithQianfan(
      page.dataUrl,
      "Transcribe this Indian exchange order/contract filing. Preserve Annexure rows: awarding entity, to which order awarded, broad consideration/size, time period/execution. Plain text only.",
    );
    if (t.trim()) chunks.push(`--- page ${page.page} ---\n${t.trim()}`);
  }
  return chunks.join("\n\n").trim();
}

function cleanCell(s: string | null | undefined): string {
  if (!s) return NOT_DISCLOSED;
  let t = s
    .replace(/\s+/g, " ")
    .replace(/^[;:.\-\s]+/, "")
    .replace(/[;:.\-\s]+$/, "")
    .trim();
  // OCR: * GST → + GST ; l1 Months → 11 Months
  t = t.replace(/\*\s*(GST)/gi, "+ $1");
  t = t.replace(/\bl1\s*(Months?)/gi, "11 $1");
  t = t.replace(/\bl\s*(\d)\s*(Months?)/gi, "1$1 $2");
  // Strip trailing annexure row numbers (e.g. "… WTG 8")
  t = t.replace(/\s+\d{1,2}$/g, "").trim();
  // Strip pipes / OCR junk around annexure cells
  t = t.replace(/^[|·~\s]+/, "").replace(/[|]+$/g, "").trim();
  if (!t) return NOT_DISCLOSED;
  return t;
}

/** Short work nature for Order size when ₹ Cr is stored separately. */
function compactWorkNature(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  t = t.replace(/\s+for a period of .+$/i, "");
  t = t.replace(/\([^)]*\d[^)]*\)/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  // Prefer Claude-style short label for common mining hire
  if (/HEMM/i.test(t) && /OB\s*removal/i.test(t)) {
    const loc =
      t.match(/SDOC Mine of Dhori Area/i)?.[0] ||
      t.match(/Dhori Area/i)?.[0] ||
      null;
    return `HEMM hire for OB removal + coal extraction${loc ? `, ${loc}` : ""}`;
  }
  t = t.replace(/^Hiring of\s+/i, "");
  if (t.length > 110) t = `${t.slice(0, 107).trim()}…`;
  return t;
}

function extractWorkNature(flat: string, stop: RegExp): string | null {
  const quoted = flat.match(
    /(?:execution of the work of|for the work of|work of)\s*[“"']([^”"']{15,400})[”"']/i,
  );
  if (quoted?.[1]) return compactWorkNature(quoted[1]);

  const nature = fieldAfter(
    flat,
    new RegExp(String.raw`Nature\s+of\s+(?:the\s+)?${ORDER_CONTRACT}`, "i"),
    stop,
  );
  if (nature && !looksMonetary(nature) && nature.length > 12) {
    // Drop tender notice tails
    const brief = nature
      .split(/\bas per the e-tender|bearing NIT\b/i)[0]
      ?.replace(/\s+/g, " ")
      .trim();
    if (brief && brief.length > 12) return compactWorkNature(brief);
  }
  return null;
}

function normalizeExecution(
  raw: string,
  orderDateIso?: string | null,
): string {
  let t = raw.replace(/\s+/g, " ").trim();
  t = t.replace(/^Contract period\s*:\s*/i, "");
  t = t.replace(/^Services\s+are\s+to\s+be\s+provided\s+/i, "");
  t = t.replace(/^valid\s+/i, "");
  // "Five (5) Years (1825 Days)" → "5 Years (1,825 days)"
  const m = t.match(
    /(?:Five|5)\s*(?:\(\s*5\s*\))?\s*Years?\s*(?:\(\s*([\d,]+)\s*Days?\s*\))?/i,
  );
  if (m) {
    const days = m[1] ? Number(m[1].replace(/,/g, "")) : null;
    if (days != null && Number.isFinite(days)) {
      return `5 Years (${days.toLocaleString("en-IN")} days)`;
    }
    return "5 Years";
  }
  const upTo = t.match(
    /\b((?:up\s+to|until|till|through|on\s+or\s+before|no\s+later\s+than|before|by)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4})\b/i,
  );
  if (upTo) {
    let phrase = upTo[1]!.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
    if (/^up\s+to\b/i.test(phrase)) {
      const monYear = phrase.replace(/^up\s+to\s+/i, "");
      let out = `Up to ${monYear}`;
      const horizon = executionHorizonNote(monYear, orderDateIso);
      if (horizon) out = `${out} (${horizon})`;
      return out;
    }
    if (/^on\s+or\s+before\b/i.test(phrase)) {
      return phrase.replace(/^on\s+or\s+before/i, "On or before");
    }
    if (/^no\s+later\s+than\b/i.test(phrase)) {
      return phrase.replace(/^no\s+later\s+than/i, "No later than");
    }
    return phrase.charAt(0).toUpperCase() + phrase.slice(1);
  }
  // "initial period of 120 days … extended by/for 56 days"
  const extendable = t.match(
    /initial\s+(?:period\s+of\s+)?(\d+)\s+days?[^\d]{0,80}?(?:may\s+be\s+)?extend(?:ed|able)[^\d]{0,60}?(\d+)\s+days?/i,
  );
  if (extendable) {
    const a = Number(extendable[1]);
    const b = Number(extendable[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return `Initial ${a} days, extendable by a further ${b} days (up to ${a + b} days total)`;
    }
  }
  return t;
}

/** "~34 months from Aug 2026" when execution ends on a calendar month. */
function executionHorizonNote(
  endMonthYear: string,
  orderDateIso?: string | null,
): string | null {
  if (!orderDateIso || !/^\d{4}-\d{2}-\d{2}$/.test(orderDateIso)) return null;
  const em = endMonthYear.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/i,
  );
  if (!em) return null;
  const mm = MONTHS[em[1]!.toLowerCase().replace(/\.$/, "")];
  const y = Number(em[2]);
  if (!mm || !Number.isFinite(y)) return null;
  const end = new Date(Date.UTC(y, Number(mm) - 1, 1));
  const start = new Date(`${orderDateIso}T00:00:00Z`);
  if (Number.isNaN(end.getTime()) || Number.isNaN(start.getTime())) return null;
  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth());
  if (months <= 0 || months > 120) return null;
  const short = [
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
  const from = `${short[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
  return `~${months} months from ${from}`;
}

const MONTHS: Record<string, string> = {
  january: "01",
  jan: "01",
  february: "02",
  feb: "02",
  march: "03",
  mar: "03",
  april: "04",
  apr: "04",
  may: "05",
  june: "06",
  jun: "06",
  july: "07",
  jul: "07",
  august: "08",
  aug: "08",
  september: "09",
  sep: "09",
  sept: "09",
  october: "10",
  oct: "10",
  november: "11",
  nov: "11",
  december: "12",
  dec: "12",
};

/** Normalize common Indian filing dates → YYYY-MM-DD. */
export function normalizeOrderDate(raw: string): string | null {
  const s = raw.replace(/\s+/g, " ").trim();
  const named = s.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})\b/i,
  );
  if (named) {
    const mm = MONTHS[named[1]!.toLowerCase().replace(/\.$/, "")];
    const dd = named[2]!.padStart(2, "0");
    return mm ? `${named[3]}-${mm}-${dd}` : null;
  }
  // "01 September 2026" / "1st Sep 2026"
  const dmyNamed = s.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?,?\s+(\d{4})\b/i,
  );
  if (dmyNamed) {
    const mm = MONTHS[dmyNamed[2]!.toLowerCase().replace(/\.$/, "")];
    const dd = dmyNamed[1]!.padStart(2, "0");
    return mm ? `${dmyNamed[3]}-${mm}-${dd}` : null;
  }
  const dmy = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
  if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    const y = dmy[3]!;
    // Prefer DD/MM/YYYY when day > 12 or ambiguous Indian style
    if (a > 12) return `${y}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`;
    if (b > 12) return `${y}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`;
    return `${y}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`;
  }
  return null;
}

const NAMED_DATE_RE =
  /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?,?\s+\d{4})\b/i;

function letterheadSlice(flat: string): string {
  const markers = [
    /\bSubject\s*:/i,
    /\bDear\s+Sir/i,
    /\bPursuant\s+to\s+Regulation/i,
    /\bThe details as required/i,
  ];
  let end = Math.min(flat.length, 1400);
  for (const re of markers) {
    const m = flat.match(re);
    if (m?.index != null && m.index > 60) end = Math.min(end, m.index);
  }
  return flat.slice(0, end);
}

function isCircularDatedContext(before: string): boolean {
  return /circular|master\s+circular|\bSEBI\b|regulation\s+no\.?|HO\/\d|CFD-POD/i.test(
    before,
  );
}

function extractOrderDate(flat: string): string | null {
  // 1) Letterhead / filing date above Subject / Dear Sir (HFCL: September 01, 2026)
  const head = letterheadSlice(flat);
  const headDate = head.match(NAMED_DATE_RE);
  if (headDate?.[1]) {
    const iso = normalizeOrderDate(headDate[1]);
    if (iso) return iso;
  }
  const headNum = head.match(/\bDate\s*:\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i);
  if (headNum?.[1]) {
    const iso = normalizeOrderDate(headNum[1]);
    if (iso) return iso;
  }

  // 2) LOA / PO / contract dated …
  const awardDated = flat.match(
    /(?:Letter of Acceptance|Letter of Award|Purchase Order|LOA|LOI|Work Order|Purchase\s+Order)\s+dated\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i,
  );
  if (awardDated?.[1]) {
    const iso = normalizeOrderDate(awardDated[1]);
    if (iso) return iso;
  }

  // 3) Generic "dated …" — skip SEBI / Master Circular references (HFCL false Jan 30)
  for (const m of flat.matchAll(
    /\bdated\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/gi,
  )) {
    if (!m[1] || m.index == null) continue;
    const before = flat.slice(Math.max(0, m.index - 100), m.index);
    if (isCircularDatedContext(before)) continue;
    const iso = normalizeOrderDate(m[1]);
    if (iso) return iso;
  }

  const dateColon = flat.match(/\bDate\s*:\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i);
  if (dateColon?.[1]) {
    const iso = normalizeOrderDate(dateColon[1]);
    if (iso) return iso;
  }

  // 4) First named date in letterhead-length window only (avoid annexure circular dates)
  return null;
}

/** Display: "Announcement - 01 Sep 2026". */
export function formatAnnouncementDate(isoOrRaw: string | null | undefined): string {
  if (!isoOrRaw) return "—";
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(isoOrRaw)
    ? isoOrRaw
    : normalizeOrderDate(isoOrRaw);
  if (!iso) return isoOrRaw;
  const [y, m, d] = iso.split("-");
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
  const mi = Number(m) - 1;
  if (!y || mi < 0 || mi > 11 || !d) return isoOrRaw;
  return `Announcement - ${d} ${months[mi]} ${y}`;
}

/** True when extract is list-worthy (Zen-style material order). */
export function isOrderbookPass(extract: OrderbookExtract): boolean {
  const awarding = extract.awarding_entity || NOT_DISCLOSED;
  const size = extract.order_size || NOT_DISCLOSED;
  const exec = extract.execution || NOT_DISCLOSED;
  if (awarding === NOT_DISCLOSED) return false;
  if (awarding.length > 120) return false;
  if (size === NOT_DISCLOSED) return false;
  if (exec === NOT_DISCLOSED) return false;
  if (extract.order_size_cr == null || extract.order_size_cr <= 0) return false;
  if (extract.order_to_sales_pct == null) return false;
  return extract.order_to_sales_pct >= ORDERBOOK_PASS_MIN_PCT;
}

/** Convert stated size to ₹ Cr when possible; else null (MW-only etc.). */
export function parseOrderSizeToCr(raw: string): number | null {
  if (!raw || raw === NOT_DISCLOSED) return null;
  // Strip grouping commas so "1,621 Lacs" → 1621; "534,73,08,872.24" → rupees
  const t = raw.replace(/,/g, "");
  // Prefer Crores / Cr
  const cr = t.match(
    /(?:INR|Rs\.?|₹)?\s*([\d]+(?:\.\d+)?)\s*(?:Crores?|Cr\.?)\b/i,
  );
  if (cr) {
    const n = Number(cr[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  // Lacs / Lakhs → Cr (/100)
  const lac = t.match(
    /(?:INR|Rs\.?|₹)?\s*([\d]+(?:\.\d+)?)\s*(?:Lacs?|Lakhs?)\b/i,
  );
  if (lac) {
    const n = Number(lac[1]);
    return Number.isFinite(n) && n > 0
      ? Math.round((n / 100) * 100) / 100
      : null;
  }
  // Absolute INR: Rs. 5347308872.24/- → ÷ 1e7
  const abs = t.match(
    /(?:INR|Rs\.?|₹)\s*([\d]+(?:\.\d+)?)\s*(?:\/\s*-)?/i,
  );
  if (abs && !/(?:Million|Mn|Billion|Bn)\b/i.test(raw)) {
    const n = Number(abs[1]);
    if (Number.isFinite(n) && n >= 100_000) {
      return Math.round((n / 1e7) * 100) / 100;
    }
  }
  // ₹ / Rs Million → Cr (/10); Billion → Cr (*10)
  const mil = t.match(
    /(?:INR|Rs\.?|₹)\s*([\d]+(?:\.\d+)?)\s*(?:Million|Mn)\b/i,
  );
  if (mil) {
    const n = Number(mil[1]);
    if (Number.isFinite(n) && n > 0) {
      return Math.round((n / 10) * 100) / 100;
    }
  }
  const bil = t.match(
    /(?:INR|Rs\.?|₹)\s*([\d]+(?:\.\d+)?)\s*(?:Billion|Bn)\b/i,
  );
  if (bil) {
    const n = Number(bil[1]);
    if (Number.isFinite(n) && n > 0) {
      return Math.round(n * 10 * 100) / 100;
    }
  }
  // USD Xm (approximately ₹ Y Million) — prefer INR approx when present
  const usdInr = raw.match(
    /(?:USD|US\$|\$)\s*([\d.]+)\s*M\b[^(]*\(approximately\s*₹\s*([\d,]+(?:\.\d+)?)\s*Million\)/i,
  );
  if (usdInr) {
    const n = Number(usdInr[2]!.replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) {
      return Math.round((n / 10) * 100) / 100;
    }
  }
  // Word form: "Five Hundred Thirty- Four Crore Seventy-Three Lakh"
  const words = raw.match(
    /([\w\-]+(?:\s+[\w\-]+){0,12})\s+Crores?\b/i,
  );
  if (words && /hundred|thousand|crore|lakh|million/i.test(words[1] || "")) {
    const approx = raw.match(
      /(?:INR|Rs\.?|₹)\s*[\d,]+(?:\.\d+)?/i,
    );
    if (approx) {
      const n = Number(approx[0].replace(/[^\d.]/g, ""));
      if (Number.isFinite(n) && n >= 100_000) {
        return Math.round((n / 1e7) * 100) / 100;
      }
    }
  }
  return null;
}

/** Sum monetary sizes across multi-annexure rows. */
export function sumOrderSizeCr(orders: OrderWinRow[]): number | null {
  let total = 0;
  let any = false;
  for (const o of orders) {
    const n = o.size_cr ?? parseOrderSizeToCr(o.order_size);
    if (n != null) {
      total += n;
      any = true;
    }
  }
  return any ? Math.round(total * 100) / 100 : null;
}

/** True if text looks like a monetary order size (not MW-only). */
function looksMonetary(raw: string): boolean {
  return (
    /(?:INR|Rs\.?|₹|USD|US\$|EUR|€|Euro|GBP|£)/i.test(raw) ||
    /(?:Crores?|Cr\.?|Lacs?|Lakhs?|million|mn)\b/i.test(raw) ||
    /\bper\s+day\b/i.test(raw)
  );
}

function looksFixedExecution(raw: string): boolean {
  if (/mutually\s+agreed|definitive\s+agreement|to\s+be\s+agreed/i.test(raw)) {
    return false;
  }
  // "36 Months", "Within 1 month", "Three (03) Years"
  if (/\d/.test(raw) && /(?:Months?|Days?|Years?|Weeks?)/i.test(raw)) {
    return true;
  }
  // "within a year" / "within one year" (no digit)
  if (/\b(?:within\s+)?(?:a|one|two|three)\s+years?\b/i.test(raw)) {
    return true;
  }
  // "up to June 2029" / "On or before April, 2030" / "by March 2028"
  return /\b(?:up\s+to|until|till|through|on\s+or\s+before|no\s+later\s+than|before|by)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b/i.test(
    raw,
  );
}

/** Labels: order(s)/contract(s) or Order/Contract (E2E style). */
const ORDER_CONTRACT = String.raw`order(?:\(s\))?\s*/\s*contract(?:\(s\))?`;

/** Next annexure row / section — stop field capture. */
const ANNEXURE_FIELD_STOP =
  /(?:\d+\)\s*(?:Significant|Whether|Nature|Time|Broad|Name|Value|Date)|(?:\d+\.\s*)(?:Significant|Whether|Nature|Time|Broad|name|Name|Value|Date)|(?:\d+)\s+(?:Significant|Whether|Nature|Time|Broad|Name|Value|Date)|Significant\s+terms|Whether\s+(?:the\s+)?order|Whether\s+contract\s+caters|Nature\s+of\s+(?:order|Work)|Whether\s+domestic|Time\s+period|Broad\s+consideration|Value\s+of\s+order|Date\s+of\s+(?:Contract|Signed)|Whether\s+the\s+promoter|Whether\s+the\s+order|Sr\.\s*No|Sl\.\s*No|Particulars|Details|Remarks|Information|$)/i;

/** Prefer short money phrase from verbose Reg-30 sentences. */
function compactOrderSize(raw: string): string {
  // Keep short annexure cells (incl. + GST / per WTG); only compress prose.
  if (
    raw.length < 70 &&
    !/estimated value|said award|aggregating|bagged|aggregate value/i.test(raw)
  ) {
    return raw;
  }
  const m = raw.match(
    /(?:INR|Rs\.?|₹)\s*[\d,]+(?:\.\d+)?\s*(?:Lacs?|Lakhs?|Crores?|Cr\.?)(?:\s*\(including\s+GST\)|\s*\+\s*GST)?/i,
  );
  if (!m) return raw;
  const approx = /approximately|approx\.?/i.test(raw) ? "approx. " : "";
  return `${approx}${m[0]}`.replace(/\s+/g, " ").trim();
}

function isExchangeOrCounterpartyName(name: string): boolean {
  return /^(?:BSE|NSE|National\s+Stock|Oil\s+and\s+Natural|Defence\s+Research)/i.test(
    name.trim(),
  );
}

function splitAnnexureBlocks(text: string): string[] {
  // OCR often mangles ANNEXURE → ANNEXURB / ANNEXT]RE
  const parts = text.split(
    /\bANNEX[\w\]\[.]{0,12}\s*[-–.]?\s*(?:I{1,3}|IV|V|[12A])\b/i,
  );
  if (parts.length > 1) {
    const bodies = parts
      .slice(1)
      .map((p) => p.trim())
      .filter((p) => p.length > 60);
    if (bodies.length >= 1) return bodies;
  }
  // Fallback: each "entity to which order is awarded" starts a block
  const alt = text.split(
    /(?=Name\s+of\s+the\s+entity\s+to\s+which\s+order)/i,
  );
  if (alt.length > 1) {
    return alt.map((p) => p.trim()).filter((p) => /order/i.test(p) && p.length > 60);
  }
  return [text];
}

function fieldAfter(
  flat: string,
  label: RegExp,
  stop: RegExp,
): string | null {
  const m = flat.match(
    new RegExp(
      `${label.source}\\s*[:.;]?\\s*(.+?)(?=${stop.source}|$)`,
      "i",
    ),
  );
  const v = m?.[1]?.replace(/\s+/g, " ").trim() || null;
  if (!v || looksLikeAnnexureNoise(v)) return null;
  return v;
}

/** Scrambled Reg-30 tables often dump the next label into the value cell. */
function looksLikeAnnexureNoise(s: string): boolean {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length < 2) return true;
  if (t.length > 160) return true; // awarding entities are short names
  return /^(?:significant\s+terms|whether\s+(?:order|domestic|the)|nature\s+of\s+order|time\s+period|broad\s+consideration|name\s+of\s+the\s+entity|order\(s\)\s*\/\s*contract\(s\)|particulars|details|sr\.?\s*no|awarded\s+in\s+brief)\b/i.test(
    t,
  ) || /significant\s+terms\s+and\s+conditions/i.test(t);
}

/**
 * When annexure columns are jumbled (TIMETECHNO), recover from narrative /
 * subject / values sitting before their labels.
 */
function extractNarrativeAwarding(flat: string): string | null {
  const charter = flat.match(
    /Charter\s+Party\s+Agreement\s+with\s+(M\/?s\.?\s+[A-Za-z][A-Za-z0-9 .&'-]{2,70}(?:,\s*[A-Z]{2,3})?),?\s+(?:on|for\s+deployment)/i,
  )?.[1];
  if (charter) {
    return charter.replace(/\s+/g, " ").replace(/,\s*$/, "").trim();
  }
  const termSheet = flat.match(
    /(?:binding\s+term\s+sheet|entered\s+into\s+(?:the\s+)?(?:a\s+)?(?:binding\s+)?(?:term\s+sheet|agreement))\s+with\s+(?:a\s+)?(.+?)(?:,?\s+requiring|,?\s+for\s+the\s+provision|\s+for\s+the\s+provision|\.|$)/i,
  )?.[1];
  if (termSheet && !looksLikeAnnexureNoise(termSheet) && termSheet.length > 8) {
    return termSheet.replace(/\s+/g, " ").trim();
  }
  const fromOrder = flat.match(
    /(?:has\s+)?(?:received|secured|bagged|won)\s+(?:an?\s+)?[Oo]rder\s+from\s+(.+?)(?:,?\s+for\s+the\s+supply|\s+valued\s+at|\s+for\s+supply|\.|$)/i,
  )?.[1];
  if (fromOrder && !looksLikeAnnexureNoise(fromOrder) && fromOrder.length > 8) {
    let t = fromOrder.replace(/\s+/g, " ").trim();
    // "a well-established PSU, a JV of TWO MAHARATNA PSUs"
    t = t.replace(/\bTWO\b/g, "two").replace(/\bMAHARATNA\b/g, "Maharatna");
    t = t.replace(/^a\s+/i, "A ");
    t = t.replace(/,\s*a\s+JV\s+of\s+/i, " — a JV of ");
    if (
      /well[- ]established|public\s+sector|PSU|global\s+multinational|name\s+not\s+disclosed/i.test(
        t,
      ) &&
      !/\([A-Z][A-Za-z&.\s]{2,40}\)\s*$/.test(t) &&
      !/\b(?:Ltd|Limited|Corporation|Inc)\b/i.test(t)
    ) {
      if (!/name\s+not\s+disclosed/i.test(t)) {
        t = `${t.replace(/[.\s]+$/, "")} (name not disclosed)`;
      }
    }
    return t;
  }
  const shortPsu = flat.match(
    /\b(A\s+[Ww]ell[- ]established\s+PSU)\b/,
  )?.[1];
  if (shortPsu) {
    const jv = flat.match(
      /JV\s+of\s+(?:two|TWO)\s+(?:Maharatna|MAHARATNA)\s+PSUs/i,
    )?.[0];
    if (jv) {
      return `A well-established Public Sector Undertaking (PSU) — a ${jv.replace(/\bTWO\b/g, "two").replace(/\bMAHARATNA\b/g, "Maharatna")} (name not disclosed)`;
    }
    return `${shortPsu} (name not disclosed)`;
  }
  return null;
}

function extractNarrativeSize(flat: string): string | null {
  const euro = flat.match(
    /\b((?:Approx(?:\.|imate(?:ly)?)?\s+)?(?:Euro|EUR|€|USD|US\$|GBP|£)\s*[\d,]+(?:\.\d+)?\s*(?:million|mn|m))\b/i,
  )?.[1];
  if (euro) return euro.replace(/\s+/g, " ").trim();
  // Prefer "valued at approximately Rs. …" over subject "secures order of Rs. …"
  const valued = flat.match(
    /valued\s+at\s+(approximately\s+)?((?:Rs\.?|INR|₹)\s*[\d,]+(?:\.\d+)?\s*(?:Crores?|Cr\.?))/i,
  );
  const aggregate = flat.match(
    /aggregate\s+contract\s+value\s+of\s+(approximately\s+)?((?:Rs\.?|INR|₹)\s*[\d,]+(?:\.\d+)?\s*(?:Crores?|Cr\.?))(?:\s*(\([^)]{0,80}\)))?/i,
  );
  const secured = flat.match(
    /(?:secures?\s+order\s+of|aggregating|order\s+of)\s+(approximately\s+)?((?:Rs\.?|INR|₹)\s*[\d,]+(?:\.\d+)?\s*(?:Crores?|Cr\.?))/i,
  );
  const hit = aggregate || valued || secured;
  if (hit) {
    const base = hit[2]!.replace(/\s+/g, " ").trim();
    const taxNote =
      hit[3]?.replace(/\s+/g, " ").trim() ||
      flat
        .slice(hit.index ?? 0, (hit.index ?? 0) + hit[0].length + 60)
        .match(/\((exclusive\s+of\s+applicable\s+taxes)\)/i)?.[0];
    const wantApprox =
      !!hit[1] ||
      /approx/i.test(base) ||
      (valued == null &&
        aggregate == null &&
        /approximately\s+(?:Rs\.?|INR|₹)/i.test(flat));
    let out = base;
    if (wantApprox && !/approx/i.test(base)) {
      out = `Approximately ${base}`;
    } else if (hit[1] && !/^approx/i.test(out)) {
      out = `Approximately ${base}`;
    }
    if (taxNote && !/exclusive|inclusive|GST|tax/i.test(out)) {
      out = `${out} ${taxNote}`;
    }
    return out.replace(/\s+/g, " ").trim();
  }
  // Value printed before "broad consideration" label (scrambled table)
  const beforeLabel = flat.match(
    /((?:Rs\.?|INR|₹)\s*[\d,]+(?:\.\d+)?\s*Crores?\s*(?:\(Approx\.?\))?)\s*(?:No\b|Not\s+a\s+related|whether\s+the\s+promoter|You\s+are\s+requested)/i,
  )?.[1];
  if (beforeLabel) return beforeLabel.replace(/\s+/g, " ").trim();
  const anyCr = flat.match(
    /\b((?:Approximately\s+)?(?:Rs\.?|INR|₹)\s*[\d,]+(?:\.\d+)?\s*Crores?\s*(?:\([^)]{0,60}\))?)\b/i,
  )?.[1];
  return anyCr ? anyCr.replace(/\s+/g, " ").trim() : null;
}

function extractNarrativeExecution(flat: string): string | null {
  const beforeLabel = flat.match(
    /\b((?:Within\s+)?(?:\d+|One|Two|Three|a)\s+(?:Years?|Months?|Days?|Weeks?))\s+(?:whether\s+domestic|time\s+period\s+by\s+which)/i,
  )?.[1];
  if (beforeLabel) return beforeLabel.replace(/\s+/g, " ").trim();
  const extendable = flat.match(
    /(?:for\s+an\s+)?initial\s+period\s+of\s+(\d+)\s+days[^\d]{0,100}?(?:may\s+be\s+)?extend(?:ed|able)[^\d]{0,80}?(\d+)\s+days/i,
  );
  if (extendable) {
    return `initial period of ${extendable[1]} days which may be extended by a further period of ${extendable[2]} days`;
  }
  const upTo = flat.match(
    /\b((?:(?:Services\s+are\s+to\s+be\s+provided|valid)\s+)?(?:up\s+to|until|till|through)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})\b/i,
  )?.[1];
  if (upTo) return upTo.replace(/\s+/g, " ").trim();
  const within = flat.match(
    /\b(Within\s+\d+\s+(?:Years?|Months?|Days?|Weeks?))\b/i,
  )?.[1];
  return within ? within.replace(/\s+/g, " ").trim() : null;
}

/** Day-hire / unit rate — raw amount string for × duration expansion. */
function extractDayRateSize(flat: string): string | null {
  const rate = flat.match(
    /\b((?:USD|US\$|\$|INR|Rs\.?)\s*[\d,]+(?:\.\d+)?)\s*(?:plus\s+(?:applicable\s+)?GST|per\s+day\s+plus\s+(?:applicable\s+)?GST|\+\s*GST)?\s*per\s+day/i,
  ) || flat.match(
    /\b((?:USD|US\$|\$)\s*[\d,]+(?:\.\d+)?)\s*per\s+day\s*(?:plus|\+)\s*(?:applicable\s+)?GST/i,
  ) || flat.match(
    /Value\s+of\s+order(?:\(s\))?\s*\/\s*contract(?:\(s\))?\s*((?:USD|US\$|\$|INR|Rs\.?)\s*[\d,]+(?:\.\d+)?)\s*(?:per\s+day)?\s*(?:plus|\+)?\s*(?:GST)?/i,
  ) || flat.match(
    /\b((?:USD|US\$|\$|INR|Rs\.?)\s*[\d,]+(?:\.\d+)?)\s*(?:\+\s*GST|plus\s+(?:applicable\s+)?GST)?\s*per\s+(month|unit|WTG)\b/i,
  );
  if (!rate) return null;
  let amount = (rate[1] || rate[0] || "").replace(/\s+/g, " ").trim();
  amount = amount
    .replace(/^\$/, "USD ")
    .replace(/^US\$/i, "USD ")
    .replace(/\s+/g, " ")
    .trim();
  amount = amount.replace(/(\d),\s+(\d{3})\b/g, "$1,$2");
  amount = amount.replace(
    /(USD|INR|Rs\.?)\s*([\d]+)\s+([\d]{3})\b/i,
    "$1 $2,$3",
  );
  amount = amount.replace(/,\s*$/, "");
  if (/^(?:USD|INR|Rs\.?)\s*\d{1,3}$/i.test(amount)) {
    const retry = flat.match(
      /\b(USD|US\$|\$|INR|Rs\.?)\s*([\d]+)\s*,\s*([\d]{3})(?:\.\d+)?/i,
    );
    if (retry) {
      const cur = /^\$|US\$/i.test(retry[1]!) ? "USD" : retry[1]!.toUpperCase();
      amount = `${cur === "$" ? "USD" : cur} ${retry[2]},${retry[3]}`;
    }
  }
  const gst =
    /GST/i.test(rate[0]) ||
    /GST/i.test(flat.slice(rate.index ?? 0, (rate.index ?? 0) + 90));
  const per =
    rate[0].match(/\bper\s+(day|month|unit|WTG)\b/i)?.[1]?.toLowerCase() ||
    "day";
  return `${amount} per ${per}${gst ? " + GST" : ""}`;
}

/** INR per 1 USD from filing text when present. */
function extractUsdInrRate(flat: string): number | null {
  const patterns = [
    /(?:1\s*)?USD\s*=\s*(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d+)?)/i,
    /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d+)?)\s*(?:per|\/)\s*USD\b/i,
    /exchange\s+rate[^\d]{0,40}(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d+)?)/i,
    /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d+)?)\s*=\s*(?:1\s*)?USD\b/i,
  ];
  for (const re of patterns) {
    const m = flat.match(re);
    if (!m?.[1]) continue;
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 20 && n < 200) return n;
  }
  return null;
}

function parseRatePerUnit(orderSize: string): {
  currency: "USD" | "INR";
  amount: number;
  unit: "day" | "month" | "unit" | "wtg";
  gst: boolean;
} | null {
  if (!/per\s+(day|month|unit|wtg)\b/i.test(orderSize)) return null;
  const m = orderSize.match(
    /\b(USD|US\$|\$|INR|Rs\.?|₹)\s*([\d,]+(?:\.\d+)?)\s*per\s+(day|month|unit|WTG)\b/i,
  );
  if (!m) return null;
  const amount = Number(m[2]!.replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const curRaw = m[1]!.toUpperCase();
  const currency: "USD" | "INR" =
    curRaw === "USD" || curRaw === "US$" || curRaw === "$" ? "USD" : "INR";
  const unit = m[3]!.toLowerCase() as "day" | "month" | "unit" | "wtg";
  return {
    currency,
    amount,
    unit,
    gst: /\+\s*GST|plus\s+(?:applicable\s+)?GST/i.test(orderSize),
  };
}

/** Min/max duration in the rate's unit (days or months). */
function parseDurationRange(
  execution: string,
  flat: string,
  unit: "day" | "month" | "unit" | "wtg",
): { min: number; max: number } | null {
  if (unit === "unit" || unit === "wtg") return null;
  const blob = `${execution} ${flat}`;
  if (unit === "day") {
    const extendable = blob.match(
      /initial\s+(?:period\s+of\s+)?(\d+)\s+days?[^\d]{0,100}?(?:may\s+be\s+)?extend(?:ed|able)[^\d]{0,80}?(\d+)\s+days?/i,
    );
    if (extendable) {
      const a = Number(extendable[1]);
      const b = Number(extendable[2]);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        return { min: a, max: a + b };
      }
    }
    const upTo = execution.match(
      /up\s+to\s+(\d+)\s+days\s+total|Initial\s+(\d+)\s+days,\s+extendable\s+by\s+a\s+further\s+(\d+)\s+days\s+\(up\s+to\s+(\d+)/i,
    );
    if (upTo?.[4]) {
      const max = Number(upTo[4]);
      const min = Number(upTo[2] || upTo[1]);
      if (Number.isFinite(min) && Number.isFinite(max)) return { min, max };
    }
    const single = execution.match(/\b(\d+)\s+days?\b/i);
    if (single) {
      const n = Number(single[1]);
      if (Number.isFinite(n) && n > 0) return { min: n, max: n };
    }
  }
  if (unit === "month") {
    const months = execution.match(/\b(\d+)\s+months?\b/i);
    if (months) {
      const n = Number(months[1]);
      if (Number.isFinite(n) && n > 0) return { min: n, max: n };
    }
    if (/\b(?:within\s+)?(?:a|one)\s+years?\b/i.test(execution)) {
      return { min: 12, max: 12 };
    }
  }
  return null;
}

function fmtMoneyAmount(n: number, currency: "USD" | "INR"): string {
  const formatted = n.toLocaleString(currency === "USD" ? "en-US" : "en-IN", {
    maximumFractionDigits: 0,
  });
  return currency === "USD" ? `USD ${formatted}` : `Rs. ${formatted}`;
}

/**
 * rate × duration → totals (min/max). INR → ₹ Cr; USD → ₹ Cr via filing FX
 * or externally applied market rate (never leave Size as "Not disclosed" when
 * a USD total was computed).
 */
export function expandRateTimesDuration(
  orderSize: string,
  execution: string,
  flat: string,
  opts?: { usdInrMarket?: number | null },
): {
  order_size: string;
  size_cr: number | null;
  size_note: string | null;
  size_cr_label: string | null;
} | null {
  const rate = parseRatePerUnit(orderSize);
  if (!rate) return null;
  const dur = parseDurationRange(execution, flat, rate.unit);
  if (!dur) return null;

  const minTotal = rate.amount * dur.min;
  const maxTotal = rate.amount * dur.max;
  const gstBit = rate.gst ? " + GST" : "";
  const rateLabel = `${rate.currency === "USD" ? "USD" : "Rs."} ${rate.amount.toLocaleString(rate.currency === "USD" ? "en-US" : "en-IN")} per ${rate.unit}${gstBit}`;
  const calc =
    dur.min === dur.max
      ? `${rateLabel} × ${dur.min} ${rate.unit}s = ${fmtMoneyAmount(minTotal, rate.currency)}`
      : `${rateLabel} × ${dur.min}–${dur.max} ${rate.unit}s = ${fmtMoneyAmount(minTotal, rate.currency)} (min) – ${fmtMoneyAmount(maxTotal, rate.currency)} (max)`;

  if (rate.currency === "INR") {
    const crMin = Math.round((minTotal / 1e7) * 100) / 100;
    const crMax = Math.round((maxTotal / 1e7) * 100) / 100;
    const size_cr = crMax;
    const size_cr_label =
      crMin === crMax
        ? String(crMin)
        : `${crMin}–${crMax} (min–max @ rate × duration)`;
    return {
      order_size: calc,
      size_cr,
      size_note: `Computed from rate × duration (${dur.min === dur.max ? `${dur.min} ${rate.unit}s` : `${dur.min}–${dur.max} ${rate.unit}s`})`,
      size_cr_label,
    };
  }

  const filingFx = extractUsdInrRate(flat);
  const marketFx =
    opts?.usdInrMarket != null &&
    Number.isFinite(opts.usdInrMarket) &&
    opts.usdInrMarket > 50 &&
    opts.usdInrMarket < 150
      ? opts.usdInrMarket
      : DEFAULT_USD_INR_MARKET;
  const fx = filingFx ?? marketFx;
  const fxSource: "filing" | "market" =
    filingFx != null ? "filing" : "market";
  const inrMin = minTotal * fx;
  const inrMax = maxTotal * fx;
  const crMin = Math.round((inrMin / 1e7) * 100) / 100;
  const crMax = Math.round((inrMax / 1e7) * 100) / 100;
  const fxNote =
    fxSource === "filing"
      ? `₹${fx}/USD from filing`
      : `₹${fx}/USD externally applied market rate (not in filing)`;
  const crRange =
    crMin === crMax ? String(crMin) : `${crMin}–${crMax}`;
  return {
    order_size: `${calc} · @ ${fxNote} → ₹ ${crRange} Cr`,
    size_cr: crMax,
    size_note: `USD×${rate.unit}s @ ${fxNote}`,
    size_cr_label:
      crMin === crMax
        ? `${crMin} (@ ${fxNote})`
        : `${crMin}–${crMax} (min–max @ ${fxNote})`,
  };
}

function extractFilingCompany(flat: string): string | null {
  const candidates = [
    flat.match(
      /Company\s+Name\s*:\s*([A-Za-z0-9 .&'-]{2,80}(?:Limited|Ltd\.?))/i,
    )?.[1],
    // Closing: "For, Deep Industries Limited" (letterhead often image-only)
    flat.match(
      /For,?\s+([A-Z][A-Za-z0-9 .&'-]{2,70}(?:Limited|Ltd\.?))/i,
    )?.[1],
    // Sub: "Time Technoplast Limited secures order…"
    flat.match(
      /\b((?:[A-Z][A-Za-z0-9.&'-]+(?:\s+[A-Z][A-Za-z0-9.&'-]+){0,5})\s+Limited)\s+(?:secures|receives|bagged|won|has\s+received)/i,
    )?.[1],
    flat.match(
      /\b((?:Afcons|Rajputana|Cosmic|Deep|K\.?\s*P\.?|Time)\s+[A-Za-z0-9 .&'-]{2,50}(?:Limited|Ltd\.?))/i,
    )?.[1],
    flat.match(
      /\b([A-Z][A-Za-z0-9 .&'-]{2,60}(?:Limited|Ltd\.?))\s+CIN\s*:/i,
    )?.[1],
  ];
  for (const raw of candidates) {
    const name = raw?.replace(/\s+/g, " ").trim() || null;
    if (name && !isExchangeOrCounterpartyName(name)) return name;
  }
  return null;
}

/** NSE/BSE symbol when the PDF only has company name / scrip code. */
function inferTickerFromCompany(flat: string, company: string | null): string | null {
  if (/Afcons\s+Infrastructure/i.test(flat)) return "AFCONS";
  if (/Rajputana\s+Stainless/i.test(flat)) return "RSL";
  if (/K\.?\s*P\.?\s+Energy/i.test(flat)) return "KPEL";
  return null;
}

function normalizeCompanyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(
      /\b(limited|ltd\.?|private|pvt\.?|llp|corporation|corp\.?)\b/gi,
      "",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractScripCode(flat: string): string | null {
  return (
    flat.match(/\bScrip\s*Code\s*:\s*(\d{5,6})\b/i)?.[1] ||
    flat.match(/\bSCRIP\s*CODE\s*:\s*(\d{5,6})\b/i)?.[1] ||
    flat.match(/\bBSE\s*(?:Scrip\s*)?Code\s*:\s*(\d{5,6})\b/i)?.[1] ||
    null
  );
}

function lookupTickerByCompanyName(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  company: string,
): string | null {
  const want = normalizeCompanyKey(company);
  if (want.length < 4) return null;

  // Exact (case-insensitive) name hit
  const exact = db
    .prepare(
      `SELECT ticker, name FROM company_about
       WHERE name IS NOT NULL AND LOWER(TRIM(name)) = LOWER(TRIM(?))
       LIMIT 2`,
    )
    .all(company) as Array<{ ticker: string; name: string }>;
  if (exact.length === 1) return exact[0]!.ticker.toUpperCase();

  // Token LIKE on distinctive words (skip very short tokens)
  const tokens = want.split(" ").filter((t) => t.length >= 4);
  if (tokens.length === 0) return null;
  const like = `%${tokens[0]}%`;
  const rows = db
    .prepare(
      `SELECT ticker, name FROM company_about
       WHERE name IS NOT NULL AND LOWER(name) LIKE ?
       LIMIT 40`,
    )
    .all(like) as Array<{ ticker: string; name: string }>;

  const scored = rows
    .map((r) => {
      const key = normalizeCompanyKey(r.name || "");
      let score = 0;
      if (key === want) score = 100;
      else if (key.includes(want) || want.includes(key)) score = 80;
      else {
        const hit = tokens.filter((t) => key.includes(t)).length;
        score = hit * 20;
        if (hit === tokens.length) score += 15;
      }
      return { ticker: r.ticker.toUpperCase(), score, key };
    })
    .filter((r) => r.score >= 40)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  // Unique best score only — avoid wrong pick among peers
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) {
    return null;
  }
  return scored[0]!.ticker;
}

/**
 * Fill ticker/company from company_about.db + company_bse_scrip when the PDF
 * has no Symbol: line (common on BSE-only filings).
 */
export function resolveTickerCompanyFromDb(
  extract: OrderbookExtract,
  text: string,
): OrderbookExtract {
  const flat = text.replace(/\s+/g, " ");
  try {
    const db = openSqliteNamed("company_about.db", {
      readonly: true,
      wal: true,
    });

    if (!extract.ticker) {
      const scrip = extractScripCode(flat);
      if (scrip) {
        const row = db
          .prepare(
            `SELECT ticker FROM company_bse_scrip WHERE scrip_code = ? LIMIT 1`,
          )
          .get(scrip) as { ticker: string } | undefined;
        if (row?.ticker) extract.ticker = row.ticker.toUpperCase();
      }
    }

    if (!extract.ticker && extract.company) {
      const t = lookupTickerByCompanyName(db, extract.company);
      if (t) extract.ticker = t;
    }

    // Company missing but ticker known (Symbol: line) → fill legal name
    if (extract.ticker && !extract.company) {
      const row = db
        .prepare(
          `SELECT name FROM company_about WHERE UPPER(ticker) = ? LIMIT 1`,
        )
        .get(extract.ticker.toUpperCase()) as
        | { name: string | null }
        | undefined;
      if (row?.name?.trim()) extract.company = row.name.trim();
    }
  } catch {
    /* db optional */
  }

  // Last-resort lexical map when DB miss
  if (!extract.ticker) {
    extract.ticker = inferTickerFromCompany(flat, extract.company);
  }
  return extract;
}

function parseOneAnnexure(
  block: string,
  filingCompany: string | null,
  orderDateIso?: string | null,
  fullText?: string | null,
): OrderWinRow {
  const flat = block.replace(/\s+/g, " ");
  const full = (fullText || block).replace(/\s+/g, " ");
  const STOP = ANNEXURE_FIELD_STOP;

  // "entity awarding the order" = client (AFCONS/KPEL style)
  let awarding = fieldAfter(
    flat,
    new RegExp(
      String.raw`Name\s+of\s+the\s+entity\s+awarding\s+the\s+${ORDER_CONTRACT}`,
      "i",
    ),
    STOP,
  );
  // OCR often inserts the value mid-label:
  // "… awarding the Infrastructure … Industry order(s)/contract(s) Customer"
  if (!awarding) {
    const interleaved = flat.match(
      new RegExp(
        String.raw`Name\s+of\s+the\s+entity\s+awarding\s+the\s+(.+?)\s+${ORDER_CONTRACT}\s*(.+?)(?=${STOP.source}|$)`,
        "i",
      ),
    );
    if (interleaved) {
      const merged = `${interleaved[1]} ${interleaved[2]}`
        .replace(/\s+/g, " ")
        .trim();
      if (!looksLikeAnnexureNoise(merged)) awarding = merged;
    }
  }

  // "entity to which order is awarded" = contractor (RSL style — filing co is client)
  let contractor = fieldAfter(
    flat,
    new RegExp(
      String.raw`Name\s+of\s+the\s+entity\s+to\s+which\s+${ORDER_CONTRACT}\s+is\s+awarded`,
      "i",
    ),
    STOP,
  );

  if (!awarding && contractor) {
    awarding = filingCompany;
  }
  if (!awarding) {
    const drdo = flat.match(
      /Defence\s+Research\s+and\s+Development\s+Organisation\s*\(DRDO\)/i,
    );
    if (drdo) awarding = drdo[0];
  }
  if (!awarding) {
    const ccl = flat.match(
      /M\/?s\.?\s*Central\s+Coalfields\s+Limited/i,
    );
    if (ccl) awarding = ccl[0];
  }
  if (!awarding || looksLikeAnnexureNoise(awarding)) {
    awarding = extractNarrativeAwarding(full) || null;
  }
  // Prefer charter-party counterparty with jurisdiction (UAE) when present
  const charterAw = extractNarrativeAwarding(full);
  if (charterAw && /Charter\s+Party/i.test(full) && /M\/?s\./i.test(charterAw)) {
    awarding = charterAw;
  }

  // Generic numbered-row map (fixes skipped execution when size is row 7, etc.)
  const numbered = parseNumberedAnnexureRows(full);
  if ((!awarding || looksLikeAnnexureNoise(awarding)) && numbered.awarding) {
    awarding = numbered.awarding;
  }

  let sizeRaw = fieldAfter(
    flat,
    new RegExp(
      String.raw`Broad\s+consideration\s+or\s+size\s+of\s+the\s+${ORDER_CONTRACT}`,
      "i",
    ),
    STOP,
  );
  // OCR: value mid-label — "size of the | Total contract value… order(s)/contract(s)"
  if (!sizeRaw) {
    const interleaved = flat.match(
      new RegExp(
        String.raw`Broad\s+consideration\s+or\s+size\s+of\s+the\s+(.+?)\s+${ORDER_CONTRACT}`,
        "i",
      ),
    );
    if (interleaved?.[1]) sizeRaw = interleaved[1];
  }
  if (sizeRaw) {
    sizeRaw = sizeRaw
      .split(
        /\b(?:Whether\s+the\s+promoter|thereof|related\s+party|Sr\.\s*No|\d+\)|(?:Rupees\s+[\w\s\-]+only))\b/i,
      )[0]
      ?.trim() || sizeRaw;
  }
  // "As per charter party agreement" is not a size
  if (sizeRaw && /as\s+per\s+charter|not\s+disclosed|nil\b/i.test(sizeRaw)) {
    sizeRaw = null;
  }
  if (!sizeRaw) {
    sizeRaw = fieldAfter(
      flat,
      new RegExp(
        String.raw`Value\s+of\s+(?:the\s+)?${ORDER_CONTRACT}`,
        "i",
      ),
      STOP,
    );
  }
  if (!sizeRaw) {
    sizeRaw =
      extractDayRateSize(full) ||
      flat.match(
        /Total\s+contract\s+value\s*:\s*Rs\.?\s*[\d,]+(?:\.\d+)?\s*(?:\/\s*-)?/i,
      )?.[0] ||
      extractNarrativeSize(flat) ||
      flat.match(
        /(?:INR|Rs\.?|₹)\s*[\d,]+(?:\.\d+)?\s*(?:Lacs?|Lakhs?|Crores?|Cr\.?|\/\s*-)\s*(?:\+\s*GST[^.]*?|\(including\s+GST\))?/i,
      )?.[0] ||
      null;
  } else if (looksLikeAnnexureNoise(sizeRaw) || !looksMonetary(sizeRaw)) {
    sizeRaw =
      extractDayRateSize(full) || extractNarrativeSize(flat) || sizeRaw;
  }
  // Prefer explicit day-rate wording when hire rate is the real disclosure
  if (/per\s+day/i.test(full) && !/per\s+WTG/i.test(flat)) {
    const day = extractDayRateSize(full);
    if (day) sizeRaw = day;
  }
  if ((!sizeRaw || !looksMonetary(sizeRaw)) && numbered.size) {
    sizeRaw = numbered.size;
  }

  let execRaw = fieldAfter(
    flat,
    new RegExp(
      String.raw`Time\s+period\s+by\s+which\s+the\s+${ORDER_CONTRACT}\s+is\s+to\s+be\s+executed`,
      "i",
    ),
    STOP,
  );
  // OCR: "is to | Contract period: Five (5) Years … be executed"
  if (!execRaw) {
    const interleaved = flat.match(
      new RegExp(
        String.raw`Time\s+period\s+by\s+which\s+the\s+${ORDER_CONTRACT}\s+is\s+to\s+(.+?)\s+be\s+executed`,
        "i",
      ),
    );
    if (interleaved?.[1]) execRaw = interleaved[1];
  }
  if (!execRaw) {
    execRaw =
      flat.match(
        /Contract\s+period\s*:\s*((?:Five|Four|Three|Two|One|\d+)\s*(?:\(\s*\d+\s*\))?\s*Years?(?:\s*\(\s*[\d,]+\s*Days?\s*\))?)/i,
      )?.[1] ||
      extractNarrativeExecution(full) ||
      flat.match(
        /\b((?:Within\s+)?(?:l1|\d+|One|Two|Three|Four|Five|a)\s*(?:\(\d+\))?\s*(?:Months?|Days?|Years?|Weeks?))\b/i,
      )?.[1] ||
      null;
  } else if (!looksFixedExecution(execRaw)) {
    execRaw = extractNarrativeExecution(full) || execRaw;
  }
  if ((!execRaw || !looksFixedExecution(execRaw)) && numbered.execution) {
    execRaw = numbered.execution;
  }

  const moneyCr =
    sizeRaw && /per\s+day/i.test(sizeRaw)
      ? null
      : sizeRaw
        ? parseOrderSizeToCr(sizeRaw)
        : null;
  const nature = extractWorkNature(flat, STOP);
  // Absolute INR (Rs. 534,73,08,872/-) → nature in Order size, Cr separate.
  // Already-in-Cr/Lacs statements (AFCONS/RSL) keep monetary as Order size.
  const absoluteInr =
    !!sizeRaw &&
    /(?:INR|Rs\.?|₹)\s*[\d,]{5,}/i.test(sizeRaw) &&
    !/(?:Crores?|Cr\.?|Lacs?|Lakhs?)\b/i.test(sizeRaw);

  let order_size = cleanCell(sizeRaw);
  if (nature && moneyCr != null && absoluteInr) {
    order_size = nature;
  } else if (
    order_size !== NOT_DISCLOSED &&
    !looksMonetary(order_size) &&
    !/per\s+day/i.test(order_size)
  ) {
    // MW / capacity-only → monetary not disclosed (don't substitute LOI fluff)
    order_size = NOT_DISCLOSED;
  } else if (order_size !== NOT_DISCLOSED && /per\s+day/i.test(order_size)) {
    // Keep day-rate phrasing as-is (no Cr compact)
    order_size = order_size.replace(/\s+/g, " ").trim();
  } else if (order_size !== NOT_DISCLOSED) {
    order_size = compactOrderSize(order_size);
    if (
      (order_size === NOT_DISCLOSED || !looksMonetary(order_size)) &&
      moneyCr != null
    ) {
      order_size = `Rs. ${moneyCr} Cr`;
    }
  }

  let execution = cleanCell(execRaw);
  if (execution !== NOT_DISCLOSED && !looksFixedExecution(execution)) {
    const narrExec = extractNarrativeExecution(full);
    execution = narrExec ? cleanCell(narrExec) : NOT_DISCLOSED;
  }
  if (execution !== NOT_DISCLOSED && looksFixedExecution(execution)) {
    execution = normalizeExecution(execution, orderDateIso);
  } else if (execution !== NOT_DISCLOSED) {
    execution = NOT_DISCLOSED;
  }

  const keepMs = /^M\/?s\./i.test((awarding || "").trim());
  let awardingClean = cleanCell(awarding);
  if (awardingClean !== NOT_DISCLOSED) {
    if (!keepMs) {
      awardingClean = awardingClean.replace(/^M\/?s\.?\s*/i, "");
    } else if (!/^M\/?s\./i.test(awardingClean)) {
      awardingClean = `M/s. ${awardingClean}`;
    }
    awardingClean = awardingClean
      .replace(/\bLimited\b/gi, "Ltd")
      .replace(/\s+/g, " ")
      .trim();
    // "Secured an export order from a Global OEM customer" → entity only
    const fromEnt = awardingClean.match(
      /(?:secured|received|bagged|won)\s+(?:an?\s+)?(?:export\s+)?order\s+from\s+(?:a\s+)?(.+)$/i,
    );
    if (fromEnt?.[1]) {
      awardingClean = fromEnt[1].replace(/\s+/g, " ").trim();
    }
    if (
    /sovereign\s+AI|well[- ]established|global\s+multinational|name\s+not\s+disclosed|based\s+in\s+India/i.test(
      awardingClean,
    ) &&
    !/\b(?:Ltd|Limited|Corporation|Inc|Organisation|Organization)\b/i.test(
      awardingClean,
    ) &&
    !/name\s+not\s+disclosed/i.test(awardingClean)
  ) {
    awardingClean = `${awardingClean.replace(/[.\s]+$/, "")} (name not disclosed)`;
  }
  }

  let size_cr = moneyCr;
  let size_cr_label: string | null = null;
  if (/per\s+(day|month)\b/i.test(order_size) && execution !== NOT_DISCLOSED) {
    const expanded = expandRateTimesDuration(order_size, execution, full);
    if (expanded) {
      order_size = expanded.order_size;
      size_cr = expanded.size_cr;
      size_cr_label = expanded.size_cr_label;
    }
  }
  if (
    size_cr == null &&
    detectFxCurrency(order_size) &&
    !/per\s+(day|month)\b/i.test(order_size)
  ) {
    const conv = convertForeignLumpSumToCr(order_size, full);
    if (conv) {
      size_cr = conv.size_cr;
      size_cr_label = conv.size_cr_label;
    }
  }

  return {
    awarding_entity: awardingClean,
    order_size,
    execution,
    size_cr,
    size_cr_label,
    contractor: contractor ? cleanCell(contractor) : null,
  };
}

/** Core lexical extract for Reg-30 order announcements. */
export function enrichOrderbookLexical(text: string): OrderbookExtract {
  const out = emptyExtract();
  const flat = text.replace(/\s+/g, " ");

  out.company = extractFilingCompany(flat);

  out.ticker =
    flat.match(/\bSymbol\s*:\s*([A-Z0-9.&-]+)/i)?.[1]?.toUpperCase() ||
    flat.match(/\bNSE\s+Symbol\s*:\s*([A-Z0-9.&-]+)/i)?.[1]?.toUpperCase() ||
    flat.match(/\b(?:COMPANY\s+CODE|Script\s+Symbol|Scrip\s+Symbol)\s*:\s*([A-Z0-9.&-]+)/i)?.[1]?.toUpperCase() ||
    null;
  // Ticker from company_about / BSE scrip is applied in resolveTickerCompanyFromDb
  out.subject =
    text
      .match(/Sub(?:ject)?\s*:\s*(.+)/i)?.[1]
      ?.trim()
      .replace(/\s+/g, " ")
      .slice(0, 280) || null;
  out.order_date = extractOrderDate(flat);

  const blocks = splitAnnexureBlocks(text);
  const orders: OrderWinRow[] = [];
  for (const b of blocks) {
    const row = parseOneAnnexure(b, out.company, out.order_date, text);
    // Skip empty / letter-preamble shells (exec-only noise from full-doc fallback)
    if (
      row.awarding_entity === NOT_DISCLOSED &&
      row.order_size === NOT_DISCLOSED &&
      !row.contractor
    ) {
      continue;
    }
    orders.push(row);
  }

  // Fallback: whole doc as one block
  if (orders.length === 0) {
    orders.push(parseOneAnnexure(text, out.company, out.order_date, text));
  }

  out.orders = orders;
  const primary = orders[0]!;
  out.awarding_entity = primary.awarding_entity;
  out.order_size = primary.order_size;
  out.execution = primary.execution;
  out.order_size_note =
    primary.size_cr_label ||
    (primary.order_size === NOT_DISCLOSED ? null : primary.order_size);
  out.execution_period =
    primary.execution === NOT_DISCLOSED ? null : primary.execution;
  // Total ₹ Cr across all annexures (1621 Lacs + 22.71 Cr → ~38.92)
  out.order_size_cr = sumOrderSizeCr(orders);

  out.nature =
    flat
      .match(
        /Nature\s+of\s+order\(s\)\s*\/\s*contract\(s\)\s+(.+?)\s+Whether\s+domestic/i,
      )?.[1]
      ?.replace(/\s+/g, " ")
      .trim() || null;

  out.domestic_or_international =
    flat.match(
      /Whether\s+domestic\s+or\s+international\s+(Domestic|International)\b/i,
    )?.[1] || null;

  out.promoter_interest =
    flat.match(/details\s+thereof\s+(Yes|No)\b/i)?.[1] || null;
  out.related_party =
    flat.match(/arm[’']?s\s+length[”"']?\s+(Yes|No)\b/i)?.[1] || null;

  const totalOb = flat.match(
    /Total\s+Order\s+Book[^\d]{0,40}([\d,]+(?:\.\d+)?)\s*Cr/i,
  );
  if (totalOb) out.order_book_cr = parseOrderSizeToCr(`${totalOb[1]} Cr`);

  let conf = 0.15;
  if (orders.some((o) => o.awarding_entity !== NOT_DISCLOSED)) conf += 0.35;
  if (orders.some((o) => o.order_size !== NOT_DISCLOSED)) conf += 0.3;
  if (orders.some((o) => o.execution !== NOT_DISCLOSED)) conf += 0.2;
  out.confidence = Math.min(1, conf);

  return out;
}

/** Validation-facing core JSON rows. */
export function toCoreOrderFields(extract: OrderbookExtract): Array<{
  "Awarding entity": string;
  "Order size": string;
  Execution: string;
}> {
  const rows =
    extract.orders.length > 0
      ? extract.orders
      : [
          {
            awarding_entity: extract.awarding_entity,
            order_size: extract.order_size,
            execution: extract.execution,
            size_cr: extract.order_size_cr,
            contractor: null,
          },
        ];
  return rows.map((o) => ({
    "Awarding entity": o.awarding_entity || NOT_DISCLOSED,
    "Order size": o.order_size || NOT_DISCLOSED,
    Execution: o.execution || NOT_DISCLOSED,
  }));
}

/** Full extract JSON for UI (Claude-style + sales/ratio when looked up). */
export function toOrderbookExtractJson(extract: OrderbookExtract): Record<
  string,
  string | number | null
> {
  const core = toCoreOrderFields(extract)[0] || {
    "Awarding entity": NOT_DISCLOSED,
    "Order size": NOT_DISCLOSED,
    Execution: NOT_DISCLOSED,
  };
  const sizeLabel =
    extract.orders[0]?.size_cr_label ||
    extract.order_size_note ||
    (extract.order_size_cr != null ? extract.order_size_cr : NOT_DISCLOSED);
  return {
    ...core,
    "Size as ₹ Cr (total)": sizeLabel,
    "Annual sales ₹ Cr":
      extract.sales_cr != null
        ? extract.sales_year
          ? `${extract.sales_cr} (${extract.sales_year})`
          : extract.sales_cr
        : NOT_DISCLOSED,
    "Order / Sales":
      extract.order_to_sales_pct != null
        ? `${extract.order_to_sales_pct.toFixed(2)}%`
        : NOT_DISCLOSED,
  };
}

async function attachSales(
  extract: OrderbookExtract,
): Promise<OrderbookExtract> {
  const ticker = extract.ticker;
  if (!ticker) return extract;
  try {
    const annual = await fetchScreenerAnnual(ticker, { consolidated: true });
    let sales: number | null = null;
    let year: string | null = null;
    for (let i = annual.sales.length - 1; i >= 0; i--) {
      const s = annual.sales[i];
      if (s != null && Number.isFinite(s) && s > 0) {
        sales = s;
        year = annual.dates[i] || null;
        break;
      }
    }
    extract.sales_cr = sales;
    extract.sales_year = year;
    const orderCr =
      extract.order_size_cr ??
      sumOrderSizeCr(extract.orders) ??
      extract.order_book_cr;
    if (orderCr != null && sales != null && sales > 0) {
      extract.order_size_cr = orderCr;
      extract.order_to_sales_pct =
        Math.round((orderCr / sales) * 10000) / 100;
    } else if (orderCr != null) {
      extract.order_size_cr = orderCr;
    }
  } catch {
    /* ignore */
  }
  return extract;
}

/** LTP + post-announcement drift (vs last close before order_date). */
export async function attachOrderbookPrices(
  extract: OrderbookExtract,
): Promise<OrderbookExtract> {
  const ticker = extract.ticker;
  if (!ticker) return extract;
  try {
    const [quote, bars] = await Promise.all([
      fetchQuoteDetailed(ticker, "NSE", { skipSummary: true }),
      fetchDailyBars(ticker, "NSE", 2),
    ]);
    const ltp =
      quote.price != null && Number.isFinite(quote.price) ? quote.price : null;
    extract.ltp = ltp;
    const day = extract.order_date?.slice(0, 10) || null;
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

function decideWhy(extract: OrderbookExtract, core: ReturnType<typeof toCoreOrderFields>): string {
  if (core.length === 0) return "FAIL — no order fields found.";
  const parts = core.map((c, i) => {
    const n = core.length > 1 ? `#${i + 1} ` : "";
    return `${n}${c["Awarding entity"]} · ${c["Order size"]} · ${c.Execution}`;
  });
  const pct = extract.order_to_sales_pct;
  const dateBit = extract.order_date
    ? ` · ${formatAnnouncementDate(extract.order_date)}`
    : "";
  if (pct != null && extract.sales_cr != null && extract.order_size_cr != null) {
    const label =
      pct >= ORDERBOOK_PASS_MIN_PCT
        ? "Strong vs sales"
        : pct >= 20
          ? "Moderate vs sales"
          : "Small vs sales";
    const pass = isOrderbookPass(extract);
    return `${pass ? "PASS" : "FAIL"} · ${parts.join(" | ")}${dateBit} → Order/Sales ${pct}% (${label}${pass ? "" : ` — need ≥${ORDERBOOK_PASS_MIN_PCT}%`}).`;
  }
  return `FAIL · ${parts.join(" | ")}${dateBit} — need ₹ size + sales for Order/Sales ≥${ORDERBOOK_PASS_MIN_PCT}%.`;
}

function saveRow(row: {
  source_url: string | null;
  extract: OrderbookExtract;
  engine: string;
  text_chars: number;
}): number | null {
  // List is pass-only — never persist junk / small-vs-sales screens.
  if (!isOrderbookPass(row.extract)) return null;
  const db = ensureDb();
  try {
    const at = new Date().toISOString();
    if (row.extract.ticker) {
      const hit = db
        .prepare(
          `SELECT id FROM orderbook_screens WHERE upper(ticker) = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(row.extract.ticker.toUpperCase()) as { id: number } | undefined;
      if (hit) {
        db.prepare(
          `UPDATE orderbook_screens SET
            source_url=?, company=?, extract_json=?, engine=?, text_chars=?, screened_at=?
           WHERE id=?`,
        ).run(
          row.source_url,
          row.extract.company,
          JSON.stringify(row.extract),
          row.engine,
          row.text_chars,
          at,
          hit.id,
        );
        return hit.id;
      }
    }
    const info = db
      .prepare(
        `INSERT INTO orderbook_screens (
          source_url, ticker, company, extract_json, engine, text_chars, screened_at
        ) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        row.source_url,
        row.extract.ticker,
        row.extract.company,
        JSON.stringify(row.extract),
        row.engine,
        row.text_chars,
        at,
      );
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

/** Drop non-pass rows left from earlier junk saves. */
function purgeNonPassHistory(): void {
  const db = ensureDb();
  try {
    const rows = db
      .prepare(`SELECT id, extract_json FROM orderbook_screens`)
      .all() as Array<{ id: number; extract_json: string }>;
    const del = db.prepare(`DELETE FROM orderbook_screens WHERE id = ?`);
    const tx = db.transaction(() => {
      for (const r of rows) {
        let extract: OrderbookExtract = emptyExtract();
        try {
          extract = {
            ...emptyExtract(),
            ...(JSON.parse(r.extract_json) as Partial<OrderbookExtract>),
          };
        } catch {
          del.run(r.id);
          continue;
        }
        if (!isOrderbookPass(extract)) del.run(r.id);
      }
    });
    tx();
  } finally {
    db.close();
  }
}

export type OrderbookHistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  order_date: string | null;
  awarding_entity: string;
  order_size: string;
  execution: string;
  order_size_cr: number | null;
  sales_cr: number | null;
  order_to_sales_pct: number | null;
  ltp: number | null;
  baseline_close: number | null;
  drift_pct: number | null;
  screened_at: string;
};

/** Pass-only screens for the Order book list. */
export function listOrderbookHistory(limit = 40): OrderbookHistoryRow[] {
  purgeNonPassHistory();
  const db = ensureDb();
  try {
    const rows = db
      .prepare(
        `SELECT id, source_url, ticker, company, extract_json, screened_at
         FROM orderbook_screens
         ORDER BY screened_at DESC
         LIMIT ?`,
      )
      .all(Math.min(200, Math.max(1, limit))) as Array<{
      id: number;
      source_url: string | null;
      ticker: string | null;
      company: string | null;
      extract_json: string;
      screened_at: string;
    }>;

    const out: OrderbookHistoryRow[] = [];
    for (const r of rows) {
      let extract: OrderbookExtract = emptyExtract();
      try {
        extract = {
          ...emptyExtract(),
          ...(JSON.parse(r.extract_json) as Partial<OrderbookExtract>),
        };
      } catch {
        continue;
      }
      if (!isOrderbookPass(extract)) continue;
      out.push({
        id: r.id,
        source_url: r.source_url,
        ticker: r.ticker || extract.ticker,
        company: r.company || extract.company,
        order_date: extract.order_date,
        awarding_entity: extract.awarding_entity || NOT_DISCLOSED,
        order_size: extract.order_size || NOT_DISCLOSED,
        execution: extract.execution || NOT_DISCLOSED,
        order_size_cr: extract.order_size_cr,
        sales_cr: extract.sales_cr,
        order_to_sales_pct: extract.order_to_sales_pct,
        ltp: extract.ltp,
        baseline_close: extract.baseline_close,
        drift_pct: extract.drift_pct,
        screened_at: r.screened_at,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/** Refresh LTP + post-announcement drift for PASS list rows. */
export async function refreshOrderbookHistoryPrices(
  rows: OrderbookHistoryRow[],
): Promise<OrderbookHistoryRow[]> {
  const out: OrderbookHistoryRow[] = [];
  for (const row of rows) {
    if (!row.ticker) {
      out.push({ ...row, ltp: null, drift_pct: null });
      continue;
    }
    try {
      const patch = await attachOrderbookPrices({
        ...emptyExtract(),
        ticker: row.ticker,
        order_date: row.order_date,
      });
      out.push({
        ...row,
        ltp: patch.ltp,
        baseline_close: patch.baseline_close,
        drift_pct: patch.drift_pct,
      });
    } catch {
      out.push(row);
    }
  }
  return out;
}

export async function screenOrderbookPdf(opts: {
  url?: string | null;
  pdfBuffer?: Buffer | null;
}): Promise<OrderbookScreenResult> {
  const source_url = opts.url?.trim() || null;
  let buf = opts.pdfBuffer ?? null;
  let engine = "none";

  if (!buf && source_url) {
    buf = await downloadOrderbookPdf(source_url);
  }
  if (!buf) {
    const extract = emptyExtract();
    return {
      ok: false,
      decision: "fail",
      extract,
      engine,
      text_chars: 0,
      text_excerpt: "",
      source_url,
      pending_fields: false,
      why: "No PDF bytes to read.",
      core: toCoreOrderFields(extract),
      error: source_url
        ? "Could not download PDF (try upload)"
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
        const extract = emptyExtract();
        return {
          ok: false,
          decision: "fail",
          extract,
          engine,
          text_chars: text.length,
          text_excerpt: text.slice(0, 4000),
          source_url,
          pending_fields: false,
          why: "Could not OCR enough text.",
          core: toCoreOrderFields(extract),
          error:
            e instanceof Error
              ? e.message
              : "OCR failed — set QIANFAN_OCR_BASE_URL or upload a text PDF",
        };
      }
    }
  }

  if (text.length < 80) {
    const extract = emptyExtract();
    return {
      ok: false,
      decision: "fail",
      extract,
      engine,
      text_chars: text.length,
      text_excerpt: text.slice(0, 4000),
      source_url,
      pending_fields: false,
      why: "Little text from PDF.",
      core: toCoreOrderFields(extract),
      error: "Little text from PDF — upload another file or enable vision OCR",
    };
  }

  let extract = enrichOrderbookLexical(text);
  extract = resolveTickerCompanyFromDb(extract, text);
  try {
    const liveFx = await fetchInrFxMarketRates();
    if (Object.keys(liveFx).length) {
      extract = applyOrderbookMarketFx(
        extract,
        text.replace(/\s+/g, " "),
        liveFx,
      );
    }
  } catch {
    /* keep DEFAULT_FX_INR from lexical expand */
  }
  extract = await attachSales(extract);
  // Recompute Order/Sales after FX may have filled order_size_cr
  if (
    extract.order_size_cr != null &&
    extract.sales_cr != null &&
    extract.sales_cr > 0
  ) {
    extract.order_to_sales_pct =
      Math.round((extract.order_size_cr / extract.sales_cr) * 10000) / 100;
  }
  extract = await attachOrderbookPrices(extract);
  const core = toCoreOrderFields(extract);
  const extract_json = toOrderbookExtractJson(extract);
  const pass = isOrderbookPass(extract);
  const why = decideWhy(extract, core);
  const ok = core.some(
    (c) =>
      c["Awarding entity"] !== NOT_DISCLOSED ||
      c["Order size"] !== NOT_DISCLOSED ||
      c.Execution !== NOT_DISCLOSED,
  );

  const id = saveRow({
    source_url,
    extract,
    engine,
    text_chars: text.length,
  });

  return {
    ok,
    decision: pass ? "pass" : "fail",
    extract,
    engine,
    text_chars: text.length,
    text_excerpt: text.slice(0, 8000),
    source_url,
    id: id ?? undefined,
    screened_at: new Date().toISOString(),
    pending_fields: false,
    why,
    core,
    extract_json,
    error: ok
      ? pass
        ? undefined
        : `Not saved — need Order/Sales ≥${ORDERBOOK_PASS_MIN_PCT}% with awarding / size / execution`
      : "No awarding entity / order size / execution found",
  };
}
