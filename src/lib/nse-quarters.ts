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
const CORPORATES_RESULTS_URL =
  "https://www.nseindia.com/api/corporates-financial-results";
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

/** Non-Ind-AS (BSE-format) tags used on NSE SME corporates XBRL. */
const NON_IND_REV_TAGS = ["RevenueFromOperations", "Revenue"] as const;
const NON_IND_NP_TAGS = [
  "ProfitLossForThePeriod",
  "ProfitLossForPeriod",
  "ProfitLossForPeriodFromContinuingOperations",
  "ProfitLossForThePeriodFromContinuingOperations",
] as const;
const NON_IND_EPS_TAGS = [
  "DilutedEarningsLossPerShareFromContinuingAndDiscontinuedOperations",
  "BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations",
  "DilutedEarningsLossPerShareFromContinuingOperations",
  "BasicEarningsLossPerShareFromContinuingOperations",
] as const;
const NON_IND_EBIT_TAGS = [
  "ProfitBeforeExceptionalAndExtraordinaryItemsAndTax",
  "ProfitBeforeTax",
  "ProfitBeforeExtraordinaryItemsAndTax",
] as const;
const NON_IND_OTHER_INCOME_TAGS = ["OtherIncome"] as const;

type CookieJar = { cookie: string };

type FilingMeta = {
  period_end: string;
  xbrl: string;
  is_consolidated: boolean;
};

