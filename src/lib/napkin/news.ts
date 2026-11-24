import { trustedBseCode } from "@/lib/bse-codes";
import { IndianApiRateLimitError, indianApiConfigured, indianGet } from "@/lib/indianapi-fundamentals";
import { openSqliteNamed } from "@/lib/sqlite-utils";
import { namesMatch } from "@/lib/web-mcap";

/**
 * Recent news for one stock from IndianAPI (/stock → recentNews), fetched only
 * when Napkin opens the stock. Saved for 12 h per ticker so credits last; a
 * rate-limit reply waits 30 min before trying again.
 *
 * IndianAPI searches by name, which can return a sister company (Waaree
 * Energies for Waaree Technologies). The reply is kept only when its NSE
 * symbol, BSE code or name matches the stock.
 */

export type NewsItem = {
  title: string;
  url: string | null;
  date: string | null;
  summary: string | null;
  source: string | null;
};

export type NewsResult = {
  status: "ok" | "empty" | "mismatch" | "limited" | "unavailable";
  items: NewsItem[];
  /** Company IndianAPI answered for (shown when it isn't ours). */
  matched_name: string | null;
  fetched_at: string;
};

const FRESH_MS = 12 * 3_600_000;
const LIMIT_RETRY_MS = 30 * 60_000;
const MAX_ITEMS = 12;

function withDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS indianapi_news_cache (
      ticker TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )`);
    return fn(db);
  } finally {
    db.close();
  }
}

function readCache(ticker: string): NewsResult | null {
  try {
    return withDb((db) => {
      const r = db.prepare(`SELECT json FROM indianapi_news_cache WHERE ticker = ?`).get(ticker) as
        | { json: string }
        | undefined;
      return r ? (JSON.parse(r.json) as NewsResult) : null;
    });
  } catch {
    return null;
  }
}

function writeCache(ticker: string, res: NewsResult): void {
  try {
    withDb((db) =>
      db
        .prepare(
          `INSERT INTO indianapi_news_cache (ticker, json, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT(ticker) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
        )
        .run(ticker, JSON.stringify(res), res.fetched_at),
    );
  } catch {
    /* still returned to the caller */
  }
}

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** Field names differ across IndianAPI payloads: take the first that is present. */
function pick(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return null;
}

function toIsoDate(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : raw;
}

export function parseNews(body: unknown): NewsItem[] {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const raw = (Array.isArray(b.recentNews) ? b.recentNews : Array.isArray(b.news) ? b.news : []) as unknown[];
  const out: NewsItem[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const title = pick(o, ["headline", "title", "heading"]);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const url = pick(o, ["url", "link", "newsUrl", "articleUrl"]);
    out.push({
      title,
      url: url && /^https?:\/\//i.test(url) ? url : null,
      date: toIsoDate(pick(o, ["date", "publishedAt", "pubDate", "time", "created"])),
      summary: pick(o, ["intro", "summary", "description", "synopsis"]),
      source: pick(o, ["source", "publisher", "provider"]),
    });
  }
  return out
    .sort((a, b) => (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0))
    .slice(0, MAX_ITEMS);
}

/** The reply is our company: NSE symbol, trusted BSE code, or a close name match. */
export function replyIsCompany(body: unknown, ticker: string, name: string): { ok: boolean; replyName: string | null } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const profile = (b.companyProfile && typeof b.companyProfile === "object" ? b.companyProfile : {}) as Record<
    string,
    unknown
  >;
  const replyName = pick(b, ["companyName", "name"]) ?? pick(profile, ["companyName", "name"]);
  const nse = pick(profile, ["exchangeCodeNse", "nseCode", "nseSymbol"])?.toUpperCase() ?? null;
  const bse = pick(profile, ["exchangeCodeBse", "bseCode", "bseScripCode"]);
  const t = ticker.toUpperCase();
  if (nse && nse === t) return { ok: true, replyName };
  const code = trustedBseCode(t);
  if (code && bse && bse === code) return { ok: true, replyName };
  // A different exchange code is a different company, whatever the name says.
  if ((nse && nse !== t && !bse) || (code && bse && bse !== code)) return { ok: false, replyName };
  return { ok: !!replyName && namesMatch(name, replyName), replyName };
}

export async function napkinNews(tickerRaw: string, nameRaw: string): Promise<NewsResult> {
  const ticker = tickerRaw.trim().toUpperCase();
  const name = nameRaw.trim() || ticker;
  const now = new Date().toISOString();
  if (!indianApiConfigured()) return { status: "unavailable", items: [], matched_name: null, fetched_at: now };

  const cached = readCache(ticker);
  if (cached) {
    const age = Date.now() - Date.parse(cached.fetched_at);
    const keep = cached.status === "limited" ? LIMIT_RETRY_MS : FRESH_MS;
    if (age < keep) return cached;
  }

  let res: NewsResult;
  try {
    // Full company name: a bare ticker can match a bigger namesake.
    const body = await indianGet("/stock", { name });
    const id = replyIsCompany(body, ticker, name);
    if (!id.ok) res = { status: "mismatch", items: [], matched_name: id.replyName, fetched_at: now };
    else {
      const items = parseNews(body);
      res = { status: items.length ? "ok" : "empty", items, matched_name: id.replyName, fetched_at: now };
    }
  } catch (e) {
    if (e instanceof IndianApiRateLimitError) {
      // Keep showing older news while the limit lasts.
      res = cached?.items.length
        ? { ...cached, status: "ok" }
        : { status: "limited", items: [], matched_name: null, fetched_at: now };
      if (!cached?.items.length) writeCache(ticker, res);
      return res;
    }
    return cached ?? { status: "unavailable", items: [], matched_name: null, fetched_at: now };
  }
  writeCache(ticker, res);
  return res;
}
