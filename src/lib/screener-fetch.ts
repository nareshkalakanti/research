/**
 * Throttled Screener.in company-page fetch — never hit global search (blocks fast).
 * One block pauses every Screener fetch (persisted, exponential backoff) so a
 * batch does not keep knocking while blocked.
 */
import {
  cacheBseScripCode,
  getCachedBseScripCode,
} from "./bse-investor-discover";
import { trustedBseCode } from "./bse-codes";
import { screenerCompanyPageUrl } from "./links";
import { withWebsiteFetch } from "./scrape-pool";
import { openSqliteNamed } from "./sqlite-utils";
import { growwCompanyData } from "./web-mcap";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Min gap between any two Screener requests (search gets you blocked; company pages are OK if spaced). */
const SCREENER_GAP_MS = 2_500;
/** Extra random wait on top of the gap so requests are not evenly spaced. */
const SCREENER_JITTER_MS = 2_500;

const BACKOFF_HOST = "screener.in";
const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

let lastScreenerAt = 0;

/**
 * Interactive work (Portfolio review warm) holds this so background Value /
 * baskets fills do not stack pages on the same IP and trip a global pause.
 */
let interactiveUntil = 0;

/** Call while scoring / warming a stock the user just added. */
export function markScreenerInteractive(ms = 90_000): void {
  interactiveUntil = Math.max(interactiveUntil, Date.now() + ms);
}

/** Background bulk fills should stop when interactive work is in flight. */
export function screenerBulkDeferred(): boolean {
  return Date.now() < interactiveUntil;
}

/** Clear a persisted pause after a polite-path fix (resets strikes too). */
export function clearScreenerPause(): void {
  const db = openBackoff();
  try {
    db.prepare(
      `UPDATE fetch_backoff SET strikes = 0, blocked_until = NULL, updated_at = ?
       WHERE host = ?`,
    ).run(new Date().toISOString(), BACKOFF_HOST);
  } finally {
    db.close();
  }
}

export class ScreenerPausedError extends Error {
  constructor(public until: string) {
    super(`Screener paused until ${until}`);
    this.name = "ScreenerPausedError";
  }
}

export function screenerBlocked(html: string, status: number): boolean {
  if (status === 403 || status === 429) return true;
  if (/captcha|access denied|rate limit|too many requests/i.test(html)) return true;
  return false;
}