type CorporatesFilingMeta = {
  to_date: string;
  from_date: string | null;
  xbrl: string;
  is_consolidated: boolean;
  is_half_yearly: boolean;
  broadcast_ms: number;
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

function contextPeriodEnd($: cheerio.CheerioAPI, contextId: string): string {
  let periodEnd = "";
  $("*").each((_, el) => {
    const tag = localTag(el.tagName || "").toLowerCase();
    if (tag !== "context" || $(el).attr("id") !== contextId) return;
    $(el)
      .find("*")
      .each((__, child) => {
        if (localTag(child.tagName || "").toLowerCase() !== "enddate") return;
        const end = safeStr($(child).text());
        if (end) periodEnd = end.slice(0, 10);
      });
  });
  return periodEnd;
}

function contextFacts(
  $: cheerio.CheerioAPI,
  contextRef: string,
): Record<string, number> {
  const facts: Record<string, number> = {};
  $(`[contextRef='${contextRef}']`).each((_, el) => {
    const name = localTag(el.tagName || "");
    const raw = safeStr($(el).text()).replace(/,/g, "");
    if (!name || !raw) return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    facts[name] = n;
  });
  return facts;
}

function factsToQuarterPoint(
  facts: Record<string, number>,
  periodEnd: string,
  revTags: readonly string[],
  npTags: readonly string[],
  epsTags: readonly string[],
  ebitTags: readonly string[],
  oiTags: readonly string[],
): QuarterPoint | null {
  if (!periodEnd) return null;
  const revenue = pickFact(facts, revTags);
  const netIncome = pickFact(facts, npTags);
  const eps = pickFact(facts, epsTags);
  const ebit = pickFact(facts, ebitTags);
  const otherIncome = pickFact(facts, oiTags);
  if (revenue == null && netIncome == null && eps == null) return null;
  return { date: periodEnd, revenue, netIncome, eps, ebit, otherIncome };
}

/** Extract OneD (and optionally FourD) P&L from Non-Ind-AS NSE corporates XBRL. */
export function parseNonIndAsQuarterXbrl(
  xmlText: string,
  opts?: { fallbackEnd?: string | null },
): { oneD: QuarterPoint | null; fourD: QuarterPoint | null } {
  if (!xmlText?.trim()) return { oneD: null, fourD: null };
  const $ = cheerio.load(xmlText, { xml: true });
  const fallbackEnd = opts?.fallbackEnd ?? null;

  const oneEnd = contextPeriodEnd($, "OneD") || fallbackEnd || "";
  const fourEnd =
    contextPeriodEnd($, "FourD") || oneEnd || fallbackEnd || "";

  const oneD = factsToQuarterPoint(
    contextFacts($, "OneD"),
    oneEnd,
    NON_IND_REV_TAGS,
    NON_IND_NP_TAGS,
    NON_IND_EPS_TAGS,
    NON_IND_EBIT_TAGS,
    NON_IND_OTHER_INCOME_TAGS,
  );
  const fourD = factsToQuarterPoint(
    contextFacts($, "FourD"),
    fourEnd,
    NON_IND_REV_TAGS,
    NON_IND_NP_TAGS,
    NON_IND_EPS_TAGS,
    NON_IND_EBIT_TAGS,
    NON_IND_OTHER_INCOME_TAGS,
  );

  return { oneD, fourD };
}

function subtractQuarterPoints(
  cumulative: QuarterPoint,
  current: QuarterPoint,
  date: string,
): QuarterPoint | null {
  const sub = (a: number | null, b: number | null): number | null => {
    if (a == null || b == null) return null;
    const v = a - b;
    return Number.isFinite(v) ? v : null;
  };
  const revenue = sub(cumulative.revenue, current.revenue);
  const netIncome = sub(cumulative.netIncome, current.netIncome);
  const ebit = sub(cumulative.ebit, current.ebit);
  const otherIncome = sub(cumulative.otherIncome ?? null, current.otherIncome ?? null);
  if (revenue == null && netIncome == null) return null;
  return {
    date,
    revenue,
    netIncome,
    eps: null,
    ebit,
    otherIncome,
  };
}

/** Last day of the first calendar quarter in a half-year block (fromDate + 3 months). */
function firstQuarterEndFromHalfYearStart(fromDate: string): string | null {
  const d = new Date(`${fromDate}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return null;
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 0));
  return end.toISOString().slice(0, 10);
}

function isCumulativeHalfYear(
  oneD: QuarterPoint,
  fourD: QuarterPoint,
): boolean {
  const r4 = fourD.revenue;
  const r1 = oneD.revenue;
  if (r4 != null && r1 != null && r4 > r1 * 1.05) return true;
  const n4 = fourD.netIncome;
  const n1 = oneD.netIncome;
  if (n4 != null && n1 != null && Math.abs(n4) > Math.abs(n1) * 1.05) {
    return true;
  }
  return false;
}

function hasQuarterSignal(q: QuarterPoint): boolean {
  if (q.eps != null && q.eps !== 0) return true;
  if (q.revenue != null && q.revenue !== 0) return true;
  if (q.netIncome != null && q.netIncome !== 0) return true;
  return false;
}

function broadcastMs(raw: unknown): number {
  const text = safeStr(raw);
  const m = text.match(
    /^(\d{2})-([A-Z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/i,
  );
  if (!m) return 0;
  const mon = MONTH_NUM[m[2]!.toUpperCase()];
  if (!mon) return 0;
  return Date.UTC(
    Number(m[3]),
    Number(mon) - 1,
    Number(m[1]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
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

function isStandaloneFiling(consolidated: unknown): boolean {
  const text = safeStr(consolidated).toLowerCase();
  return text.includes("non") || text.includes("stand");
}

async function listCorporatesFinancialFilings(
  symbol: string,
  jar: CookieJar,
  index: "sme" | "equities",
): Promise<CorporatesFilingMeta[]> {
  const resp = await nseFetch(CORPORATES_RESULTS_URL, jar, {
    params: { index, symbol },
    referer: NSE_HOME,
  });
  if (!resp.ok) return [];
  const rows = (await resp.json()) as unknown;
  if (!Array.isArray(rows)) return [];

  const out: CorporatesFilingMeta[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const xbrl = safeStr(o.xbrl);
    if (!xbrl.startsWith("http") || xbrl.endsWith("/-") || xbrl.includes("/xbrl/-")) {
      continue;
    }
    const to_date = quarterEndIso(o.toDate);
    if (!to_date) continue;
    const fromRaw = quarterEndIso(o.fromDate);
    const relating = safeStr(o.relatingTo);
    out.push({
      to_date,
      from_date: fromRaw,
      xbrl,
      is_consolidated: !isStandaloneFiling(o.consolidated),
      is_half_yearly: /half/i.test(relating) || /half/i.test(safeStr(o.period)),
      broadcast_ms: broadcastMs(o.broadCastDate || o.exchdisstime),
    });
  }
  out.sort((a, b) => b.broadcast_ms - a.broadcast_ms);
  return out;
}

async function fetchNseCorporatesQuarterlyFundamentals(
  symbol: string,
  jar: CookieJar,
  opts?: { maxQuarters?: number },
): Promise<QuarterPoint[]> {
  const maxQ = Math.max(2, opts?.maxQuarters ?? 6);
  let filings: CorporatesFilingMeta[] = [];
  for (const index of ["sme", "equities"] as const) {
    try {
      const batch = await listCorporatesFinancialFilings(symbol, jar, index);
      if (batch.length) filings = filings.concat(batch);
    } catch {
      /* try next index */
    }
  }
  if (!filings.length) return [];

  filings.sort((a, b) => b.broadcast_ms - a.broadcast_ms);
  const byDate = new Map<string, QuarterPoint>();

  for (const filing of filings) {
    if (filing.is_consolidated) continue;
    let parsed: { oneD: QuarterPoint | null; fourD: QuarterPoint | null };
    try {
      const resp = await nseFetch(filing.xbrl, jar, { referer: NSE_HOME });
      if (!resp.ok) continue;
      const xml = await resp.text();
      parsed = parseNonIndAsQuarterXbrl(xml, { fallbackEnd: filing.to_date });
    } catch {
      continue;
    }

    const { oneD, fourD } = parsed;
    if (oneD && hasQuarterSignal(oneD) && !byDate.has(oneD.date)) {
      byDate.set(oneD.date, oneD);
    }

    if (
      filing.is_half_yearly &&
      filing.from_date &&
      oneD &&
      fourD &&
      isCumulativeHalfYear(oneD, fourD)
    ) {
      const priorEnd = firstQuarterEndFromHalfYearStart(filing.from_date);
      if (priorEnd && !byDate.has(priorEnd)) {
        const derived = subtractQuarterPoints(fourD, oneD, priorEnd);
        if (derived && hasQuarterSignal(derived)) byDate.set(priorEnd, derived);
      }
    }

    if (byDate.size >= maxQ + 2) break;
  }

  return trimReportedQuarters([...byDate.values()]).slice(-maxQ);
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
    filings = [];
  }

  const maxQ = Math.max(2, opts?.maxQuarters ?? 6);
  const points: QuarterPoint[] = [];

  if (filings.length) {
    const periodEnds = [...new Set(filings.map((f) => f.period_end))].slice(
      0,
      maxQ,
    );

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
  }

  const integrated = trimReportedQuarters(points);
  if (integrated.length >= 2) return integrated.slice(-maxQ);

  try {
    const corporates = await fetchNseCorporatesQuarterlyFundamentals(
      symbol,
      jar,
      opts,
    );
    if (corporates.length >= 2) return corporates;
    if (corporates.length > integrated.length) return corporates;
  } catch {
    /* keep integrated */
  }

  return integrated;
}

const RD_TAGS = [
  "ResearchAndDevelopmentExpense",
  "ResearchAndDevelopmentExpenses",
  "ResearchAndDevelopmentExpenditure",
  "ExpenditureOnResearchAndDevelopment",
  "ResearchDevelopmentExpense",
  "ExpensesByNatureResearchAndDevelopmentExpense",
] as const;

const RD_CONTEXTS = ["OneD", "FourD", "OneI"] as const;

export type RdXbrlResult = {
  rd: number | null;
  revenue: number | null;
  rd_pct: number | null;
  period_end: string | null;
  source: "nse_xbrl" | "nse_corporates_xbrl";
  xbrl_url: string | null;
};

function isUsableXbrlUrl(url: string): boolean {
  const u = url.trim();
  if (!u.startsWith("http")) return false;
  if (u.endsWith("/-") || u.includes("/xbrl/-")) return false;
  return true;
}

/** Parse R&D line item from integrated / corporates XBRL (any standard context). */
export function parseRdFromXbrlXml(xmlText: string): {
  rd: number | null;
  context: string | null;
} {
  if (!xmlText?.trim()) return { rd: null, context: null };
  for (const ctx of RD_CONTEXTS) {
    for (const tag of RD_TAGS) {
      const re = new RegExp(
        `<(?:[\\w-]+:)?${tag}[^>]*contextRef=['"]${ctx}['"][^>]*>([^<]+)<`,
        "i",
      );
      const m = xmlText.match(re);
      if (!m?.[1]) continue;
      const n = Number(m[1].replace(/,/g, "").trim());
      if (Number.isFinite(n)) return { rd: n, context: ctx };
    }
  }
  return { rd: null, context: null };
}

