/**
 * NSE board composition with DIN — Integrated Filing + CG master.
 * NSE corporate governance board fetch (no DB writes here).
 */
import * as cheerio from "cheerio";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NSE_HOME = "https://www.nseindia.com/";
const NSE_QUOTE = "https://www.nseindia.com/get-quotes/equity";
const NSE_GOV_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-governance";
const INTEGRATED_URL =
  "https://www.nseindia.com/api/integrated-filing-results";
const CG_MASTER_URL =
  "https://www.nseindia.com/api/corporate-governance-master";
const CG_DETAIL_URL =
  "https://www.nseindia.com/api/corporate-governance";
const TIMEOUT_MS = 30_000;
const DUMMY_DINS = new Set(["99999999", "00000000"]);

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

export type BoardSeat = {
  din: string;
  name: string;
  designation: string;
  category: string;
  source: string;
  as_of: string;
};

export type BoardPayload = {
  ticker: string;
  name: string;
  seats: BoardSeat[];
  market: string;
  as_of: string | null;
  source: string;
};

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

export function normDin(raw: unknown): string {
  const digits = safeStr(raw).replace(/\D/g, "");
  if (!digits) return "";
  return digits.padStart(8, "0").slice(-8);
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

function inferCategory(text: string): string {
  const low = text.toLowerCase();
  if (low.includes("independent")) return "Independent";
  if (
    ["executive", "managing", "ceo", "md", "whole"].some((x) =>
      low.includes(x),
    )
  ) {
    return "Executive";
  }
  if (low.includes("non-executive") || low.includes("non executive")) {
    return "Non-Executive";
  }
  return "";
}

function designationFromParts(...parts: string[]): string {
  const bits = parts
    .map((p) => safeStr(p))
    .filter(
      (p) =>
        p &&
        !["", "-", "na", "not applicable"].includes(p.toLowerCase()),
    );
  if (!bits.length) return "Director";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of bits) {
    const key = b.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out.length ? out.join(" · ") : "Director";
}

function activeStatus(raw: unknown): boolean {
  const text = safeStr(raw).toLowerCase();
  if (!text || text === "-" || text === "na" || text === "n/a") return true;
  if (text.includes("inactive") || text.includes("cessation") || text === "no") {
    return false;
  }
  return true;
}

function indexesForMarket(market: string | null | undefined): string[] {
  if (safeStr(market).toUpperCase().includes("SME")) {
    return ["sme", "equities"];
  }
  return ["equities", "sme"];
}

function marketForIndex(index: string): string {
  return safeStr(index).toLowerCase() === "sme" ? "NSE SME" : "NSE";
}

type CookieJar = { cookie: string };

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
    Accept: "application/json,text/html,*/*",
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
      jar.cookie = [...new Set([...(jar.cookie ? jar.cookie.split("; ") : []), ...parts])].join(
        "; ",
      );
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
      /* continue with empty jar */
    }
  }
  return jar;
}

/** Parse Composition of Board table from Integrated Filing – Governance iXBRL HTML. */
export function parseGovernanceIxbrlHtml(
  htmlText: string,
  asOf?: string | null,
): BoardSeat[] {
  if (!htmlText?.trim()) return [];
  const $ = cheerio.load(htmlText);
  const seats: BoardSeat[] = [];
  const seenDin = new Set<string>();

  $("table").each((_, table) => {
    if (seats.length) return;
    const rows = $(table).find("tr").toArray();
    if (rows.length < 2) return;

    let headerIdx = -1;
    const col: Record<string, number> = {};

    for (let i = 0; i < Math.min(8, rows.length); i += 1) {
      const cells = $(rows[i])
        .find("th,td")
        .toArray()
        .map((c) => $(c).text().replace(/\s+/g, " ").trim());
      const joined = cells.join(" | ").toLowerCase();
      if (!joined.includes("din") || !joined.includes("name of the director")) {
        continue;
      }
      headerIdx = i;
      cells.forEach((cell, j) => {
        const key = cell.toLowerCase().replace(/\s+/g, " ");
        if (key.startsWith("name of the director")) col.name = j;
        else if (key === "din" || key.startsWith("din")) col.din = j;
        else if (key.includes("category 1")) col.cat1 = j;
        else if (key.includes("category 2")) col.cat2 = j;
        else if (key.includes("category 3")) col.cat3 = j;
        else if (key.startsWith("title")) col.title = j;
        else if (key.includes("current status")) col.status = j;
      });
      break;
    }

    if (headerIdx < 0 || col.name == null || col.din == null) return;

    const maxCol = Math.max(...Object.values(col));
    for (const tr of rows.slice(headerIdx + 1)) {
      const cells = $(tr)
        .find("th,td")
        .toArray()
        .map((c) => $(c).text().replace(/\s+/g, " ").trim());
      if (cells.length <= maxCol) continue;
      const din = normDin(cells[col.din!]);
      const name = safeStr(cells[col.name!]);
      if (!din || DUMMY_DINS.has(din) || !name) continue;
      if (seenDin.has(din)) continue;
      const status = col.status != null ? cells[col.status] ?? "" : "";
      if (!activeStatus(status)) continue;
      const cat1 = col.cat1 != null ? cells[col.cat1] ?? "" : "";
      const cat2 = col.cat2 != null ? cells[col.cat2] ?? "" : "";
      const cat3 = col.cat3 != null ? cells[col.cat3] ?? "" : "";
      const designation = designationFromParts(cat1, cat2, cat3);
      seats.push({
        din,
        name,
        designation,
        category: inferCategory(`${cat1} ${cat2} ${cat3}`),
        source: "nse_integrated_governance",
        as_of: safeStr(asOf),
      });
      seenDin.add(din);
    }
  });

  return seats;
}

