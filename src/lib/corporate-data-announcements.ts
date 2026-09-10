/**
 * Find board / director / CG announcement PDFs for Corporate Data.
 * NSE caps long date ranges — fetch in ~90-day windows or director filings disappear.
 */
import { createNseBuybackSession, type NseCookieJar } from "./nse-buybacks";
import { nseHttp1Fetch } from "./nse-http";
import { withWebsiteFetch } from "./scrape-pool";

const CORP_ANN_URL = "https://www.nseindia.com/api/corporate-announcements";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

/** Reuse one NSE cookie jar across seed scans (session warm is ~1–3s each). */
let cachedJar: { jar: NseCookieJar; at: number } | null = null;
const JAR_TTL_MS = 90_000;
const WINDOW_DAYS = 90;
const LOOKBACK_YEARS = 3;

export class NseAnnouncementsBlockedError extends Error {
  constructor(message = "NSE announcements blocked (Akamai) — use stored PDF / Trendlyne") {
    super(message);
    this.name = "NseAnnouncementsBlockedError";
  }
}

/** True for 403, Akamai HTML, HTTP/2 stream errors, fetch failures — never 500 these. */
export function isNseTransportFailure(err: unknown): boolean {
  if (err instanceof NseAnnouncementsBlockedError) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const cause =
    err instanceof Error && err.cause instanceof Error
      ? err.cause.message
      : err instanceof Error && err.cause
        ? String(err.cause)
        : "";
  const blob = `${msg} ${cause}`;
  return /fetch failed|NGHTTP2|ERR_HTTP2|ECONNRESET|ETIMEDOUT|UND_ERR|Access Denied|akamai|403/i.test(
    blob,
  );
}

/** Soft circuit: after Akamai/403, pause NSE briefly (not minutes of skip). */
let nseSkipUntil = 0;

export function markNseBlocked(): void {
  clearSharedJar();
  // Short backoff — long windows made whole Holdings batches look offline.
  const until = Date.now() + 45_000;
  if (until > nseSkipUntil) nseSkipUntil = until;
}

export function clearNseCircuit(): void {
  nseSkipUntil = 0;
  clearSharedJar();
}

export function isNseCircuitOpen(): boolean {
  return Date.now() < nseSkipUntil;
}

