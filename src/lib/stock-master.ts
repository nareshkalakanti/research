import { syncRotationFromStockscans, type RotationSyncResult } from "./sector-rotation";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Stock master (data/stock_master.db): one row per stock with name, exchange,
 * sector and industry. The primary source of sector › industry for the app.
 *
 * Sources, best first: StockScans (scraped), then the app's own classification,
 * then the company record. New data only adds on top:
 *  - a new stock is added; a stock is never deleted (delisted ones get active = 0);
 *  - an empty value never wipes a stored one;
 *  - a StockScans value is never replaced by a weaker source;
 *  - every change is appended to stock_history (old → new, source, time).
 * Sync runs on its own whenever a source has changed (checked on each read),
 * and right after a StockScans crawl or a listing sync.
 */

type Db = ReturnType<typeof openSqliteNamed>;
export type MasterSource = "stockscans" | "own" | "company";
export type MasterRow = {
  ticker: string;
  name: string;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  source: MasterSource | null;
  /** In the app's company list (company_about). */
  tracked: boolean;
  active: boolean;
};

const RANK: Record<MasterSource, number> = { stockscans: 3, own: 2, company: 1 };
const FIELDS = ["name", "exchange", "sector", "industry", "source", "tracked", "active"] as const;

function withMaster<T>(fn: (db: Db) => T, readonly = false): T {
  const db = openSqliteNamed("stock_master.db", { readonly, wal: true });
  try {
    if (!readonly) {
      db.pragma("busy_timeout = 8000");
      db.exec(`CREATE TABLE IF NOT EXISTS stocks (
        ticker TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        exchange TEXT,
        sector TEXT,
        industry TEXT,
        source TEXT,
        ss_company_id TEXT,
        tracked INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        first_seen TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stocks_industry ON stocks(industry);
      CREATE TABLE IF NOT EXISTS stock_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        field TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        source TEXT,
        changed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hist_ticker ON stock_history(ticker);
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        added INTEGER NOT NULL,
        changed INTEGER NOT NULL,
        total INTEGER NOT NULL,
        signature TEXT NOT NULL
      );`);
    }
    return fn(db);
  } finally {
    db.close();
  }
}

