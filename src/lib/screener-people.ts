import * as cheerio from "cheerio";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  createFundList,
  deleteFundWatchlistTicker,
  ensureFundWatchlistInCompanyAbout,
  invalidateFundWatchlistCache,
  listFundCatalog,
  upsertFundWatchlistRows,
} from "./fund-watchlists";
import { recordScreenerBlock, screenerBlocked, screenerPausedUntil } from "./screener-fetch";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Fund watchlists fed from Screener "people" pages (an investor's or fund's
 * 1%+ holdings). Screener only shows these pages when logged in: the session
 * cookie comes from SCREENER_SESSIONID in .env.local and is never logged.
 *
 * Update rule (keeps hand-added stocks safe): stocks on the page are added or
 * updated with the quarter's change; a stock is removed only if it came from
 * this same page earlier and is no longer on it.
 */

const DB_PATH = path.join(process.cwd(), "data", "fund_watchlists.db");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** Re-pull a page at most once a day in the background. */
const STALE_MS = 24 * 60 * 60 * 1000;

/** The pages to follow, and the watchlist each one feeds. */
export const PEOPLE_SOURCES: Array<{ url: string; list: string; label: string }> = [
  { url: "https://www.screener.in/people/161556/niveshaay-hedgehogs-fund/", list: "niveshaay", label: "Niveshaay" },
  { url: "https://www.screener.in/people/197480/niveshaay-hedgehogs-fund/", list: "niveshaay", label: "Niveshaay" },
  { url: "https://www.screener.in/people/198254/niveshaay-sambhav-fund/", list: "niveshaay", label: "Niveshaay" },
  { url: "https://www.screener.in/people/144524/negen-undiscovered-value-fund/", list: "negen", label: "Negen Capital / Negen Undiscovered Value Fund" },
  { url: "https://www.screener.in/people/131400/carnelian-structural-shift-fund/", list: "carnelian", label: "Carnelian Asset Management" },
  { url: "https://www.screener.in/people/20809/manohar-devabhaktumi/", list: "manohar", label: "Manohar Devabhaktuni" },
  { url: "https://www.screener.in/people/141416/manohar-devabhaktuni/", list: "manohar", label: "Manohar Devabhaktuni" },
  { url: "https://www.screener.in/people/143537/finavenue-capital-trust-finavenue-growth-fund/", list: "", label: "Finavenue Growth Fund" },
  { url: "https://www.screener.in/people/436/small-cap-world-fund-inc/", list: "", label: "Small Cap World Fund" },
  { url: "https://www.screener.in/people/127736/ashish-kacholia/", list: "kacholia", label: "Ashish Kacholia" },
  { url: "https://www.screener.in/people/160565/bharat-ventures-opportunities-fund/", list: "", label: "Bharat Ventures Opportunities Fund" },
  { url: "https://www.screener.in/people/153027/arnav-financial-services-private-limited/", list: "", label: "Arnav Financial Services" },
  { url: "https://www.screener.in/people/166040/aarthaif-growth-fund/", list: "", label: "AarthAIF Growth Fund" },
];

