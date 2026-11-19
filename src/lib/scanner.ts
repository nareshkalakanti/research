import { listFundCatalog, loadFundHoldings } from "./fund-watchlists";
import { holdingsTickerSet } from "./holdings";
import { inactiveListingTickers } from "./listing-sync";
import { buildStock, loadCtx } from "./nanocap-champs";
import { openSqliteNamed } from "./sqlite-utils";
import { loadStockMaster } from "./stock-master";

/**
 * Scanner page: every active listing with name, sector › industry, size, price
 * and core ratios, filtered in the browser. Saved scans live in data/scans.db.
 */

export type ScanRow = {
  t: string;
  name: string;
  market: string;
  sector: string | null;
  industry: string | null;
  /** Where the industry came from: StockScans, or the app's own classification. */
  ind_src: "stockscans" | "own" | null;
  mcap: number | null;
  price: number | null;
  chg: number | null;
  pe: number | null;
  roce: number | null;
  roe: number | null;
  sales_yoy: number | null;
  profit_yoy: number | null;
  web: string | null;
  /** Index ids this stock is in (NIFTY_200, NIFTY_500). */
  idx: string[];
  /** Watchlist keys holding it ("holdings", named lists, fund lists). */
  lists: string[];
};

export type ScannerData = {
  rows: ScanRow[];
  lists: Array<{ key: string; label: string; count: number }>;
  indices: Array<{ id: string; label: string; count: number }>;
  as_of: string | null;
  missing_industry: number;
};

let cache: { at: number; data: ScannerData } | null = null;

function loadPrices(): { px: Map<string, { price: number | null; chg: number | null }>; asOf: string | null } {
  const px = new Map<string, { price: number | null; chg: number | null }>();
  let asOf: string | null = null;
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    for (const r of db
      .prepare(`SELECT UPPER(ticker) AS t, price, change_pct, fetched_at FROM stock_metrics`)
      .all() as Array<{ t: string; price: number | null; change_pct: number | null; fetched_at: string }>) {
      px.set(r.t, { price: r.price, chg: r.change_pct });
      if (!asOf || r.fetched_at > asOf) asOf = r.fetched_at;
    }
  } finally {
    db.close();
  }
  return { px, asOf };
}

function loadIndustry(): Map<string, { sector: string | null; industry: string | null }> {
  const out = new Map<string, { sector: string | null; industry: string | null }>();
  const db = openSqliteNamed("classifications.db", { readonly: true, wal: true });
  try {
    for (const r of db
      .prepare(`SELECT UPPER(ticker) AS t, sector, industry, sub_sector FROM classifications`)
      .all() as Array<{ t: string; sector: string | null; industry: string | null; sub_sector: string | null }>) {
      if (!out.has(r.t)) out.set(r.t, { sector: r.sector || null, industry: r.industry || r.sub_sector || null });
    }
  } finally {
    db.close();
  }
  return out;
}

function loadIndices(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  try {
    const db = openSqliteNamed("index_constituents.db", { readonly: true, wal: true });
    try {
      for (const r of db.prepare(`SELECT index_id, UPPER(ticker) AS t FROM index_constituents`).all() as Array<{
        index_id: string;
        t: string;
      }>) {
        if (!out.has(r.t)) out.set(r.t, []);
        out.get(r.t)!.push(r.index_id);
      }
    } finally {
      db.close();
    }
  } catch {
    /* optional */
  }
  return out;
}

function loadLists(): { byTicker: Map<string, string[]>; meta: Array<{ key: string; label: string; count: number }> } {
  const byTicker = new Map<string, string[]>();
  const meta: Array<{ key: string; label: string; count: number }> = [];
  const add = (key: string, label: string, tickers: Iterable<string>) => {
    let n = 0;
    for (const raw of tickers) {
      const t = raw.toUpperCase();
      if (!byTicker.has(t)) byTicker.set(t, []);
      const l = byTicker.get(t)!;
      if (!l.includes(key)) {
        l.push(key);
        n++;
      }
    }
    if (n) meta.push({ key, label, count: n });
  };
  try {
    add("holdings", "My holdings", holdingsTickerSet());
  } catch {
    /* optional */
  }
  try {
    const db = openSqliteNamed("named_watchlists.db", { readonly: true, wal: true });
    try {
      const rows = db.prepare(`SELECT list_key, UPPER(ticker) AS t FROM named_watchlists`).all() as Array<{
        list_key: string;
        t: string;
      }>;
      const by = new Map<string, string[]>();
      for (const r of rows) {
        if (!by.has(r.list_key)) by.set(r.list_key, []);
        by.get(r.list_key)!.push(r.t);
      }
      for (const [k, ts] of by) add(`wl:${k}`, `Watchlist · ${k}`, ts);
    } finally {
      db.close();
    }
  } catch {
    /* optional */
  }
  try {
    for (const f of listFundCatalog()) {
      if (!f.count) continue;
      add(`fund:${f.key}`, `Fund · ${f.label}`, loadFundHoldings(f.key).map((h) => h.ticker));
    }
  } catch {
    /* optional */
  }
  return { byTicker, meta };
}