function parseCompositionBod(
  rows: unknown[],
  asOf?: string | null,
  source = "nse_corporate_governance",
): BoardSeat[] {
  const seats: BoardSeat[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const din = normDin(r.din);
    const name = safeStr(r.directorName ?? r.name);
    if (!din || DUMMY_DINS.has(din) || !name) continue;
    if (seen.has(din)) continue;
    if (!activeStatus(r.status ?? r.currentStatus)) continue;
    const categoryRaw = safeStr(r.category);
    seats.push({
      din,
      name,
      designation: categoryRaw || "Director",
      category: inferCategory(categoryRaw),
      source,
      as_of: safeStr(asOf),
    });
    seen.add(din);
  }
  return seats;
}

async function fetchIntegrated(
  ticker: string,
  jar: CookieJar,
  indexes: string[],
): Promise<BoardPayload | null> {
  for (const index of indexes) {
    const resp = await nseFetch(INTEGRATED_URL, jar, {
      params: {
        index,
        symbol: ticker,
        integratedType: "Governance",
      },
      referer: NSE_GOV_REF,
    });
    if (!resp.ok) continue;
    const payload = (await resp.json()) as { data?: unknown };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const gov = rows.filter((r): r is Record<string, unknown> => {
      if (!r || typeof r !== "object") return false;
      const o = r as Record<string, unknown>;
      return (
        safeStr(o.type).includes("Governance") &&
        safeStr(o.ixbrl).startsWith("http")
      );
    });
    if (!gov.length) continue;

    gov.sort((a, b) =>
      (quarterEndIso(b.qe_Date) || "").localeCompare(
        quarterEndIso(a.qe_Date) || "",
      ),
    );

    const market = marketForIndex(index);
    for (const filing of gov) {
      const ixbrlUrl = safeStr(filing.ixbrl);
      const asOf = quarterEndIso(filing.qe_Date);
      const page = await nseFetch(ixbrlUrl, jar, { referer: NSE_HOME });
      if (!page.ok) continue;
      const html = await page.text();
      const seats = parseGovernanceIxbrlHtml(html, asOf);
      if (!seats.length) continue;
      return {
        ticker,
        name:
          safeStr(filing.cmName || filing.smName) || ticker,
        seats,
        market,
        as_of: asOf,
        source: "nse_integrated_governance",
      };
    }
  }
  return null;
}

async function fetchCgMaster(
  ticker: string,
  jar: CookieJar,
  indexes: string[],
): Promise<BoardPayload | null> {
  for (const index of indexes) {
    const resp = await nseFetch(CG_MASTER_URL, jar, {
      params: { index, symbol: ticker },
      referer: NSE_GOV_REF,
    });
    if (!resp.ok) continue;
    const payload = (await resp.json()) as { data?: unknown };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const dated = rows.filter((r): r is Record<string, unknown> => {
      if (!r || typeof r !== "object") return false;
      return Boolean(safeStr((r as Record<string, unknown>).recordId));
    });
    if (!dated.length) continue;

    dated.sort((a, b) =>
      (quarterEndIso(b.date) || "").localeCompare(quarterEndIso(a.date) || ""),
    );

    const market = marketForIndex(index);
    for (const latest of dated) {
      const recId = safeStr(latest.recordId);
      const asOf = quarterEndIso(latest.date);
      const detail = await nseFetch(CG_DETAIL_URL, jar, {
        params: { recId },
        referer: NSE_GOV_REF,
      });
      if (!detail.ok) continue;
      const body = (await detail.json()) as { cobod?: unknown };
      const cobod = Array.isArray(body.cobod) ? body.cobod : [];
      let composition: unknown[] = [];
      if (cobod[0] && typeof cobod[0] === "object") {
        const data = (cobod[0] as { data?: { CompositionBOD?: unknown } }).data;
        const raw = data?.CompositionBOD;
        if (Array.isArray(raw)) composition = raw;
      }
      const seats = parseCompositionBod(composition, asOf);
      if (!seats.length) continue;
      return {
        ticker,
        name: safeStr(latest.name) || ticker,
        seats,
        market,
        as_of: asOf,
        source: "nse_corporate_governance",
      };
    }
  }
  return null;
}

/** DIN-backed board for one ticker from NSE (Integrated Filing, then CG). */
export async function fetchBoardFromNse(
  ticker: string,
  market?: string | null,
  jar?: CookieJar,
): Promise<BoardPayload | null> {
  const tickerKey = safeStr(ticker).toUpperCase();
  if (!tickerKey) return null;
  const indexes = indexesForMarket(market);
  const sess = jar ?? (await warmNseSession());

  try {
    const integrated = await fetchIntegrated(tickerKey, sess, indexes);
    if (integrated?.seats.length) {
      if (safeStr(market).toUpperCase() === "NSE SME") {
        return { ...integrated, market: "NSE SME" };
      }
      return integrated;
    }
  } catch {
    /* try CG fallback */
  }

  try {
    const cg = await fetchCgMaster(tickerKey, sess, indexes);
    if (cg?.seats.length) {
      if (safeStr(market).toUpperCase() === "NSE SME") {
        return { ...cg, market: "NSE SME" };
      }
      return cg;
    }
  } catch {
    return null;
  }
  return null;
}

export async function createNseSession(): Promise<CookieJar> {
  return warmNseSession();
}