function withDb<T>(fn: (db: Database.Database) => T): T {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS fund_people_sources (
      url TEXT PRIMARY KEY,
      list_key TEXT NOT NULL,
      label TEXT NOT NULL,
      last_pulled TEXT,
      last_count INTEGER,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS fund_people_holdings (
      url TEXT NOT NULL,
      ticker TEXT NOT NULL,
      pct REAL,
      prev_pct REAL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (url, ticker)
    );
    CREATE TABLE IF NOT EXISTS fund_people_history (
      url TEXT NOT NULL,
      ticker TEXT NOT NULL,
      quarter TEXT NOT NULL,
      pct REAL,
      PRIMARY KEY (url, ticker, quarter)
    );`);
    return fn(db);
  } finally {
    db.close();
  }
}

/** Make sure every source has a watchlist (new funds get a new list). */
export function ensurePeopleSources(): void {
  const byLabel = new Map(listFundCatalog().map((c) => [c.label.toLowerCase(), c.key]));
  const keys = new Set(listFundCatalog().map((c) => c.key));
  const known = withDb(
    (db) =>
      new Map(
        (db.prepare(`SELECT url, list_key FROM fund_people_sources`).all() as Array<{ url: string; list_key: string }>).map(
          (r) => [r.url, r.list_key],
        ),
      ),
  );
  for (const s of PEOPLE_SOURCES) {
    let key = known.get(s.url) || s.list;
    if (!key || !keys.has(key)) key = byLabel.get(s.label.toLowerCase()) ?? "";
    if (!key) {
      key = createFundList(s.label).key;
      keys.add(key);
      byLabel.set(s.label.toLowerCase(), key);
    }
    withDb((db) =>
      db
        .prepare(
          `INSERT INTO fund_people_sources (url, list_key, label) VALUES (?, ?, ?)
           ON CONFLICT(url) DO UPDATE SET list_key = excluded.list_key, label = excluded.label`,
        )
        .run(s.url, key, s.label),
    );
  }
}

export function hasScreenerLogin(): boolean {
  return !!(process.env.SCREENER_SESSIONID || "").trim();
}

async function fetchPeopleHtml(url: string, hops = 0): Promise<string> {
  const session = (process.env.SCREENER_SESSIONID || "").trim();
  if (!session) throw new Error("Screener login not set (SCREENER_SESSIONID in .env.local)");
  // Shares the app's Screener pause: never fetch while Screener has asked us to back off.
  const paused = screenerPausedUntil();
  if (paused) throw new Error(`Screener paused until ${paused} (blocked earlier) — not fetching`);
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      Cookie: `sessionid=${session}`,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const loc = res.headers.get("location") || "";
  if (res.status >= 300 && res.status < 400) {
    if (/register|login/i.test(loc)) throw new Error("Screener login expired — copy a fresh sessionid into .env.local");
    // Page moved (renamed slug): follow it once or twice, Screener only.
    const next = new URL(loc, url);
    if (hops < 2 && next.hostname.endsWith("screener.in")) {
      await new Promise((r) => setTimeout(r, 3000));
      return fetchPeopleHtml(next.toString(), hops + 1);
    }
    throw new Error(`Screener ${res.status} → ${next.pathname}`);
  }
  const html = await res.text();
  if (screenerBlocked(html, res.status)) {
    const until = recordScreenerBlock();
    throw new Error(`Screener blocked (${res.status}) — paused until ${until}`);
  }
  if (!res.ok) throw new Error(`Screener ${res.status}`);
  return html;
}

/** hist: every quarter column on the page as [quarter key "2026-Q1", stake % or null (under 1% / not held)]. */
type PageRow = { ref: string; name: string; pct: number | null; prev: number | null; hist: Array<[string, number | null]> };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "Mar 2026" → "2026-Q1" (calendar quarters: Jan–Mar = Q1). */
export function quarterKeyOf(label: string): string | null {
  const m = /^([A-Za-z]{3})[a-z]* (\d{4})$/.exec(label.trim());
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1]!.toLowerCase());
  return mi < 0 ? null : `${m[2]}-Q${Math.floor(mi / 3) + 1}`;
}

/**
 * Holdings table: header row of quarters ("Dec 2024 … Sep 2026", oldest → newest),
 * one row per company linking to /company/<symbol or BSE code>/, a stake % per quarter
 * (blank = under 1% / not held). The other table on the page (recent bulk / block deals)
 * is ignored.
 *
 * Held now = a stake in the latest quarter, or the one before it (filings come in late).
 */
export function parsePeopleHtml(html: string): PageRow[] {
  const $ = cheerio.load(html);
  const QTR = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}$/;
  const out = new Map<string, PageRow>();
  $("table").each((_, table) => {
    const head = $(table)
      .find("tr")
      .filter((__, tr) => $(tr).find("th,td").toArray().some((c) => QTR.test($(c).text().replace(/\s+/g, " ").trim())))
      .first();
    if (!head.length) return;
    // Column index of each quarter in the header row.
    const cols: number[] = [];
    const qkeys: string[] = [];
    head.find("th,td").each((i, c) => {
      const t = $(c).text().replace(/\s+/g, " ").trim();
      if (QTR.test(t)) {
        cols.push(i);
        qkeys.push(quarterKeyOf(t) ?? t);
      }
    });
    if (!cols.length) return;
    $(table)
      .find("tr")
      .each((__, tr) => {
        const a = $(tr).find('a[href^="/company/"]').first();
        if (!a.length) return;
        const m = /^\/company\/([^/]+)\//.exec(a.attr("href") || "");
        if (!m) return;
        const cells = $(tr).find("th,td").toArray();
        const vals = cols.map((ci) => {
          const t = $(cells[ci]).text().replace(/[%,\s]/g, "");
          return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
        });
        const n = vals.length;
        const at = vals[n - 1] != null ? n - 1 : vals[n - 2] != null ? n - 2 : -1;
        let prev: number | null = null;
        for (let i = (at >= 0 ? at : n) - 1; i >= 0; i--)
          if (vals[i] != null) {
            prev = vals[i]!;
            break;
          }
        const ref = decodeURIComponent(m[1]!).toUpperCase();
        out.set(ref, {
          ref,
          name: a.text().replace(/\s+/g, " ").trim(),
          pct: at >= 0 ? vals[at]! : null,
          prev,
          hist: qkeys.map((k, i) => [k, vals[i] ?? null]),
        });
      });
  });
  return [...out.values()];
}

/** Screener refs are NSE symbols or BSE scrip codes → our ticker + market. */
function resolveRefs(refs: string[]): Map<string, { ticker: string; market: string; name: string }> {
  const out = new Map<string, { ticker: string; market: string; name: string }>();
  const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
  try {
    const bySym = db.prepare(`SELECT UPPER(ticker) AS t, market, name FROM company_about WHERE UPPER(ticker) = ?`);
    const byCode = db.prepare(
      `SELECT UPPER(s.ticker) AS t, a.market, a.name FROM company_bse_scrip s
       LEFT JOIN company_about a ON UPPER(a.ticker) = UPPER(s.ticker) WHERE s.scrip_code = ?`,
    );
    for (const ref of refs) {
      const r = (/^\d{6}$/.test(ref) ? byCode.get(ref) : bySym.get(ref)) as
        | { t: string; market: string | null; name: string | null }
        | undefined;
      if (r) out.set(ref, { ticker: r.t, market: r.market || "NSE", name: r.name || r.t });
      else if (!/^\d+$/.test(ref)) out.set(ref, { ticker: ref, market: "NSE", name: ref });
    }
  } finally {
    db.close();
  }
  return out;
}

/** Read one page and show what would go into the list — writes nothing. */
export async function previewPeopleSource(url: string): Promise<{
  rows: Array<PageRow & { ticker: string | null; market: string | null }>;
  headers: string[];
}> {
  const html = await fetchPeopleHtml(url);
  const $ = cheerio.load(html);
  const headers = $("table")
    .map((ti, t) => `T${ti}: ` + $(t).find("th").map((_, th) => $(th).text().replace(/\s+/g, " ").trim()).get().join(" | "))
    .get();
  const sample = $("table tr")
    .slice(0, 8)
    .map((_, tr) => $(tr).find("td,th").map((__, c) => $(c).text().replace(/\s+/g, " ").trim()).get().join(" | "))
    .get();
  headers.push(...sample.map((x) => `ROW: ${x}`));
  const rows = parsePeopleHtml(html);
  const map = resolveRefs(rows.map((r) => r.ref));
  return {
    headers,
    rows: rows.map((r) => ({ ...r, ticker: map.get(r.ref)?.ticker ?? null, market: map.get(r.ref)?.market ?? null })),
  };
}

export type PullResult = { url: string; list: string; label: string; count: number; added: number; removed: number; error?: string };

/** Pull one page into its watchlist. */
export async function pullPeopleSource(url: string): Promise<PullResult> {
  const src = withDb(
    (db) =>
      db.prepare(`SELECT url, list_key, label FROM fund_people_sources WHERE url = ?`).get(url) as
        | { url: string; list_key: string; label: string }
        | undefined,
  );
  if (!src) throw new Error("Unknown source");
  const base: PullResult = { url, list: src.list_key, label: src.label, count: 0, added: 0, removed: 0 };
  try {
    const rows = parsePeopleHtml(await fetchPeopleHtml(url));
    if (!rows.length) throw new Error("No holdings found on the page (layout changed or empty)");
    const map = resolveRefs(rows.map((r) => r.ref));
    const now = new Date().toISOString();
    const items = rows
      .map((r) => ({ r, m: map.get(r.ref) }))
      .filter((x): x is { r: PageRow; m: { ticker: string; market: string; name: string } } => !!x.m && (x.r.pct ?? 0) > 0);
    const before = withDb(
      (db) =>
        new Set(
          (db.prepare(`SELECT ticker FROM fund_people_holdings WHERE url = ?`).all(url) as Array<{ ticker: string }>).map(
            (r) => r.ticker,
          ),
        ),
    );
    upsertFundWatchlistRows(
      src.list_key,
      items.map(({ r, m }) => {
        const delta = r.pct != null && r.prev != null ? r.pct - r.prev : null;
        return {
          ticker: m.ticker,
          name: m.name,
          market: m.market,
          change_qtr: delta,
          change_type:
            r.prev == null || r.prev === 0
              ? "new"
              : delta != null && delta > 0.05
                ? "increased"
                : delta != null && delta < -0.05
                  ? "decreased"
                  : "unchanged",
        };
      }),
    );
    const nowSet = new Set(items.map((x) => x.m.ticker));
    // Remove only what this page put there and no other page of the same list still has.
    const others = withDb(
      (db) =>
        new Set(
          (
            db
              .prepare(
                `SELECT h.ticker FROM fund_people_holdings h JOIN fund_people_sources s ON s.url = h.url
                 WHERE s.list_key = ? AND h.url != ?`,
              )
              .all(src.list_key, url) as Array<{ ticker: string }>
          ).map((r) => r.ticker),
        ),
    );
    let removed = 0;
    for (const t of before) {
      if (nowSet.has(t) || others.has(t)) continue;
      deleteFundWatchlistTicker(src.list_key, t);
      removed++;
    }
    withDb((db) => {
      db.transaction(() => {
        db.prepare(`DELETE FROM fund_people_holdings WHERE url = ?`).run(url);
        const ins = db.prepare(
          `INSERT INTO fund_people_holdings (url, ticker, pct, prev_pct, fetched_at) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const { r, m } of items) ins.run(url, m.ticker, r.pct, r.prev, now);
        // Full quarter history for every row on the page (also stocks since sold), for the picks comparison.
        db.prepare(`DELETE FROM fund_people_history WHERE url = ?`).run(url);
        const hist = db.prepare(`INSERT OR REPLACE INTO fund_people_history (url, ticker, quarter, pct) VALUES (?, ?, ?, ?)`);
        for (const r of rows) {
          const m = map.get(r.ref);
          if (!m) continue;
          for (const [q, v] of r.hist) hist.run(url, m.ticker, q, v);
        }
        db.prepare(`UPDATE fund_people_sources SET last_pulled = ?, last_count = ?, last_error = NULL WHERE url = ?`).run(
          now,
          items.length,
          url,
        );
      })();
    });
    try {
      ensureFundWatchlistInCompanyAbout(
        items.map(({ m }) => ({ ticker: m.ticker, name: m.name, market: m.market, list_key: src.list_key })),
      );
    } catch {
      /* optional */
    }
    invalidateFundWatchlistCache();
    return { ...base, count: items.length, added: [...nowSet].filter((t) => !before.has(t)).length, removed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    withDb((db) => db.prepare(`UPDATE fund_people_sources SET last_error = ? WHERE url = ?`).run(msg, url));
    return { ...base, error: msg };
  }
}