function readOnly<T>(file: string, fn: (db: Db) => T, fallback: T): T {
  try {
    const db = openSqliteNamed(file, { readonly: true, wal: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return fallback;
  }
}

/** Cheap fingerprint of every source; a change triggers a sync. */
function sourceSignature(): string {
  const ss = readOnly(
    "stockscans.db",
    (db) => db.prepare(`SELECT COUNT(*) AS n, MAX(fetched_at) AS m FROM ss_company`).get() as { n: number; m: string | null },
    { n: 0, m: null },
  );
  const co = readOnly(
    "company_about.db",
    (db) => {
      const a = db.prepare(`SELECT COUNT(*) AS n, COUNT(company_industry) AS i FROM company_about`).get() as { n: number; i: number };
      let l = 0;
      try {
        l = (db.prepare(`SELECT COUNT(*) AS n FROM listing_status`).get() as { n: number }).n;
      } catch {
        /* no listing_status yet */
      }
      return `${a.n}.${a.i}.${l}`;
    },
    "0",
  );
  const cl = readOnly(
    "classifications.db",
    (db) => {
      const r = db.prepare(`SELECT COUNT(*) AS n, COUNT(sub_sector) AS s FROM classifications`).get() as { n: number; s: number };
      return `${r.n}.${r.s}`;
    },
    "0",
  );
  return `ss:${ss.n}.${ss.m ?? ""}|co:${co}|cl:${cl}`;
}

type Incoming = Omit<MasterRow, "tracked" | "active"> & { ss_id: string | null };

/** Best available record per ticker from all sources. */
function gather(): { rows: Map<string, Incoming>; tracked: Set<string>; inactive: Set<string> } {
  const rows = new Map<string, Incoming>();
  const put = (t: string, r: Incoming) => {
    const cur = rows.get(t);
    if (!cur) return void rows.set(t, r);
    // Fill gaps from the weaker source; keep the stronger source's labels.
    rows.set(t, {
      ...cur,
      name: cur.name || r.name,
      exchange: cur.exchange ?? r.exchange,
      sector: cur.sector ?? r.sector,
      industry: cur.industry ?? r.industry,
      ss_id: cur.ss_id ?? r.ss_id,
    });
  };
  const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

  // 1) StockScans — NSE rows before BSE rows for the same ticker.
  readOnly(
    "stockscans.db",
    (db) => {
      for (const r of db
        .prepare(
          `SELECT company_id, ticker, exchange, name, industry, sector FROM ss_company
           WHERE ticker IS NOT NULL AND instr(company_id, char(92)) = 0 ORDER BY exchange != 'NSE'`,
        )
        .all() as Array<{ company_id: string; ticker: string; exchange: string; name: string; industry: string; sector: string | null }>) {
        const t = r.ticker.toUpperCase();
        if (rows.get(t)?.source === "stockscans") continue;
        put(t, {
          ticker: t,
          name: r.name,
          exchange: r.exchange || null,
          sector: clean(r.sector),
          industry: clean(r.industry),
          source: clean(r.industry) ? "stockscans" : null,
          ss_id: r.company_id,
        });
      }
    },
    undefined,
  );

  // 2) The app's company list (names, exchange, its own industry as fallback).
  const tracked = new Set<string>();
  const inactive = new Set<string>();
  const cls = new Map<string, { sector: string | null; industry: string | null }>();
  readOnly(
    "classifications.db",
    (db) => {
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, sector, industry, sub_sector FROM classifications`).all() as Array<{
        t: string;
        sector: string | null;
        industry: string | null;
        sub_sector: string | null;
      }>)
        if (!cls.has(r.t)) cls.set(r.t, { sector: clean(r.sector), industry: clean(r.sub_sector) ?? clean(r.industry) });
    },
    undefined,
  );
  readOnly(
    "company_about.db",
    (db) => {
      for (const r of db
        .prepare(`SELECT UPPER(ticker) AS t, name, market, company_sector AS s, company_industry AS i FROM company_about`)
        .all() as Array<{ t: string; name: string | null; market: string | null; s: string | null; i: string | null }>) {
        tracked.add(r.t);
        const c = cls.get(r.t);
        const own = c?.industry ? c : null;
        const ss = rows.get(r.t);
        if (ss?.source === "stockscans") {
          // StockScans keeps its labels; the app's own name and exchange are the reference.
          rows.set(r.t, { ...ss, name: r.name || ss.name, exchange: r.market || ss.exchange });
          continue;
        }
        put(r.t, {
          ticker: r.t,
          name: r.name || r.t,
          exchange: r.market || null,
          sector: own?.sector ?? clean(r.s) ?? c?.sector ?? null,
          industry: own?.industry ?? clean(r.i),
          source: own ? "own" : clean(r.i) ? "company" : null,
          ss_id: null,
        });
      }
      try {
        for (const r of db.prepare(`SELECT UPPER(ticker) AS t FROM listing_status`).all() as Array<{ t: string }>)
          inactive.add(r.t);
      } catch {
        /* none */
      }
    },
    undefined,
  );
  return { rows, tracked, inactive };
}

export type SyncResult = { added: number; changed: number; total: number; skipped: boolean };

/** Merge every source into the master, adding on top. */
export function syncStockMaster(opts?: { force?: boolean }): SyncResult {
  const sig = sourceSignature();
  return withMaster((db) => {
    const last = db.prepare(`SELECT signature FROM sync_runs WHERE signature != 'rotation-full' ORDER BY id DESC LIMIT 1`).get() as { signature: string } | undefined;
    if (!opts?.force && last?.signature === sig) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM stocks`).get() as { n: number }).n;
      return { added: 0, changed: 0, total: n, skipped: true };
    }
    const { rows, tracked, inactive } = gather();
    const now = new Date().toISOString();
    const existing = new Map(
      (
        db.prepare(`SELECT ticker, name, exchange, sector, industry, source, tracked, active FROM stocks`).all() as Array<
          Record<(typeof FIELDS)[number] | "ticker", string | number | null>
        >
      ).map((r) => [String(r.ticker), r]),
    );
    const ins = db.prepare(
      `INSERT INTO stocks (ticker, name, exchange, sector, industry, source, ss_company_id, tracked, active, first_seen, updated_at)
       VALUES (@ticker, @name, @exchange, @sector, @industry, @source, @ss_id, @tracked, @active, @now, @now)`,
    );
    const upd = db.prepare(
      `UPDATE stocks SET name = @name, exchange = @exchange, sector = @sector, industry = @industry, source = @source,
         ss_company_id = COALESCE(@ss_id, ss_company_id), tracked = @tracked, active = @active, updated_at = @now
       WHERE ticker = @ticker`,
    );
    const log = db.prepare(
      `INSERT INTO stock_history (ticker, field, old_value, new_value, source, changed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    let changed = 0;
    // Stocks whose StockScans industry is new or changed — they move basket in Rotation.
    const rotate: string[] = [];
    db.transaction(() => {
      for (const [t, r] of rows) {
        const next = { ...r, tracked: tracked.has(t) ? 1 : 0, active: inactive.has(t) ? 0 : 1 };
        const old = existing.get(t);
        if (!old) {
          if (!next.name) continue;
          ins.run({ ...next, now });
          log.run(t, "added", null, next.industry, next.source, now);
          if (next.source === "stockscans") rotate.push(t);
          added++;
          continue;
        }
        // Add on top: blanks never wipe, weaker sources never replace StockScans labels.
        const oldRank = RANK[old.source as MasterSource] ?? 0;
        const newRank = next.source ? RANK[next.source] : 0;
        const labelsWin = newRank >= oldRank && next.industry != null;
        const merged = {
          ...next,
          name: next.name || String(old.name),
          exchange: next.exchange ?? (old.exchange as string | null),
          sector: labelsWin ? next.sector ?? (old.sector as string | null) : (old.sector as string | null) ?? next.sector,
          industry: labelsWin ? next.industry : (old.industry as string | null) ?? next.industry,
          source: labelsWin ? next.source : ((old.source as MasterSource | null) ?? next.source),
        };
        let diff = false;
        for (const f of FIELDS) {
          const a = old[f] == null ? null : String(old[f]);
          const b = merged[f] == null ? null : String(merged[f]);
          if (a !== b) {
            log.run(t, f, a, b, merged.source, now);
            diff = true;
          }
        }
        if (diff) {
          if (
            merged.source === "stockscans" &&
            (old.industry !== merged.industry || old.source !== "stockscans" || (Number(old.tracked) === 0 && merged.tracked === 1))
          )
            rotate.push(t);
          upd.run({ ...merged, now });
          changed++;
        }
      }
      // Stocks no source mentions any more stay, marked inactive.
      for (const [t, old] of existing)
        if (!rows.has(t) && Number(old.active) === 1) {
          db.prepare(`UPDATE stocks SET active = 0, updated_at = ? WHERE ticker = ?`).run(now, t);
          log.run(t, "active", "1", "0", null, now);
          changed++;
        }
    })();
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM stocks`).get() as { n: number }).n;
    db.prepare(`INSERT INTO sync_runs (at, added, changed, total, signature) VALUES (?, ?, ?, ?, ?)`).run(now, added, changed, total, sig);
    // Only after the first full Rotation sync has been done (it sets the flag).
    if (rotate.length && db.prepare(`SELECT 1 FROM sync_runs WHERE signature = 'rotation-full'`).get()) {
      try {
        const want = new Set(rotate);
        syncRotationFromStockscans(rotationRows(db).filter((r) => want.has(r.ticker)));
      } catch {
        /* next sync retries */
      }
    }
    return { added, changed, total, skipped: false };
  });
}

