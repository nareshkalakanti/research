import type { FillResult } from "./nanocap-champs";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * StockScans industry: name, industry and sector for every listed company,
 * read from their public company pages (listed in their sitemap; robots allow it).
 * Each page carries a "peers" list (~10 companies with Name / Industry / Sector),
 * so companies already seen as a peer are skipped. Slow and polite: one page
 * every 3–5 s, stops at the first refusal. Stored in data/stockscans.db.
 */

const BASE = "https://www.stockscans.in";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type SsRow = { company_id: string; name: string; industry: string; sector: string | null };

function withDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T, readonly = false): T {
  const db = openSqliteNamed("stockscans.db", { readonly, wal: true });
  try {
    if (!readonly) {
      db.pragma("busy_timeout = 5000");
      db.exec(`CREATE TABLE IF NOT EXISTS ss_company (
        company_id TEXT PRIMARY KEY,
        ticker TEXT,
        exchange TEXT,
        name TEXT NOT NULL,
        industry TEXT NOT NULL,
        sector TEXT,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ss_ticker ON ss_company(ticker);
      CREATE TABLE IF NOT EXISTS ss_pages (company_id TEXT PRIMARY KEY, status INTEGER, fetched_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ss_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    }
    return fn(db);
  } finally {
    db.close();
  }
}

async function get(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xml" },
    signal: AbortSignal.timeout(45_000),
  });
  return { status: res.status, body: await res.text() };
}

/** Company ids from the sitemap ("NSE:RELIANCE", "BSE:500325"…). */
async function sitemapIds(): Promise<string[]> {
  const r = await get(`${BASE}/sitemaps/companies.xml`);
  if (r.status !== 200) throw new Error(`Sitemap ${r.status}`);
  return [...r.body.matchAll(/<loc>[^<]*\/company\/([^<]+)<\/loc>/g)].map((m) => decodeURIComponent(unXml(m[1]!)));
}

const unXml = (v: string) => v.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"');
/** "\\u0026" → "&" (JSON escapes left in the page payload). */
const unJs = (v: string) => v.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** Name / Industry / Sector of the page's company and its peers. */
export function parseCompanyPage(html: string, id: string): SsRow[] {
  const text = html.replace(/\\"/g, '"');
  const out = new Map<string, SsRow>();
  const re = /"companyId":"([^"]+)","Name":"([^"]*)","Industry":"([^"]*)","Sector":"([^"]*)"/g;
  for (const m of text.matchAll(re)) {
    if (!m[3]) continue;
    const cid = unJs(m[1]!);
    out.set(cid, { company_id: cid, name: unJs(m[2]!), industry: unJs(m[3]!), sector: m[4] ? unJs(m[4]) : null });
  }
  if (!out.has(id)) {
    // The page's own company: header industry link.
    const ind = /industryText">([^<]+)</.exec(html)?.[1];
    const name = /<title>([^<|–-]+)/.exec(html)?.[1]?.replace(/\s+share price.*$/i, "").trim();
    if (ind && name) out.set(id, { company_id: id, name, industry: ind.replace(/&amp;/g, "&"), sector: null });
  }
  return [...out.values()];
}

/** "NSE:RELIANCE" → our ticker; BSE codes through the scrip table. */
function tickerMap(): (id: string) => { ticker: string | null; exchange: string } {
  const bse = new Map<string, string>();
  try {
    const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
    try {
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, scrip_code AS c FROM company_bse_scrip`).all() as Array<{
        t: string;
        c: string;
      }>)
        bse.set(String(r.c).trim(), r.t);
    } finally {
      db.close();
    }
  } catch {
    /* optional */
  }
  return (id: string) => {
    const [ex, code] = id.split(":");
    if (!code) return { ticker: null, exchange: ex ?? "" };
    if (ex === "BSE") return { ticker: bse.get(code) ?? (/^\d+$/.test(code) ? null : code.toUpperCase()), exchange: "BSE" };
    return { ticker: code.toUpperCase(), exchange: ex ?? "NSE" };
  };
}

function saveRows(rows: SsRow[]): void {
  if (!rows.length) return;
  const map = tickerMap();
  const now = new Date().toISOString();
  withDb((db) => {
    const ins = db.prepare(
      `INSERT INTO ss_company (company_id, ticker, exchange, name, industry, sector, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id) DO UPDATE SET name = excluded.name, industry = excluded.industry,
         sector = COALESCE(excluded.sector, ss_company.sector), ticker = excluded.ticker, fetched_at = excluded.fetched_at`,
    );
    db.transaction(() => {
      for (const r of rows) {
        const t = map(r.company_id);
        ins.run(r.company_id, t.ticker, t.exchange, r.name, r.industry, r.sector, now);
      }
    })();
  });
}