/** Pull every page (or only stale ones). Stops at the first login error. */
export async function pullAllPeople(opts?: { onlyStale?: boolean; maxAgeMs?: number }): Promise<PullResult[]> {
  ensurePeopleSources();
  const rows = withDb(
    (db) => db.prepare(`SELECT url, last_pulled FROM fund_people_sources`).all() as Array<{ url: string; last_pulled: string | null }>,
  );
  const out: PullResult[] = [];
  for (const r of rows) {
    const maxAge = opts?.maxAgeMs ?? (opts?.onlyStale ? STALE_MS : 0);
    if (maxAge && r.last_pulled && Date.now() - Date.parse(r.last_pulled) < maxAge) continue;
    const res = await pullPeopleSource(r.url);
    out.push(res);
    // Stop at once on a login problem or any sign of blocking.
    if (res.error && /login|blocked|paused|429|403/i.test(res.error)) break;
    await new Promise((s) => setTimeout(s, 8000 + Math.random() * 4000));
  }
  return out;
}

/** Fund name from a people-page slug ("niveshaay-sambhav-fund" → "Niveshaay Sambhav Fund"); a name shared by two pages gets the page id. */
function pageNamer(urls: string[]): (url: string) => string {
  const slugName = (url: string) =>
    (/\/people\/\d+\/([^/]+)/.exec(url)?.[1] ?? url).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const dup = new Map<string, number>();
  for (const u of urls) dup.set(slugName(u), (dup.get(slugName(u)) ?? 0) + 1);
  return (url) => {
    const n = slugName(url);
    return (dup.get(n) ?? 0) > 1 ? `${n} (${/\/people\/(\d+)/.exec(url)?.[1] ?? "?"})` : n;
  };
}