let lastCheck = 0;
/** Sync if a source changed (at most one check every 30 s). */
export function ensureStockMaster(): void {
  if (Date.now() - lastCheck < 30_000) return;
  lastCheck = Date.now();
  try {
    syncStockMaster();
  } catch {
    /* readers fall back to what is stored */
  }
}

/** Ticker → master row (primary sector › industry). */
/**
 * StockScans sometimes spells one label two ways ("Textile Machinery" /
 * "Textile machinery"). Every page uses the most common spelling.
 */
function canonicalCase(map: Map<string, MasterRow>): void {
  for (const key of ["sector", "industry"] as const) {
    const freq = new Map<string, Map<string, number>>();
    for (const r of map.values()) {
      const v = r[key];
      if (!v) continue;
      const k = v.toLowerCase();
      if (!freq.has(k)) freq.set(k, new Map());
      const f = freq.get(k)!;
      f.set(v, (f.get(v) ?? 0) + 1);
    }
    const best = new Map<string, string>();
    for (const [k, f] of freq) if (f.size > 1) best.set(k, [...f].sort((a, b) => b[1] - a[1])[0]![0]);
    if (!best.size) continue;
    for (const r of map.values()) {
      const v = r[key];
      const b = v ? best.get(v.toLowerCase()) : undefined;
      if (b) r[key] = b;
    }
  }
}

