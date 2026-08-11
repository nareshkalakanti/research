/**
 * NSE Integrated Filing – Financials XBRL → quarterly P&L points.
 * Fallback when Yahoo fundamentalsTimeSeries is empty (e.g. ZODIAC).
 */
import * as cheerio from "cheerio";
import type { QuarterPoint } from "./quarter-panel";
import { trimReportedQuarters } from "./quarter-panel";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NSE_HOME = "https://www.nseindia.com/";
const NSE_QUOTE = "https://www.nseindia.com/get-quotes/equity";
const INTEGRATED_URL =
  "https://www.nseindia.com/api/integrated-filing-results";
const TIMEOUT_MS = 45_000;

const MONTH_NUM: Record<string, string> = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
};

const REV_TAGS = ["RevenueFromOperations"] as const;
const NP_TAGS = [
  "ProfitLossForPeriod",
  "ProfitLossForPeriodFromContinuingOperations",
] as const;
const EPS_TAGS = [
  "DilutedEarningsLossPerShareFromContinuingOperations",
  "BasicEarningsLossPerShareFromContinuingOperations",
  "DilutedEarningsLossPerShareFromContinuingAndDiscontinuedOperations",
  "BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations",
] as const;
const EBIT_TAGS = [
  "SegmentProfitLossBeforeTaxAndFinanceCosts",
  "ProfitBeforeInterestAndFinanceCosts",
  "ProfitFromOperationsBeforeOtherIncomeInterestAndExceptionalItems",
  "ProfitBeforeExceptionalItemsAndTax",
] as const;
const OTHER_INCOME_TAGS = ["OtherIncome"] as const;

type CookieJar = { cookie: string };

type FilingMeta = {
  period_end: string;
  xbrl: string;
  is_consolidated: boolean;
};

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function localTag(tag: string): string {
  const bare = tag.includes(":") ? tag.split(":").pop()! : tag;
  return bare.includes("}") ? bare.split("}").pop()! : bare;
}

function quarterEndIso(raw: unknown): string | null {
  const text = safeStr(raw).toUpperCase().replace(/\s+/g, "");
  if (!text) return null;
  const m = text.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/);
  if (!m) return null;
  const month = MONTH_NUM[m[2]!];
  if (!month) return null;
  return `${m[3]}-${month}-${String(Number(m[1])).padStart(2, "0")}`;
}

/** NSE API symbol — strip SME suffix. */
export function nseQuarterSymbol(ticker: string): string {
  return safeStr(ticker)
    .toUpperCase()
    .replace(/-SM$/i, "");
}

async function nseFetch(
  url: string,
  jar: CookieJar,
  opts?: { params?: Record<string, string>; referer?: string },
): Promise<Response> {
  const u = new URL(url);
  if (opts?.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      u.searchParams.set(k, v);
    }
  }
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json,text/xml,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: opts?.referer || NSE_HOME,
  };
  if (jar.cookie) headers.Cookie = jar.cookie;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), {
      headers,
      signal: ctrl.signal,
      redirect: "follow",
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length) {
      const parts = setCookie.map((c) => c.split(";")[0]!).filter(Boolean);
      jar.cookie = [
        ...new Set([...(jar.cookie ? jar.cookie.split("; ") : []), ...parts]),
      ].join("; ");
    } else {
      const sc = res.headers.get("set-cookie");
      if (sc) {
        const part = sc.split(";")[0];
        if (part) {
          jar.cookie = jar.cookie ? `${jar.cookie}; ${part}` : part;
        }
      }
    }
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function warmNseSession(): Promise<CookieJar> {
  const jar: CookieJar = { cookie: "" };
  try {
    await nseFetch(NSE_QUOTE, jar, {
      params: { symbol: "TCS" },
      referer: NSE_HOME,
    });
  } catch {
    try {
      await nseFetch(NSE_HOME, jar);
    } catch {
      /* empty jar */
    }
  }
  return jar;
}

function pickFact(
  facts: Record<string, number>,
  tags: readonly string[],
): number | null {
  for (const t of tags) {
    if (facts[t] != null && Number.isFinite(facts[t])) return facts[t]!;
  }
  return null;
}

