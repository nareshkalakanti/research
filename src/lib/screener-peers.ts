/**
 * Peer P/B and P/S medians straight from Screener's "Peer comparison" table:
 * Screener's own (narrow) industry and its Median row, so Portfolio review's
 * peer valuation follows Screener exactly instead of our broader industry
 * groups with mixed data sources.
 *
 * Needs SCREENER_SESSIONID and the account's peer columns to include
 * "Price to book value" (CMP / BV) and "Price to Sales" (CMP / Sales).
 * Cached per stock for 7 days in metrics.db (screener_peers_cache); a stock
 * whose table lacks the columns is retried after a day.
 */
import { fetchScreenerCompanyHtml, fetchScreenerPeersHtml, stockBlockedUntil } from "./screener-fetch";
import { openSqliteNamed } from "./sqlite-utils";

export type ScreenerPeers = {
  /** Screener's industry, e.g. "Film Production, Distribution & Exhibition". */
  industry: string | null;
  /** Companies in Screener's median ("Median: 14 Co."). */
  n: number | null;
  pb_own: number | null;
  ps_own: number | null;
  pb_median: number | null;
  ps_median: number | null;
};

const CACHE_MS = 7 * 86_400_000;
const EMPTY_RETRY_MS = 86_400_000;

type Row = {
  ticker: string;
  warehouse_id: string | null;
  industry: string | null;
  peers_json: string | null;
  fetched_at: string;
  blocked_until: string | null;
};

function withDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS screener_peers_cache (
      ticker TEXT PRIMARY KEY,
      warehouse_id TEXT,
      industry TEXT,
      peers_json TEXT,
      fetched_at TEXT NOT NULL,
      blocked_until TEXT
    )`);
    return fn(db);
  } finally {
    db.close();
  }
}

function readRow(t: string): Row | null {
  return withDb((db) => (db.prepare(`SELECT * FROM screener_peers_cache WHERE ticker = ?`).get(t) as Row | undefined) ?? null);
}

function writeRow(r: Row): void {
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO screener_peers_cache (ticker, warehouse_id, industry, peers_json, fetched_at, blocked_until)
         VALUES (@ticker, @warehouse_id, @industry, @peers_json, @fetched_at, @blocked_until)
         ON CONFLICT(ticker) DO UPDATE SET warehouse_id = excluded.warehouse_id, industry = excluded.industry,
           peers_json = excluded.peers_json, fetched_at = excluded.fetched_at, blocked_until = excluded.blocked_until`,
      )
      .run(r),
  );
}

const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const num = (s: string | undefined) => {
  const v = Number((s ?? "").replace(/,/g, ""));
  return s && s.trim() !== "" && Number.isFinite(v) ? v : null;
};

/** Screener's company id and its narrowest industry, from the company page. */
export function parseCompanyMeta(html: string): { warehouseId: string | null; industry: string | null } {
  const warehouseId = html.match(/data-warehouse-id="(\d+)"/)?.[1] ?? null;
  const links = [...html.matchAll(/href="\/market\/[A-Z0-9/]+"[^>]*>([^<]+)</g)].map((m) => text(m[1]!));
  return { warehouseId, industry: links.at(-1) ?? null };
}

/** Own row (by ticker in the company link) and the Median row of the peers table. */
export function parsePeersTable(html: string, ticker: string): Omit<ScreenerPeers, "industry"> | null {
  const heads = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]!).toLowerCase());
  const pbCol = heads.findIndex((h) => h.startsWith("cmp / bv") || h.startsWith("price to book"));
  const psCol = heads.findIndex((h) => h.startsWith("cmp / sales") || h.startsWith("price to sales"));
  if (pbCol < 0 && psCol < 0) return null;
  const t = ticker.toUpperCase();
  // The company link spells the ticker as-is, HTML-escaped (ARE&amp;M) or URL-encoded (ARE%26M).
  const spellings = [t, t.replace(/&/g, "&amp;"), encodeURIComponent(t)].map((x) => `/company/${x.toUpperCase()}/`);
  const isOwn = (raw: string) => {
    const up = raw.toUpperCase();
    return spellings.some((x) => up.includes(x));
  };
  let own: string[] | null = null;
  let median: string[] | null = null;
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const raw = tr[1]!;
    const cells = [...raw.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]!));
    if (!cells.length) continue;
    if (/^median/i.test(cells[1] ?? "")) median = cells;
    else if (isOwn(raw)) own = cells;
  }
  if (!median) return null;
  return {
    n: num(median[1]?.match(/(\d+)\s*Co/i)?.[1]),
    pb_own: own && pbCol >= 0 ? num(own[pbCol]) : null,
    ps_own: own && psCol >= 0 ? num(own[psCol]) : null,
    pb_median: pbCol >= 0 ? num(median[pbCol]) : null,
    ps_median: psCol >= 0 ? num(median[psCol]) : null,
  };
}

/**
 * Screener peer medians for one stock (cache first). null when there is no
 * login, Screener is paused/blocked, or the table lacks the P/B / P/S columns.
 */
export async function fetchScreenerPeers(ticker: string): Promise<ScreenerPeers | null> {
  const t = ticker.trim().toUpperCase();
  if (!t || !(process.env.SCREENER_SESSIONID || "").trim()) return null;
  const now = Date.now();
  const prev = readRow(t);
  if (prev?.blocked_until && Date.parse(prev.blocked_until) > now) return null;
  if (prev && now - Date.parse(prev.fetched_at) < CACHE_MS) {
    if (prev.peers_json) return JSON.parse(prev.peers_json) as ScreenerPeers;
    if (now - Date.parse(prev.fetched_at) < EMPTY_RETRY_MS) return null;
  }
  try {
    let warehouseId = prev?.warehouse_id ?? null;
    let industry = prev?.industry ?? null;
    if (!warehouseId) {
      const meta = parseCompanyMeta(await fetchScreenerCompanyHtml(t, { consolidated: true }));
      warehouseId = meta.warehouseId;
      industry = meta.industry;
      // Standalone-only filers (no consolidated accounts) carry the id on the standalone page.
      if (!warehouseId) {
        const solo = parseCompanyMeta(await fetchScreenerCompanyHtml(t, { consolidated: false }));
        warehouseId = solo.warehouseId;
        industry = industry ?? solo.industry;
      }
    }
    if (!warehouseId) {
      writeRow({ ticker: t, warehouse_id: null, industry, peers_json: null, fetched_at: new Date().toISOString(), blocked_until: null });
      return null;
    }
    const html = await fetchScreenerPeersHtml(warehouseId);
    const parsed = html ? parsePeersTable(html, t) : null;
    const peers: ScreenerPeers | null = parsed ? { industry, ...parsed } : null;
    writeRow({
      ticker: t,
      warehouse_id: warehouseId,
      industry,
      peers_json: peers ? JSON.stringify(peers) : null,
      fetched_at: new Date().toISOString(),
      blocked_until: null,
    });
    return peers;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/blocked|paused|429|403|captcha/i.test(msg)) {
      writeRow({
        ticker: t,
        warehouse_id: prev?.warehouse_id ?? null,
        industry: prev?.industry ?? null,
        peers_json: prev?.peers_json ?? null,
        fetched_at: prev?.fetched_at ?? new Date(0).toISOString(),
        blocked_until: stockBlockedUntil(),
      });
    }
    // Keep serving an older cached table rather than nothing.
    return prev?.peers_json ? (JSON.parse(prev.peers_json) as ScreenerPeers) : null;
  }
}
