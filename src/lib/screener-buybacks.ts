/**
 * Buyback announcements from Screener.in company pages (not global search).
 * NSE discovers tickers; Screener enriches max ₹ / tender text when NSE filing is thin.
 */
import * as cheerio from "cheerio";
import { openSqliteNamed } from "./sqlite-utils";
import { fetchScreenerCompanyHtml } from "./screener-fetch";
import type { BuybackEvent } from "./strategy/types";
import {
  classifyBuybackMethod,
  classifyBuybackStatus,
  isBuybackSubject,
  parseMaxPrice,
  parsePctEquity,
  parseShareCount,
} from "./strategy/buyback-parse";

const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS screener_buyback_cache (
    ticker TEXT PRIMARY KEY,
    events_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    blocked_until TEXT
  );
`;

function ensureCacheSchema(): void {
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.exec(CACHE_SCHEMA);
  } finally {
    db.close();
  }
}

type CacheRow = {
  events_json: string;
  fetched_at: string;
  blocked_until: string | null;
};

function readCache(ticker: string): BuybackEvent[] | "blocked" | null {
  ensureCacheSchema();
  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const row = db
      .prepare(
        `SELECT events_json, fetched_at, blocked_until FROM screener_buyback_cache WHERE ticker = ?`,
      )
      .get(ticker.toUpperCase()) as CacheRow | undefined;
    if (!row) return null;
    if (row.blocked_until && Date.parse(row.blocked_until) > Date.now()) {
      return "blocked";
    }
    if (Date.now() - Date.parse(row.fetched_at) < CACHE_MS) {
      return JSON.parse(row.events_json) as BuybackEvent[];
    }
    return null;
  } finally {
    db.close();
  }
}

function writeCache(
  ticker: string,
  events: BuybackEvent[],
  blockedUntil?: string | null,
): void {
  ensureCacheSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO screener_buyback_cache (ticker, events_json, fetched_at, blocked_until)
       VALUES (@ticker, @events_json, @fetched_at, @blocked_until)
       ON CONFLICT(ticker) DO UPDATE SET
         events_json = excluded.events_json,
         fetched_at = excluded.fetched_at,
         blocked_until = excluded.blocked_until`,
    ).run({
      ticker: ticker.toUpperCase(),
      events_json: JSON.stringify(events),
      fetched_at: new Date().toISOString(),
      blocked_until: blockedUntil ?? null,
    });
  } finally {
    db.close();
  }
}

function parseScreenerDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const iso = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10);
  return null;
}

function eventId(ticker: string, announcedAt: string | null, subject: string): string {
  const key = `${announcedAt ?? "na"}|${subject.slice(0, 48)}`;
  return `${ticker.toUpperCase()}|screener|${key}`;
}

export function parseScreenerBuybackHtml(
  html: string,
  ticker: string,
): BuybackEvent[] {
  const $ = cheerio.load(html);
  const key = ticker.toUpperCase();
  const out: BuybackEvent[] = [];
  const seen = new Set<string>();

  $(
    "#company-announcements-tab ul.list-links > li, .documents.flex-column ul.list-links > li",
  ).each((_i, li) => {
    const $li = $(li);
    const $a = $li.find("a[href]").first();
    const href = ($a.attr("href") || "").trim();
    const heading = $a
      .clone()
      .children()
      .remove()
      .end()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const detail = $li.find(".ink-600").text().replace(/\s+/g, " ").trim();
    const blob = `${heading} ${detail}`;
    if (!isBuybackSubject(blob)) return;

    const announcedAt =
      parseScreenerDate($li.find("time").attr("datetime")) ||
      parseScreenerDate(detail.match(/\b(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\b/)?.[1]);
    const status = classifyBuybackStatus(heading, blob);
    const id = eventId(key, announcedAt, heading);
    if (seen.has(id)) return;
    seen.add(id);

    out.push({
      id,
      ticker: key,
      announced_at: announcedAt,
      ex_date: null,
      max_price: parseMaxPrice(blob),
      pct_equity: parsePctEquity(blob),
      size_shares: parseShareCount(blob),
      status,
      subject: heading || null,
      description: detail || null,
      source: "screener_announcement",
      seq_id: href || null,
    });
  });

  out.sort((a, b) => {
    const da = a.announced_at ?? "";
    const db = b.announced_at ?? "";
    return db.localeCompare(da);
  });
  return out;
}

/** True when NSE rows exist but lack max ₹ needed for spread / tender checks. */
export function buybackEventsNeedScreener(events: BuybackEvent[]): boolean {
  if (!events.length) return true;
  const hasBuyback = events.some((e) => isBuybackSubject(`${e.subject} ${e.description}`));
  if (!hasBuyback) return true;
  const hasMax = events.some((e) => e.max_price != null && e.max_price > 0);
  if (!hasMax) return true;
  const method = classifyBuybackMethod(
    events[0]?.subject ?? null,
    events[0]?.description ?? null,
  );
  if (method === "unknown") return true;
  return false;
}

/**
 * Fetch buyback announcements from Screener company page (cached 24h).
 * Returns [] on block — caller should not retry until cache TTL.
 */
export async function fetchScreenerBuybacks(
  ticker: string,
  opts?: { force?: boolean },
): Promise<BuybackEvent[]> {
  const key = ticker.trim().toUpperCase();
  if (!key) return [];

  if (!opts?.force) {
    const cached = readCache(key);
    if (cached === "blocked") return [];
    if (cached) return cached;
  }

  try {
    const html = await fetchScreenerCompanyHtml(key);
    const events = parseScreenerBuybackHtml(html, key);
    writeCache(key, events);
    return events;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/blocked|429|403|captcha/i.test(msg)) {
      const until = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
      writeCache(key, [], until);
    }
    return [];
  }
}