async function rdFromXbrlUrl(
  xbrlUrl: string,
  jar: CookieJar,
  source: RdXbrlResult["source"],
): Promise<RdXbrlResult | null> {
  if (!isUsableXbrlUrl(xbrlUrl)) return null;
  try {
    const resp = await nseFetch(xbrlUrl, jar, { referer: NSE_HOME });
    if (!resp.ok) return null;
    const xml = await resp.text();
    const indAs = parseIndAsQuarterXbrl(xml);
    const nonInd = parseNonIndAsQuarterXbrl(xml);
    const revenue =
      indAs?.revenue ?? nonInd.oneD?.revenue ?? nonInd.fourD?.revenue ?? null;
    const period_end =
      indAs?.date ?? nonInd.oneD?.date ?? nonInd.fourD?.date ?? null;
    const { rd } = parseRdFromXbrlXml(xml);
    const rd_pct =
      rd != null && revenue != null && revenue > 0 ? (rd / revenue) * 100 : null;
    return {
      rd,
      revenue,
      rd_pct,
      period_end,
      source,
      xbrl_url: xbrlUrl,
    };
  } catch {
    return null;
  }
}

/** Latest R&D from NSE Ind-AS integrated filing, then corporates (SME) XBRL. */
export async function fetchNseLatestRdExpense(
  ticker: string,
): Promise<RdXbrlResult | null> {
  const symbol = nseQuarterSymbol(ticker);
  if (!symbol) return null;

  const jar = await warmNseSession();

  let filings: FilingMeta[] = [];
  try {
    filings = await listFinancialFilings(symbol, jar);
  } catch {
    filings = [];
  }

  if (filings.length) {
    const latestPe = filings[0]!.period_end;
    const filing = pickFiling(filings, latestPe);
    if (filing?.xbrl) {
      const hit = await rdFromXbrlUrl(filing.xbrl, jar, "nse_xbrl");
      if (hit) return hit;
    }
  }

  let corporates: CorporatesFilingMeta[] = [];
  for (const index of ["sme", "equities"] as const) {
    try {
      const batch = await listCorporatesFinancialFilings(symbol, jar, index);
      corporates = corporates.concat(batch);
    } catch {
      /* try next */
    }
  }
  corporates.sort((a, b) => b.broadcast_ms - a.broadcast_ms);
  for (const filing of corporates) {
    if (!isUsableXbrlUrl(filing.xbrl)) continue;
    const hit = await rdFromXbrlUrl(filing.xbrl, jar, "nse_corporates_xbrl");
    if (hit) return hit;
  }

  return null;
}