/** Extract OneD (current quarter) P&L from Ind-AS Integrated Filing XBRL. */
export function parseIndAsQuarterXbrl(xmlText: string): QuarterPoint | null {
  if (!xmlText?.trim()) return null;
  const $ = cheerio.load(xmlText, { xml: true });

  let periodEnd = "";
  $("*").each((_, el) => {
    const tag = localTag(el.tagName || "").toLowerCase();
    if (tag !== "context" || $(el).attr("id") !== "OneD") return;
    $(el)
      .find("*")
      .each((__, child) => {
        if (localTag(child.tagName || "").toLowerCase() !== "enddate") return;
        const end = safeStr($(child).text());
        if (end) periodEnd = end.slice(0, 10);
      });
  });

  const facts: Record<string, number> = {};
  $("[contextRef='OneD']").each((_, el) => {
    const name = localTag(el.tagName || "");
    const raw = safeStr($(el).text()).replace(/,/g, "");
    if (!name || !raw) return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    facts[name] = n;
  });

  const revenue = pickFact(facts, REV_TAGS);
  const netIncome = pickFact(facts, NP_TAGS);
  const eps = pickFact(facts, EPS_TAGS);
  const ebit = pickFact(facts, EBIT_TAGS);
  const otherIncome = pickFact(facts, OTHER_INCOME_TAGS);

  if (revenue == null && netIncome == null && eps == null) return null;
  if (!periodEnd) return null;

  return {
    date: periodEnd,
    revenue,
    netIncome,
    eps,
    ebit,
    otherIncome,
  };
}

async function listFinancialFilings(
  symbol: string,
  jar: CookieJar,
): Promise<FilingMeta[]> {
  const resp = await nseFetch(INTEGRATED_URL, jar, {
    params: { symbol, integratedType: "Financials" },
    referer: NSE_HOME,
  });
  if (!resp.ok) return [];
  const payload = (await resp.json()) as { data?: unknown } | unknown;
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];

  const out: FilingMeta[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const xbrl = safeStr(o.xbrl);
    if (!xbrl.startsWith("http") || !xbrl.toUpperCase().includes("INDAS")) {
      continue;
    }
    const period_end = quarterEndIso(o.qe_Date);
    if (!period_end) continue;
    const consol = safeStr(o.consolidated).toLowerCase();
    out.push({
      period_end,
      xbrl,
      is_consolidated: !consol.includes("non") && !consol.includes("stand"),
    });
  }
  out.sort((a, b) => b.period_end.localeCompare(a.period_end));
  return out;
}

function pickFiling(
  filings: FilingMeta[],
  periodEnd: string,
): FilingMeta | null {
  const pool = filings.filter((f) => f.period_end === periodEnd);
  if (!pool.length) return null;
  return pool.find((f) => f.is_consolidated) ?? pool[0]!;
}

/**
 * Last N reported quarters from NSE Integrated Filing XBRL.
 * Prefer consolidated Ind-AS filings per period-end.
 */
export async function fetchNseQuarterlyFundamentals(
  ticker: string,
  opts?: { maxQuarters?: number },
): Promise<QuarterPoint[]> {
  const symbol = nseQuarterSymbol(ticker);
  if (!symbol) return [];

  const jar = await warmNseSession();
  let filings: FilingMeta[] = [];
  try {
    filings = await listFinancialFilings(symbol, jar);
  } catch {
    return [];
  }
  if (!filings.length) return [];

  const maxQ = Math.max(2, opts?.maxQuarters ?? 6);
  const periodEnds = [...new Set(filings.map((f) => f.period_end))].slice(
    0,
    maxQ,
  );

  const points: QuarterPoint[] = [];
  for (const pe of periodEnds) {
    const filing = pickFiling(filings, pe);
    if (!filing) continue;
    try {
      const resp = await nseFetch(filing.xbrl, jar, { referer: NSE_HOME });
      if (!resp.ok) continue;
      const xml = await resp.text();
      const q = parseIndAsQuarterXbrl(xml);
      if (q) points.push(q);
    } catch {
      /* skip filing */
    }
  }

  return trimReportedQuarters(points);
}
