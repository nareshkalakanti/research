/**
 * Throttled Screener.in company-page fetch — never hit global search (blocks fast).
 * One block pauses every Screener fetch (persisted, exponential backoff) so a
 * batch does not keep knocking while blocked.
 */
import { screenerConsolidatedUrl, screenerUrl } from "./links";
import { withWebsiteFetch } from "./scrape-pool";
import { openSqliteNamed } from "./sqlite-utils";

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

function recordScreenerBlock(): string {
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

/** Fetch one company page — serialized gap + per-host pool from scrape-pool. */
export async function fetchScreenerCompanyHtml(
  ticker: string,
  opts?: { consolidated?: boolean },
): Promise<string> {
  const paused = screenerPausedUntil();
  if (paused) throw new ScreenerPausedError(paused);
  const url = opts?.consolidated
    ? screenerConsolidatedUrl(ticker)
    : screenerUrl(ticker);
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
      throw new Error(`Screener blocked or unavailable (${res.status}); paused until ${until}`);
    }
    if (!res.ok) {
      throw new Error(`Screener fetch failed (${res.status}) for ${ticker}`);
    }
    recordScreenerOk();
    return html;
  });
}