export type FundHistory = {
  /** Quarter columns the pages cover, oldest first. */
  quarters: string[];
  /** ticker → fund label → quarter → stake % (absent = under 1% / not held). */
  byTicker: Record<string, Record<string, Record<string, number>>>;
  funds: Array<{ url: string; label: string; last_pulled: string | null; last_error: string | null }>;
};

/** Stake history from every people page of one watchlist (e.g. "niveshaay"), per fund page. */
export function fundHistoryForList(listKey: string): FundHistory {
  return withDb((db) => {
    const funds = db
      .prepare(`SELECT url, label, last_pulled, last_error FROM fund_people_sources WHERE list_key = ? ORDER BY url`)
      .all(listKey) as FundHistory["funds"];
    const quarters = new Set<string>();
    const byTicker: FundHistory["byTicker"] = {};
    const rows = db
      .prepare(
        `SELECT h.url, h.ticker, h.quarter, h.pct FROM fund_people_history h
         JOIN fund_people_sources s ON s.url = h.url WHERE s.list_key = ?`,
      )
      .all(listKey) as Array<{ url: string; ticker: string; quarter: string; pct: number | null }>;
    const name = pageNamer(funds.map((f) => f.url));
    for (const r of rows) {
      quarters.add(r.quarter);
      if (r.pct == null) continue;
      const f = ((byTicker[r.ticker.toUpperCase()] ??= {})[name(r.url)] ??= {});
      f[r.quarter] = r.pct;
    }
    return { quarters: [...quarters].sort(), byTicker, funds };
  });
}