export function loadStockMaster(): Map<string, MasterRow> {
  ensureStockMaster();
  try {
    const map = withMaster(
      (db) =>
        new Map(
          (
            db.prepare(`SELECT ticker, name, exchange, sector, industry, source, tracked, active FROM stocks`).all() as Array<{
              ticker: string;
              name: string;
              exchange: string | null;
              sector: string | null;
              industry: string | null;
              source: MasterSource | null;
              tracked: number;
              active: number;
            }>
          ).map((r) => [r.ticker, { ...r, tracked: !!r.tracked, active: !!r.active }]),
        ),
      true,
    );
    canonicalCase(map);
    return map;
  } catch {
    return new Map();
  }
}

export function stockMasterStatus(): {
  total: number;
  tracked: number;
  by_source: Record<string, number>;
  last_sync: { at: string; added: number; changed: number } | null;
  history: number;
} {
  ensureStockMaster();
  try {
    return withMaster((db) => {
      const t = db.prepare(`SELECT COUNT(*) AS n, SUM(tracked) AS k FROM stocks`).get() as { n: number; k: number | null };
      const by: Record<string, number> = {};
      for (const r of db.prepare(`SELECT COALESCE(source, 'none') AS s, COUNT(*) AS n FROM stocks GROUP BY 1`).all() as Array<{
        s: string;
        n: number;
      }>)
        by[r.s] = r.n;
      const last = db.prepare(`SELECT at, added, changed FROM sync_runs WHERE signature != 'rotation-full' ORDER BY id DESC LIMIT 1`).get() as
        | { at: string; added: number; changed: number }
        | undefined;
      const h = (db.prepare(`SELECT COUNT(*) AS n FROM stock_history`).get() as { n: number }).n;
      return { total: t.n, tracked: t.k ?? 0, by_source: by, last_sync: last ?? null, history: h };
    });
  } catch {
    return { total: 0, tracked: 0, by_source: {}, last_sync: null, history: 0 };
  }
}

// ---- Shared read helper for every page ------------------------------------------------

let labelCache: { at: number; map: Map<string, { sector: string | null; industry: string | null }> } | null = null;

/**
 * Ticker → primary sector › industry (cached 30 s). Every page reads labels
 * through this first and only falls back to older sources when it has none.
 */
export function masterLabels(): Map<string, { sector: string | null; industry: string | null }> {
  if (labelCache && Date.now() - labelCache.at < 30_000) return labelCache.map;
  const map = new Map<string, { sector: string | null; industry: string | null }>();
  for (const [t, m] of loadStockMaster()) if (m.sector || m.industry) map.set(t, { sector: m.sector, industry: m.industry });
  labelCache = { at: Date.now(), map };
  return map;
}

export function masterLabel(ticker: string | null | undefined): { sector: string | null; industry: string | null } | null {
  if (!ticker) return null;
  return masterLabels().get(ticker.trim().toUpperCase()) ?? null;
}

// ---- Sector Rotation baskets ----------------------------------------------------------

function rotationRows(db: Db): Array<{ ticker: string; name: string; market: string; industry: string }> {
  return db
    .prepare(
      `SELECT ticker, name, COALESCE(exchange, 'NSE') AS market, industry FROM stocks
       WHERE source = 'stockscans' AND tracked = 1 AND active = 1 AND industry IS NOT NULL`,
    )
    .all() as Array<{ ticker: string; name: string; market: string; industry: string }>;
}

/**
 * Rotation baskets = StockScans industries: every tracked stock goes to its
 * industry's basket; empty unstarred baskets are dropped. From then on, each
 * master sync moves only stocks whose industry is new or changed.
 */
export function syncRotationFromMaster(): RotationSyncResult {
  ensureStockMaster();
  return withMaster((db) => {
    const res = syncRotationFromStockscans(rotationRows(db), { full: true });
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM stocks`).get() as { n: number }).n;
    db.prepare(`INSERT INTO sync_runs (at, added, changed, total, signature) VALUES (?, 0, ?, ?, 'rotation-full')`).run(
      new Date().toISOString(),
      res.placed + res.moved,
      total,
    );
    return res;
  });
}