const STOP_KEY = "__stockscansStop";
type StopHolder = { [STOP_KEY]?: boolean };
export function stopStockscansCrawl(): void {
  (globalThis as StopHolder)[STOP_KEY] = true;
}

/**
 * Crawl: sitemap → pages for companies not yet captured (directly or as a peer).
 * Refreshes anything older than 30 days on later runs.
 */
export async function crawlStockscans(onProgress: (done: number, total: number, filled: number) => void): Promise<FillResult> {
  const holder = globalThis as StopHolder;
  holder[STOP_KEY] = false;
  const ids = await sitemapIds();
  // Earlier runs saved peer ids with JSON escapes ("NSE:M\\u0026M"); the clean id replaces them.
  withDb((db) => db.prepare(`DELETE FROM ss_company WHERE instr(company_id, char(92)) > 0`).run());
  const fresh = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const have = withDb(
    (db) =>
      new Set(
        (db.prepare(`SELECT company_id FROM ss_company WHERE fetched_at >= ?`).all(fresh) as Array<{ company_id: string }>).map(
          (r) => r.company_id,
        ),
      ),
  );
  let done = 0;
  let filled = 0;
  let failed = 0;
  let refused = 0;
  const todo = ids.filter((id) => !have.has(id));
  onProgress(0, todo.length, 0);
  for (const id of todo) {
    if (holder[STOP_KEY]) break;
    if (have.has(id)) {
      // Captured as a peer since the run started.
      done++;
      continue;
    }
    try {
      const r = await get(`${BASE}/company/${encodeURIComponent(id).replace("%3A", ":")}`);
      withDb((db) =>
        db.prepare(`INSERT OR REPLACE INTO ss_pages (company_id, status, fetched_at) VALUES (?, ?, ?)`).run(id, r.status, new Date().toISOString()),
      );
      if (r.status === 403 || r.status === 429 || /captcha|access denied|too many requests/i.test(r.body.slice(0, 3000))) {
        refused++;
        withDb((db) => db.prepare(`INSERT OR REPLACE INTO ss_meta (k, v) VALUES ('blocked_at', ?)`).run(new Date().toISOString()));
        throw new Error(`StockScans refused (${r.status}) — stopped`);
      }
      if (r.status === 200) {
        const rows = parseCompanyPage(r.body, id);
        saveRows(rows);
        for (const x of rows) if (!have.has(x.company_id)) {
          have.add(x.company_id);
          filled++;
        }
      } else failed++;
    } catch (e) {
      if (refused) throw e;
      failed++;
    }
    done++;
    onProgress(done, todo.length, filled);
    await new Promise((s) => setTimeout(s, 3000 + Math.random() * 2000));
  }
  return { tried: done, filled, left: todo.length - done, not_found: failed };
}

/** Ticker → StockScans industry / sector / name. */
export function loadStockscansIndustry(): Map<string, { name: string; industry: string; sector: string | null }> {
  const out = new Map<string, { name: string; industry: string; sector: string | null }>();
  try {
    withDb((db) => {
      // NSE rows win over BSE rows for the same ticker.
      for (const r of db
        .prepare(`SELECT ticker, name, industry, sector, exchange FROM ss_company WHERE ticker IS NOT NULL ORDER BY exchange = 'NSE'`)
        .all() as Array<{ ticker: string; name: string; industry: string; sector: string | null }>)
        out.set(r.ticker, { name: r.name, industry: r.industry, sector: r.sector });
    }, true);
  } catch {
    /* not crawled yet */
  }
  return out;
}

export function stockscansStatus(): { companies: number; mapped: number; pages: number; last: string | null; blocked_at: string | null } {
  try {
    return withDb((db) => {
      const a = db.prepare(`SELECT COUNT(*) AS n, SUM(ticker IS NOT NULL) AS m, MAX(fetched_at) AS last FROM ss_company`).get() as {
        n: number;
        m: number | null;
        last: string | null;
      };
      const p = db.prepare(`SELECT COUNT(*) AS n FROM ss_pages`).get() as { n: number };
      const b = db.prepare(`SELECT v FROM ss_meta WHERE k = 'blocked_at'`).get() as { v: string } | undefined;
      return { companies: a.n, mapped: a.m ?? 0, pages: p.n, last: a.last, blocked_at: b?.v ?? null };
    });
  } catch {
    return { companies: 0, mapped: 0, pages: 0, last: null, blocked_at: null };
  }
}