/** Each followed people page's watchlist key and the name it is followed under (e.g. kacholia → "Ashish Kacholia"). */
export function peopleListLabels(): Array<{ key: string; label: string }> {
  return withDb(
    (db) =>
      db.prepare(`SELECT DISTINCT list_key AS key, label FROM fund_people_sources WHERE list_key != ''`).all() as Array<{
        key: string;
        label: string;
      }>,
  );
}

/** Watchlist keys that have at least one followed people page (the investors with filings history). */
export function peopleListKeys(): string[] {
  return withDb((db) =>
    (db.prepare(`SELECT DISTINCT list_key FROM fund_people_sources WHERE list_key != ''`).all() as Array<{ list_key: string }>).map(
      (r) => r.list_key,
    ),
  );
}

export type FundHolder = {
  /** Watchlist label the page feeds (e.g. "Niveshaay"), and the fund named on the page. */
  investor: string;
  fund: string;
  url: string;
  /** Stake % per quarter key ("2026-Q3"), null = under 1% / not held that quarter. */
  series: Record<string, number | null>;
  latest: number | null;
  prev: number | null;
  /** new / increased / decreased / unchanged / exited (held before, not in the latest filing). */
  change: "new" | "increased" | "decreased" | "unchanged" | "exited";
  fetched_at: string | null;
};