function openBackoff() {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS fetch_backoff (
      host TEXT PRIMARY KEY,
      blocked_until TEXT,
      strikes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

/**
 * How long one stock stays marked "blocked" after Screener refuses it: only
 * until the global pause ends (15 min if none is recorded). It used to be 6 h,
 * which left Portfolio review scores empty long after Screener was back.
 */
export function stockBlockedUntil(): string {
  return screenerPausedUntil() ?? new Date(Date.now() + 15 * 60_000).toISOString();
}

/** ISO time Screener fetches resume, or null when not paused. */
export function screenerPausedUntil(): string | null {
  const db = openBackoff();
  try {
    const row = db
      .prepare(`SELECT blocked_until FROM fetch_backoff WHERE host = ?`)
      .get(BACKOFF_HOST) as { blocked_until: string | null } | undefined;
    const until = row?.blocked_until ?? null;
    return until && Date.parse(until) > Date.now() ? until : null;
  } finally {
    db.close();
  }
}

/** Pause length after the given consecutive block count (1 = first block). */
export function screenerBackoffMs(strikes: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (Math.max(1, strikes) - 1), BACKOFF_MAX_MS);
}

export function recordScreenerBlock(): string {
  const db = openBackoff();
  try {
    const row = db
      .prepare(`SELECT strikes FROM fetch_backoff WHERE host = ?`)
      .get(BACKOFF_HOST) as { strikes: number } | undefined;
    const strikes = (row?.strikes ?? 0) + 1;
    const until = new Date(Date.now() + screenerBackoffMs(strikes)).toISOString();
    db.prepare(
      `INSERT INTO fetch_backoff (host, blocked_until, strikes, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET
         blocked_until = excluded.blocked_until,
         strikes = excluded.strikes,
         updated_at = excluded.updated_at`,
    ).run(BACKOFF_HOST, until, strikes, new Date().toISOString());
    return until;
  } finally {
    db.close();
  }
}

function recordScreenerOk(): void {
  const db = openBackoff();
  try {
    db.prepare(
      `UPDATE fetch_backoff SET strikes = 0, blocked_until = NULL, updated_at = ?
       WHERE host = ? AND strikes > 0`,
    ).run(new Date().toISOString(), BACKOFF_HOST);
  } finally {
    db.close();
  }
}

async function waitScreenerGap(): Promise<void> {
  const gap = SCREENER_GAP_MS + Math.random() * SCREENER_JITTER_MS;
  const wait = gap - (Date.now() - lastScreenerAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastScreenerAt = Date.now();
}

let bseOnlyCache: { at: number; set: Set<string> } | null = null;

/** BSE-only tickers (main board and SME) — Screener files them under the BSE scrip code. */
function bseOnlyTickers(): Set<string> {
  if (bseOnlyCache && Date.now() - bseOnlyCache.at < 5 * 60_000) return bseOnlyCache.set;
  let set = new Set<string>();
  try {
    const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
    try {
      set = new Set(
        (db.prepare(`SELECT UPPER(ticker) AS t FROM company_about WHERE UPPER(TRIM(market)) IN ('BSE', 'BSE SME')`).all() as Array<{
          t: string;
        }>).map((r) => r.t),
      );
    } finally {
      db.close();
    }
  } catch {
    /* fall back to ticker-first */
  }
  bseOnlyCache = { at: Date.now(), set };
  return set;
}

async function resolveScreenerPageKeys(ticker: string): Promise<string[]> {
  const key = ticker.trim().toUpperCase();
  if (!key) return [];
  // BSE-only names: the scrip-code page is the real one — try it first and
  // skip the extra lookup, so each stock costs one Screener request, not two.
  const cachedCode = expectedBseScrip(key);
  if (cachedCode && /^\d{5,7}$/.test(cachedCode) && bseOnlyTickers().has(key)) return [cachedCode, key];
  const keys = [key];
  const trusted = trustedBseScrip(key);
  const pushBse = (raw: string | null | undefined) => {
    const bse = String(raw || "").trim();
    if (!/^\d{5,7}$/.test(bse) || keys.includes(bse)) return;
    // A name lookup can return a sister company's code: never let it replace the listed one.
    if (trusted && bse !== trusted) return;
    keys.push(bse);
    cacheBseScripCode(key, bse);
  };
  pushBse(cachedCode);
  try {
    const data = await growwCompanyData(key, key);
    const hit = (data?.hit || {}) as Record<string, unknown>;
    const header = (data?.company?.header || {}) as Record<string, unknown>;
    pushBse(String(hit.bse_scrip_code || ""));
    pushBse(String(header.bseScriptCode || ""));
  } catch {
    /* ticker-only keys */
  }
  return keys;
}

async function fetchScreenerHtmlAt(
  url: string,
): Promise<{ ok: true; html: string } | { ok: false; status: number }> {
  await waitScreenerGap();
  return withWebsiteFetch(url, async () => {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-IN,en;q=0.9",
      },
      signal: AbortSignal.timeout(45_000),
      redirect: "follow",
    });
    const html = await res.text();
    if (screenerBlocked(html, res.status)) {
      const until = recordScreenerBlock();
      throw new Error(
        `Screener blocked or unavailable (${res.status}); paused until ${until}`,
      );
    }
    if (!res.ok) return { ok: false as const, status: res.status };
    recordScreenerOk();
    return { ok: true as const, html };
  });
}

/**
 * Screener's peer-comparison table for one company (its own industry, with a
 * Median row). Uses the logged-in session (SCREENER_SESSIONID) so the account's
 * chosen columns — e.g. CMP / BV, CMP / Sales — come back. Same gap, pause and
 * block handling as company pages. Returns null without a login.
 */