export function buildScannerData(opts?: { fresh?: boolean }): ScannerData {
  if (!opts?.fresh && cache && Date.now() - cache.at < 10 * 60_000) return cache.data;
  const ctx = loadCtx();
  const inactive = inactiveListingTickers();
  const { px, asOf } = loadPrices();
  const ind = loadIndustry();
  const idx = loadIndices();
  const { byTicker, meta } = loadLists();
  const master = loadStockMaster();
  const rows: ScanRow[] = [];
  let missing = 0;
  for (const [t] of ctx.cos) {
    if (inactive.has(t)) continue;
    const s = buildStock(t, ctx);
    const c = ind.get(t);
    // Stock master first (StockScans, then own labels), else older fallbacks.
    const sc = master.get(t);
    const sector = sc?.sector ?? c?.sector ?? s.sector ?? null;
    const industry = sc?.industry ?? c?.industry ?? s.sub_sector ?? null;
    if (!industry) missing++;
    const p = px.get(t);
    const r = ctx.ratios.get(t);
    rows.push({
      t,
      name: s.name,
      market: s.market || "NSE",
      sector,
      industry,
      ind_src: sc?.source === "stockscans" ? "stockscans" : industry ? "own" : null,
      mcap: s.mcap_cr,
      price: p?.price ?? r?.current_price ?? null,
      chg: p?.chg ?? null,
      pe: s.pe,
      roce: s.roce != null ? Math.round(s.roce * 1000) / 10 : null,
      roe: r?.roe != null ? Math.round(r.roe * 1000) / 10 : null,
      sales_yoy: s.sales_yoy != null ? Math.round(s.sales_yoy) : null,
      profit_yoy: s.profit_yoy != null ? Math.round(s.profit_yoy) : null,
      web: s.website ?? null,
      idx: idx.get(t) ?? [],
      lists: byTicker.get(t) ?? [],
    });
  }
  rows.sort((a, b) => (b.mcap ?? -1) - (a.mcap ?? -1));
  const data: ScannerData = {
    rows,
    lists: meta.sort((a, b) => a.label.localeCompare(b.label)),
    indices: [
      { id: "NIFTY_200", label: "Nifty 200", count: rows.filter((r) => r.idx.includes("NIFTY_200")).length },
      { id: "NIFTY_500", label: "Nifty 500", count: rows.filter((r) => r.idx.includes("NIFTY_500")).length },
    ],
    as_of: asOf,
    missing_industry: missing,
  };
  cache = { at: Date.now(), data };
  return data;
}

// ---- Saved scans ------------------------------------------------------------------

export type ScanCondition = { field: string; op: ">" | "<" | "between"; a: number; b?: number };
export type ScanConfig = {
  conditions: ScanCondition[];
  industries: string[];
  index: string;
  exchange: string;
  type: string;
  list: string;
  tab: string;
  sort: { key: string; dir: "asc" | "desc" };
};
export type SavedScan = { id: number; name: string; config: ScanConfig; created_at: string; updated_at: string };

function withScanDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("scans.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS saved_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    return fn(db);
  } finally {
    db.close();
  }
}

export function listScans(): SavedScan[] {
  return withScanDb((db) =>
    (
      db.prepare(`SELECT id, name, config_json, created_at, updated_at FROM saved_scans ORDER BY updated_at DESC`).all() as Array<{
        id: number;
        name: string;
        config_json: string;
        created_at: string;
        updated_at: string;
      }>
    ).map((r) => ({ id: r.id, name: r.name, config: JSON.parse(r.config_json) as ScanConfig, created_at: r.created_at, updated_at: r.updated_at })),
  );
}

export function saveScan(name: string, config: ScanConfig, id?: number | null): SavedScan {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 80) || "Untitled scan";
  const now = new Date().toISOString();
  return withScanDb((db) => {
    let rowId = id ?? null;
    if (rowId != null && db.prepare(`SELECT 1 FROM saved_scans WHERE id = ?`).get(rowId)) {
      db.prepare(`UPDATE saved_scans SET name = ?, config_json = ?, updated_at = ? WHERE id = ?`).run(
        clean,
        JSON.stringify(config),
        now,
        rowId,
      );
    } else {
      rowId = Number(
        db
          .prepare(`INSERT INTO saved_scans (name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?)`)
          .run(clean, JSON.stringify(config), now, now).lastInsertRowid,
      );
    }
    const r = db.prepare(`SELECT id, name, config_json, created_at, updated_at FROM saved_scans WHERE id = ?`).get(rowId) as {
      id: number;
      name: string;
      config_json: string;
      created_at: string;
      updated_at: string;
    };
    return { id: r.id, name: r.name, config: JSON.parse(r.config_json) as ScanConfig, created_at: r.created_at, updated_at: r.updated_at };
  });
}

export function deleteScan(id: number): void {
  withScanDb((db) => db.prepare(`DELETE FROM saved_scans WHERE id = ?`).run(id));
}