/**
 * Every followed Screener people page that shows a stake in this stock (1%+ filings), with its quarter history.
 * Pages pulled before history was kept fall back to their latest and previous stake.
 */
export function fundHoldersOf(ticker: string): { quarters: string[]; holders: FundHolder[] } {
  const t = ticker.trim().toUpperCase();
  if (!t) return { quarters: [], holders: [] };
  return withDb((db) => {
    const sources = db.prepare(`SELECT url, label, last_pulled FROM fund_people_sources`).all() as Array<{
      url: string;
      label: string;
      last_pulled: string | null;
    }>;
    const name = pageNamer(sources.map((x) => x.url));
    const hist = db
      .prepare(`SELECT url, quarter, pct FROM fund_people_history WHERE UPPER(ticker) = ? ORDER BY quarter`)
      .all(t) as Array<{ url: string; quarter: string; pct: number | null }>;
    const now = db
      .prepare(`SELECT url, pct, prev_pct, fetched_at FROM fund_people_holdings WHERE UPPER(ticker) = ?`)
      .all(t) as Array<{ url: string; pct: number | null; prev_pct: number | null; fetched_at: string }>;
    const quarters = new Set<string>();
    const out: FundHolder[] = [];
    for (const src of sources) {
      const h = hist.filter((r) => r.url === src.url);
      const cur = now.find((r) => r.url === src.url);
      if (!h.some((r) => r.pct != null) && !cur) continue;
      const series: Record<string, number | null> = {};
      for (const r of h) {
        series[r.quarter] = r.pct;
        quarters.add(r.quarter);
      }
      const qs = h.map((r) => r.quarter);
      let latest: number | null;
      let prev: number | null = null;
      if (qs.length) {
        // Same rule as the watchlist: the latest filing, or the one before it (filings come in late).
        const last = series[qs[qs.length - 1]!] ?? null;
        const atIdx = last != null ? qs.length - 1 : series[qs[qs.length - 2] ?? ""] != null ? qs.length - 2 : -1;
        latest = atIdx >= 0 ? series[qs[atIdx]!]! : null;
        for (let i = (atIdx >= 0 ? atIdx : qs.length) - 1; i >= 0; i--)
          if (series[qs[i]!] != null) {
            prev = series[qs[i]!]!;
            break;
          }
      } else {
        latest = cur?.pct ?? null;
        prev = cur?.prev_pct ?? null;
      }
      if (latest == null && qs.length) {
        // Sold long ago is noise here: keep an exit only if the stake was there in the last two filings.
        const lastHeld = qs.reduce((b, q, i) => (series[q] != null ? i : b), -1);
        if (lastHeld < qs.length - 3) continue;
      }
      const d = latest != null && prev != null ? latest - prev : null;
      const change: FundHolder["change"] =
        latest == null ? "exited" : prev == null ? "new" : d! > 0.05 ? "increased" : d! < -0.05 ? "decreased" : "unchanged";
      out.push({ investor: src.label, fund: name(src.url), url: src.url, series, latest, prev, change, fetched_at: cur?.fetched_at ?? src.last_pulled });
    }
    const order = { increased: 0, new: 1, unchanged: 2, decreased: 3, exited: 4 };
    out.sort((a, b) => order[a.change] - order[b.change] || (b.latest ?? 0) - (a.latest ?? 0));
    return { quarters: [...quarters].sort(), holders: out };
  });
}

export type PeopleStatus = {
  login: boolean;
  sources: Array<{ url: string; list_key: string; label: string; last_pulled: string | null; last_count: number | null; last_error: string | null }>;
};

export function peopleStatus(): PeopleStatus {
  ensurePeopleSources();
  return {
    login: hasScreenerLogin(),
    sources: withDb(
      (db) =>
        db
          .prepare(`SELECT url, list_key, label, last_pulled, last_count, last_error FROM fund_people_sources ORDER BY label`)
          .all() as PeopleStatus["sources"],
    ),
  };
}