export async function fetchScreenerPeersHtml(warehouseId: string): Promise<string | null> {
  const session = (process.env.SCREENER_SESSIONID || "").trim();
  if (!session) return null;
  const paused = screenerPausedUntil();
  if (paused) throw new ScreenerPausedError(paused);
  const url = `https://www.screener.in/api/company/${encodeURIComponent(warehouseId)}/peers/`;
  await waitScreenerGap();
  return withWebsiteFetch(url, async () => {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,*/*;q=0.8",
        "accept-language": "en-IN,en;q=0.9",
        cookie: `sessionid=${session}`,
      },
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error("Screener login expired — copy a fresh sessionid into .env.local");
    }
    const html = await res.text();
    if (screenerBlocked(html, res.status)) {
      const until = recordScreenerBlock();
      throw new Error(`Screener blocked or unavailable (${res.status}); paused until ${until}`);
    }
    if (!res.ok) throw new Error(`Screener peers failed (${res.status})`);
    recordScreenerOk();
    return html;
  });
}

/**
 * The stock's own BSE scrip code from authoritative lists (see bse-codes).
 * The scrip cache can hold a sister company's code from a name lookup
 * (WAAREE had Waaree Energies' 544277 instead of its own 539337).
 */
function trustedBseScrip(ticker: string): string | null {
  return trustedBseCode(ticker);
}

/** Expected scrip code: trusted listing first, else the cache. Repairs a wrong cache entry. */
function expectedBseScrip(ticker: string): string | null {
  const key = ticker.toUpperCase();
  const trusted = trustedBseScrip(key);
  const cached = getCachedBseScripCode(key);
  if (trusted && cached !== trusted) cacheBseScripCode(key, trusted);
  return trusted ?? cached;
}

/** BSE scrip codes a Screener company page links to (its own listing). */
function pageBseCodes(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/bseindia\.com\/stock-share-price\/[^"'\s]*?\/(\d{6})\/?["']/g)) out.add(m[1]!);
  return out;
}

/**
 * A ticker-slug page can belong to a different company (Screener's /WAAREE/ is
 * Waaree Energies, not BSE SME Waaree Technologies). When the stock's own BSE
 * code is known and the page lists other BSE codes only, it is the wrong page.
 */
function pageIsOtherCompany(html: string, expectedScrip: string | null): boolean {
  if (!expectedScrip || !/^\d{6}$/.test(expectedScrip)) return false;
  const codes = pageBseCodes(html);
  return codes.size > 0 && !codes.has(expectedScrip);
}

/** Fetch one company page — serialized gap + per-host pool from scrape-pool. */
export async function fetchScreenerCompanyHtml(
  ticker: string,
  opts?: { consolidated?: boolean },
): Promise<string> {
  const paused = screenerPausedUntil();
  if (paused) throw new ScreenerPausedError(paused);
  const keys = await resolveScreenerPageKeys(ticker);
  const expectedScrip = expectedBseScrip(ticker.trim().toUpperCase());
  let lastStatus = 0;
  for (const key of keys) {
    const url = screenerCompanyPageUrl(key, {
      consolidated: opts?.consolidated,
    });
    if (url.endsWith("screener.in/")) continue;
    const hit = await fetchScreenerHtmlAt(url);
    if (hit.ok) {
      // Wrong company behind the ticker slug: try the next key (scrip-code page).
      if (key !== expectedScrip && pageIsOtherCompany(hit.html, expectedScrip)) {
        lastStatus = 404;
        continue;
      }
      return hit.html;
    }
    lastStatus = hit.status;
    if (hit.status !== 404) {
      throw new Error(`Screener fetch failed (${hit.status}) for ${ticker}`);
    }
  }
  throw new Error(
    `Screener fetch failed (${lastStatus || 404}) for ${ticker}`,
  );
}