export function nseCircuitRemainingMs(): number {
  return Math.max(0, nseSkipUntil - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clearSharedJar(): void {
  cachedJar = null;
}

async function getSharedJar(reuse?: NseCookieJar): Promise<NseCookieJar> {
  if (reuse?.cookie) return reuse;
  const now = Date.now();
  if (cachedJar && now - cachedJar.at < JAR_TTL_MS) return cachedJar.jar;
  const jar = await createNseBuybackSession();
  cachedJar = { jar, at: now };
  return jar;
}

type NseAnnRow = Record<string, unknown>;
type Jar = { cookie: string };

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function dd(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}

/** Auditor / non-board filings — also match Stat_auditor in PDF filenames. */
function isAuditorish(blob: string): boolean {
  return /stat(?:utory)?[\s_-]*auditor|secretarial[\s_-]*auditor|cost[\s_-]*auditor|internal[\s_-]*auditor|auditor[\s_-]*appointment/i.test(
    blob,
  );
}

function isBoardish(row: NseAnnRow): boolean {
  const blob =
    `${safeStr(row.desc)} ${safeStr(row.attchmntText)} ${safeStr(row.attchmntFile)}`.toLowerCase();
  if (isAuditorish(blob)) return false;
  // CG quarterly compliance packs rarely carry DIN lines — skip for extract tests
  if (
    /quarterly\s+compliance\s+report|compliance\s+report\s+on\s+corporate\s+governance/i.test(
      blob,
    )
  ) {
    return false;
  }
  if (
    /newspaper publication|postal ballot|dividend|record date|credit rating|buy\s*back/i.test(
      blob,
    ) &&
    !/director|board|kmp|managing|ceo|din|clarification|corporate governance/i.test(
      blob,
    )
  ) {
    return false;
  }
  return /director|appointment|resignation|cessation|change in.*(?:director|management|kmp)|board of directors|corporate governance|clarification|outcome of board|key managerial|managing director|chief executive/i.test(
    blob,
  );
}

async function fetchAnn(
  symbol: string,
  index: "sme" | "equities",
  from: Date,
  to: Date,
  jar: Jar,
): Promise<NseAnnRow[]> {
  const u = new URL(CORP_ANN_URL);
  u.searchParams.set("index", index);
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("from_date", dd(from));
  u.searchParams.set("to_date", dd(to));
  let res: Response;
  try {
    res = await withWebsiteFetch(u.toString(), () =>
      nseHttp1Fetch(u.toString(), {
        jar,
        headers: {
          Accept: "application/json",
          Referer: NSE_ANN_REF,
        },
        signal: AbortSignal.timeout(45_000),
      }),
    );
  } catch (err) {
    if (isNseTransportFailure(err)) {
      markNseBlocked();
      throw new NseAnnouncementsBlockedError(
        "NSE temporarily unavailable — using stored PDF / Trendlyne",
      );
    }
    throw err;
  }
  if (res.status === 403) {
    markNseBlocked();
    throw new NseAnnouncementsBlockedError();
  }
  if (!res.ok) return [];
  const text = await res.text();
  if (/access denied|akamaighost/i.test(text)) {
    markNseBlocked();
    throw new NseAnnouncementsBlockedError();
  }
  let rows: unknown;
  try {
    rows = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  // Successful JSON — clear soft circuit from earlier HTTP/2 failures
  clearNseCircuit();
  return Array.isArray(rows) ? (rows as NseAnnRow[]) : [];
}

/** Windows over lookback — order does not matter; we score quality, not recency. */
function dateWindows(years: number, windowDays: number): Array<{ from: Date; to: Date }> {
  const windows: Array<{ from: Date; to: Date }> = [];
  const end = new Date();
  const oldest = new Date(end);
  oldest.setFullYear(oldest.getFullYear() - years);
  let to = new Date(end);
  while (to > oldest) {
    const from = new Date(to);
    from.setDate(from.getDate() - windowDays);
    if (from < oldest) {
      windows.push({ from: new Date(oldest), to: new Date(to) });
      break;
    }
    windows.push({ from: new Date(from), to: new Date(to) });
    to = new Date(from);
    to.setDate(to.getDate() - 1);
  }
  return windows;
}

export type CorporateDocHit = {
  url: string;
  title: string;
  date: string | null;
};

function hitScore(h: CorporateDocHit): number {
  const u = h.url.toLowerCase();
  const t = h.title.toLowerCase();
  const blob = `${t} ${u}`;
  let s = 50;
  if (u.endsWith(".pdf")) s -= 20;
  if (u.endsWith(".zip")) s += 15;
  if (/director|din|board/.test(blob)) s -= 14;
  if (/appointment|re-?appointment|change in director/.test(t)) s -= 10;
  if (/appointment_of_director|change_in_director|intimation.*director/i.test(u))
    s -= 12;
  if (/corporate governance|board report/.test(t)) s -= 8;
  if (/resignation|cessation|kmp/.test(t)) s -= 2;
  if (
    /outcome of board meeting/i.test(t) &&
    !/director|appointment|resignation|kmp/i.test(blob)
  ) {
    s += 18;
  }
  if (
    /cfo|chief financial|company secretary|\bcs\b/.test(blob) &&
    !/director/.test(blob)
  ) {
    s += 12;
  }
  if (/share[s]?[_\s-]*aquisition|shareholding|takeover/i.test(blob)) s += 20;
  if (/clarification|financial result|auditor|compliance report/.test(blob))
    s += 8;
  return s;
}

function toHit(row: NseAnnRow): CorporateDocHit | null {
  if (!isBoardish(row)) return null;
  const url = safeStr(row.attchmntFile);
  if (!url.startsWith("http") || url.endsWith("/-")) return null;
  const rawDate = safeStr(row.an_dt) || safeStr(row.date) || null;
  const date =
    normalizeAnnouncementDate(rawDate) || dateFromNseArchiveUrl(url) || rawDate;
  return {
    url,
    title: safeStr(row.desc) || safeStr(row.attchmntText) || "Announcement",
    date,
  };
}

function dateSortKey(raw: string | null | undefined): number {
  const s = (raw || "").trim();
  if (!s) return 0;
  const norm = normalizeAnnouncementDate(s);
  if (norm) {
    const t = Date.parse(`${norm}T12:00:00Z`);
    return Number.isNaN(t) ? 0 : t;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function pickBestHit(hits: CorporateDocHit[]): CorporateDocHit | null {
  if (!hits.length) return null;
  // Prefer quality; among close scores, prefer newer NSE filing date.
  return [...hits].sort((a, b) => {
    const scoreDiff = hitScore(a) - hitScore(b);
    if (Math.abs(scoreDiff) > 8) return scoreDiff;
    const dateDiff = dateSortKey(b.date) - dateSortKey(a.date);
    if (dateDiff) return dateDiff;
    return scoreDiff;
  })[0] ?? null;
}

/**
 * List board-ish announcement attachments (chunked NSE fetch).
 * Useful for debugging “missing announcements”.
 */
export async function listCorporateBoardDocuments(
  ticker: string,
  market: string,
  opts?: { jar?: NseCookieJar; limit?: number },
): Promise<CorporateDocHit[]> {
  const hits = await collectBoardHits(ticker, market, opts?.jar);
  hits.sort((a, b) => hitScore(a) - hitScore(b));
  return hits.slice(0, opts?.limit ?? 25);
}

async function collectBoardHits(
  ticker: string,
  market: string,
  reuseJar?: NseCookieJar,
): Promise<CorporateDocHit[]> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return [];
  if (isNseCircuitOpen()) {
    throw new NseAnnouncementsBlockedError(
      "NSE circuit open (Akamai) — skipped for a few minutes",
    );
  }
  let jar: NseCookieJar;
  try {
    jar = await getSharedJar(reuseJar);
  } catch (err) {
    if (isNseTransportFailure(err)) {
      markNseBlocked();
      throw new NseAnnouncementsBlockedError(
        "NSE session warm failed (Akamai/HTTP2)",
      );
    }
    throw err;
  }
  const primary: "sme" | "equities" = /SME/i.test(market) ? "sme" : "equities";
  const indexes: Array<"sme" | "equities"> = [
    primary,
    primary === "sme" ? "equities" : "sme",
  ];

  const hits: CorporateDocHit[] = [];
  const seen = new Set<string>();
  const ENOUGH_HITS = 6;

  for (const index of indexes) {
    // Newest windows first; stop early once we have enough board-ish PDFs
    // (avoids ~24 NSE calls/ticker that trip Akamai throttling).
    for (const { from, to } of dateWindows(LOOKBACK_YEARS, WINDOW_DAYS)) {
      if (isNseCircuitOpen()) break;
      const rows = await fetchAnn(symbol, index, from, to, jar);
      for (const row of rows) {
        const hit = toHit(row);
        if (!hit || seen.has(hit.url)) continue;
        seen.add(hit.url);
        hits.push(hit);
      }
      if (hits.length >= ENOUGH_HITS) break;
      await sleep(180);
    }
    if (hits.length) break;
    await sleep(220);
  }

  return hits;
}

function toAnyPdfHit(row: NseAnnRow): CorporateDocHit | null {
  const url = safeStr(row.attchmntFile);
  if (!url.startsWith("http") || url.endsWith("/-")) return null;
  // NSE often packs resignation / KMP filings as .zip containing a PDF
  if (!/\.(pdf|zip)($|\?)/i.test(url)) return null;
  const rawDate = safeStr(row.an_dt) || safeStr(row.date) || null;
  const date =
    normalizeAnnouncementDate(rawDate) || dateFromNseArchiveUrl(url) || rawDate;
  return {
    url,
    title: safeStr(row.desc) || safeStr(row.attchmntText) || "Announcement",
    date,
  };
}

/**
 * Prefer material corp filings for research auto-pick.
 * People-change (resignation / management) and General Updates rank above allotment noise.
 */
export function announcementResearchScore(hit: CorporateDocHit): number {
  const t = hit.title.toLowerCase();
  let s = 0;
  // Board / KMP people moves — often titled "Change in Management" on NSE
  if (
    /resign|cessation|change\s+in\s+management|change\s+in\s+(?:key\s+)?(?:managerial\s+)?personnel|\bkmp\b|\bsmp\b|board\s+resignation|appointment\s+of\s+(?:director|independent)|retirement\s+of|resignation\s+of\s+director/i.test(
      t,
    )
  ) {
    s += 110;
  }
  if (/general\s+updates?/i.test(t)) s += 100;
  if (
    /capital\s+raise|preferential|qip|rights\s+issue|fund\s+rais|warrant|buy\s*back|dividend|acquisition|order\s+win|credit\s+rating|demerger|merger|debt\s+repay|loan\s+repay|repayment\s+of\s+debt/i.test(
      t,
    )
  ) {
    s += 80;
  }
  // Allotment / issue of securities — material but often routine follow-ups
  if (/allotment\s+of\s+securities|issue\s+of\s+securities/i.test(t)) s += 35;
  if (
    /board\s+meeting|outcome\s+of\s+board|appointment|resignation|retirement|director/i.test(
      t,
    )
  ) {
    s += 40;
  }
  if (/press\s+release|intimation|regulation\s*30|reg\.?\s*30/i.test(t)) s += 25;
  if (
    /analysts?\/institutional|investor\s+meet|con\.?\s*call|conference\s+call|earnings\s+call|transcript|investor\s+presentation|monitoring\s+agency|statement\s+of\s+deviation/i.test(
      t,
    )
  ) {
    s -= 80;
  }
  if (/newspaper|corrigendum|clarification\s+only|compliance\s+report/i.test(t)) {
    s -= 30;
  }
  const days =
    dateSortKey(hit.date) > 0
      ? (Date.now() - dateSortKey(hit.date)) / 86_400_000
      : 365;
  s += Math.max(0, 20 - days * 0.5);
  return s;
}

/**
 * Recent NSE announcement PDFs for a ticker.
 * Sorted for research: General Updates / material events first, then date.
 */
export async function listRecentCorporateAnnouncementPdfs(
  ticker: string,
  market = "NSE",
  opts?: { jar?: NseCookieJar; limit?: number; lookbackYears?: number },
): Promise<CorporateDocHit[]> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return [];
  if (isNseCircuitOpen()) {
    throw new NseAnnouncementsBlockedError(
      "NSE circuit open (Akamai) — skipped for a few minutes",
    );
  }
  let jar: NseCookieJar;
  try {
    jar = await getSharedJar(opts?.jar);
  } catch (err) {
    if (isNseTransportFailure(err)) {
      markNseBlocked();
      throw new NseAnnouncementsBlockedError(
        "NSE session warm failed (Akamai/HTTP2)",
      );
    }
    throw err;
  }

  const primary: "sme" | "equities" = /SME/i.test(market) ? "sme" : "equities";
  const indexes: Array<"sme" | "equities"> = [
    primary,
    primary === "sme" ? "equities" : "sme",
  ];
  const limit = opts?.limit ?? 15;
  const years = opts?.lookbackYears ?? 1;
  const hits: CorporateDocHit[] = [];
  const seen = new Set<string>();

  for (const index of indexes) {
    for (const { from, to } of dateWindows(years, WINDOW_DAYS)) {
      if (isNseCircuitOpen()) break;
      const rows = await fetchAnn(symbol, index, from, to, jar);
      for (const row of rows) {
        const hit = toAnyPdfHit(row);
        if (!hit || seen.has(hit.url)) continue;
        seen.add(hit.url);
        hits.push(hit);
      }
      await sleep(160);
    }
    if (hits.length) break;
    await sleep(200);
  }

  hits.sort((a, b) => {
    const scoreDiff = announcementResearchScore(b) - announcementResearchScore(a);
    if (scoreDiff) return scoreDiff;
    return dateSortKey(b.date) - dateSortKey(a.date);
  });
  return hits.slice(0, limit);
}

export async function findCorporateBoardDocument(
  ticker: string,
  market: string,
  opts?: { jar?: NseCookieJar },
): Promise<CorporateDocHit | null> {
  const hits = await collectBoardHits(ticker, market, opts?.jar);
  // Best valid director/board doc by quality — not “latest”
  return pickBestHit(hits);
}

/** NSE archive PDFs often encode filing time: SYMBOL_DDMMYYYYHHMMSS_….pdf */
export function dateFromNseArchiveUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/_(\d{2})(\d{2})(\d{4})\d{6}_/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Normalize NSE an_dt / loose dates to YYYY-MM-DD when possible. */
export function normalizeAnnouncementDate(
  raw: string | null | undefined,
): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mon: Record<string, string> = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  };
  const m = s.match(
    /^(\d{1,2})[-/\s]([A-Za-z]{3})[-/\s,](\d{4})(?:\s+\d{1,2}:\d{2})?/,
  );
  if (m) {
    const mm = mon[m[2]!];
    if (!mm) return s;
    return `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}`;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}
