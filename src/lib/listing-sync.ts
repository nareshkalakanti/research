/**
 * Daily listing sync — keeps the app universe in step with the exchanges.
 *
 * Official sources (same fetchers the manual scripts use):
 *   NSE main  — nsearchives EQUITY_L.csv
 *   NSE SME   — nsearchives SME_EQUITY_L.csv
 *   BSE SME   — BSE List-of-Scrips API, groups M + MT
 *
 * Each run: add missing listings, fix market tags for names that moved board,
 * map renamed tickers by ISIN (moving watchlist / holdings / rotation rows),
 * and mark delisted names in `listing_status` so they drop out of the
 * universe (loadAllCompanies) without deleting any data. A run is skipped
 * entirely when a source list looks truncated (exchange down / blocked).
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  fetchNseMainEquityList,
  fetchNseSmeEquityList,
  isNseRightsEntitlement,
  nseSmeIssuers,
  type NseEquityListRow,
} from "./nse-equity-lists";
import {
  fetchBseSmeListings,
  invalidateBseSmeCacheMap,
  isBseSmeExcluded,
  type BseSmeListing,
} from "./bse-sme";
import { applyNseEquityUniverse } from "./nse-sme-universe";
import { ensureCompanyAboutRow } from "./company-about-write";
import { ensureGovernanceCompanyStub } from "./governance-write";
import { invalidateCompanyCache } from "./db";
import { openSqliteNamed } from "./sqlite-utils";

const DATA_DIR = path.join(process.cwd(), "data");
const ABOUT_PATH = path.join(DATA_DIR, "company_about.db");
const BSE_SME_CACHE = path.join(DATA_DIR, "bse_sme_scrips.json");

/** Below these, a source list is treated as truncated and the run aborts. */
const MIN_ROWS = { nseMain: 2000, nseSme: 400, bseSme: 400 };
/** Auto runs at most this often. */
export const LISTING_SYNC_EVERY_MS = 20 * 60 * 60 * 1000;
/** New NSE main names to board-scan per run (NSE CG filings carry DINs). */
const BOARD_SCAN_PER_RUN = 40;

export type ListingStatus = "delisted" | "renamed";

export type ListingSyncResult = {
  ok: boolean;
  dry_run: boolean;
  skipped?: string;
  official: { nse: number; nse_sme: number; bse_sme: number };
  added: { nse: string[]; nse_sme: string[]; bse_sme: string[] };
  retagged: Array<{ ticker: string; from: string; to: string }>;
  renamed: Array<{ from: string; to: string; moved_rows: number }>;
  delisted: string[];
  relisted: string[];
  /** Same symbol, different company on NSE vs BSE SME — left as is. */
  collisions: string[];
  board_scan?: { tried: number; saved: number };
  at: string;
};

const STATUS_DDL = `
  CREATE TABLE IF NOT EXISTS listing_status (
    ticker TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    new_ticker TEXT,
    isin TEXT,
    detail TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS listing_sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/**
 * company_about.db is shared with Next's cached readers and helpers that
 * strip WAL sidecars — never hold a long-lived handle across helper calls
 * (a held handle's WAL writes were lost mid-run). Open briefly, write,
 * checkpoint into the main file, close.
 */
function withAbout<T>(write: boolean, fn: (db: Database.Database) => T): T {
  const db = openSqliteNamed("company_about.db", {
    readonly: !write,
    wal: true,
    busyTimeoutMs: 8000,
  });
  try {
    const out = fn(db);
    if (write) db.pragma("wal_checkpoint(TRUNCATE)");
    return out;
  } finally {
    db.close();
  }
}

function hasTable(db: Database.Database, name: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name);
}

/** Tickers marked delisted / renamed — excluded from the universe. */
export function inactiveListingTickers(): Set<string> {
  if (!fs.existsSync(ABOUT_PATH)) return new Set();
  try {
    return withAbout(false, (db) =>
      hasTable(db, "listing_status")
        ? new Set(
            (db.prepare(`SELECT UPPER(ticker) AS t FROM listing_status`).all() as Array<{
              t: string;
            }>).map((r) => r.t),
          )
        : new Set<string>(),
    );
  } catch {
    return new Set();
  }
}

export function lastListingSync(): { at: string | null; summary: string | null } {
  if (!fs.existsSync(ABOUT_PATH)) return { at: null, summary: null };
  return withAbout(false, (db) => {
    if (!hasTable(db, "listing_sync_meta")) return { at: null, summary: null };
    const get = (k: string) =>
      (db.prepare(`SELECT value FROM listing_sync_meta WHERE key = ?`).get(k) as
        | { value: string }
        | undefined)?.value ?? null;
    return { at: get("last_run_at"), summary: get("last_summary") };
  });
}

/** Move a renamed ticker's rows in user lists (never overwrite existing). */
function moveTickerRows(from: string, to: string): number {
  let moved = 0;
  const targets: Array<[string, string]> = [
    ["named_watchlists.db", "named_watchlists"],
    ["holdings.db", "holdings"],
    ["sector_rotation.db", "sector_members"],
  ];
  for (const [file, table] of targets) {
    if (!fs.existsSync(path.join(DATA_DIR, file))) continue;
    const db = openSqliteNamed(file, { readonly: false, wal: true });
    try {
      const info = db
        .prepare(`UPDATE OR IGNORE ${table} SET ticker = ? WHERE UPPER(ticker) = ?`)
        .run(to, from);
      moved += Number(info.changes || 0);
    } catch {
      /* table missing / shape differs — skip */
    } finally {
      db.close();
    }
  }
  return moved;
}

function addBseSmeToCache(rows: BseSmeListing[]): void {
  if (!rows.length) return;
  let json: { listings?: BseSmeListing[]; [k: string]: unknown } = {};
  try {
    if (fs.existsSync(BSE_SME_CACHE)) {
      json = JSON.parse(fs.readFileSync(BSE_SME_CACHE, "utf8"));
    }
  } catch {
    json = {};
  }
  const have = new Set((json.listings ?? []).map((r) => r.ticker.toUpperCase()));
  json.listings = [...(json.listings ?? []), ...rows.filter((r) => !have.has(r.ticker))];
  fs.writeFileSync(BSE_SME_CACHE, JSON.stringify(json, null, 1));
  invalidateBseSmeCacheMap();
}

export async function runListingSync(opts?: {
  dryRun?: boolean;
  /** Board-scan newly added NSE names (network; on for auto runs). */
  scanBoards?: boolean;
}): Promise<ListingSyncResult> {
  const dry = !!opts?.dryRun;
  const at = new Date().toISOString();
  const empty: ListingSyncResult = {
    ok: false,
    dry_run: dry,
    official: { nse: 0, nse_sme: 0, bse_sme: 0 },
    added: { nse: [], nse_sme: [], bse_sme: [] },
    retagged: [],
    renamed: [],
    delisted: [],
    relisted: [],
    collisions: [],
    at,
  };

  const [mainRaw, smeRaw, bseSme] = await Promise.all([
    fetchNseMainEquityList().catch(() => [] as NseEquityListRow[]),
    fetchNseSmeEquityList().catch(() => [] as NseEquityListRow[]),
    fetchBseSmeListings().catch(() => [] as BseSmeListing[]),
  ]);
  const main = mainRaw.filter((r) => !isNseRightsEntitlement(r));
  const smeIssuers = nseSmeIssuers(smeRaw);
  const bse = bseSme.filter((r) => !isBseSmeExcluded(r.ticker));
  empty.official = { nse: main.length, nse_sme: smeIssuers.length, bse_sme: bse.length };
  if (
    main.length < MIN_ROWS.nseMain ||
    smeIssuers.length < MIN_ROWS.nseSme ||
    bse.length < MIN_ROWS.bseSme
  ) {
    return {
      ...empty,
      skipped: `source list looks truncated (NSE ${main.length}, NSE SME ${smeIssuers.length}, BSE SME ${bse.length}) — no changes`,
    };
  }

  const mainBy = new Map(main.map((r) => [r.ticker.toUpperCase(), r]));
  const smeBy = new Map(smeIssuers.map((r) => [r.ticker.toUpperCase(), r]));
  const bseBy = new Map(bse.map((r) => [r.ticker.toUpperCase(), r]));
  const isinToNse = new Map<string, string>();
  for (const r of [...main, ...smeIssuers]) {
    if (r.isin) isinToNse.set(r.isin, r.ticker.toUpperCase());
  }

  {
    const appMarket = withAbout(false, (db) =>
      new Map(
        (db
          .prepare(`SELECT UPPER(ticker) AS t, TRIM(COALESCE(market,'')) AS m FROM company_about`)
          .all() as Array<{ t: string; m: string }>).map((r) => [r.t, r.m]),
      ),
    );
    const prevStatus = inactiveListingTickers();
    const res: ListingSyncResult = { ...empty, ok: true };

    // Collisions: same symbol is a different company on NSE and BSE SME.
    for (const t of bseBy.keys()) {
      if (mainBy.has(t) || smeBy.has(t)) res.collisions.push(t);
    }
    const collide = new Set(res.collisions);

    // 1) Missing listings.
    for (const [t] of mainBy) if (!appMarket.has(t)) res.added.nse.push(t);
    for (const [t] of smeBy) if (!appMarket.has(t) && !mainBy.has(t)) res.added.nse_sme.push(t);
    for (const [t] of bseBy) if (!appMarket.has(t) && !collide.has(t)) res.added.bse_sme.push(t);

    // 2) Market tags for names that moved board.
    for (const [t, m] of appMarket) {
      if (collide.has(t)) continue;
      const want = mainBy.has(t)
        ? "NSE"
        : smeBy.has(t)
          ? "NSE SME"
          : bseBy.has(t)
            ? "BSE SME"
            : null;
      if (want && want !== m) res.retagged.push({ ticker: t, from: m, to: want });
    }

    // 3) Renames (ISIN) and delistings for names on no official list.
    const govIsin = new Map<string, string>();
    try {
      const g = openSqliteNamed("governance.db", { readonly: true });
      try {
        for (const r of g
          .prepare(`SELECT UPPER(ticker) AS t, isin FROM companies WHERE isin IS NOT NULL AND TRIM(isin) <> ''`)
          .all() as Array<{ t: string; isin: string }>) {
          govIsin.set(r.t, r.isin.trim());
        }
      } finally {
        g.close();
      }
    } catch {
      /* no ISINs — renames fall back to delisted */
    }
    const renameTo = new Map<string, string>();
    for (const [t, m] of appMarket) {
      if (mainBy.has(t) || smeBy.has(t) || bseBy.has(t)) continue;
      // Already marked on an earlier run — nothing new to do.
      if (prevStatus.has(t)) continue;
      // BSE main board isn't covered by a source list — never auto-delist it.
      if (m.toUpperCase() === "BSE") continue;
      const nt = govIsin.get(t) ? isinToNse.get(govIsin.get(t)!) : undefined;
      if (nt && nt !== t) renameTo.set(t, nt);
      else res.delisted.push(t);
    }
    // Back on a list → clear the old status.
    for (const t of prevStatus) {
      if (mainBy.has(t) || smeBy.has(t) || bseBy.has(t)) res.relisted.push(t);
    }

    if (dry) {
      res.renamed = [...renameTo].map(([from, to]) => ({ from, to, moved_rows: 0 }));
      return res;
    }

    // ---- writes ----
    // NSE SME inserts + SME→NSE relabels via the existing universe helper.
    applyNseEquityUniverse({ sme: smeRaw, main: mainRaw });

    for (const t of res.added.nse) {
      const r = mainBy.get(t)!;
      ensureCompanyAboutRow(r.ticker, { name: r.name, market: "NSE" });
      ensureGovernanceCompanyStub({ ticker: r.ticker, name: r.name, market: "NSE", isin: r.isin });
    }
    const newBse: BseSmeListing[] = [];
    for (const t of res.added.bse_sme) {
      const r = bseBy.get(t)!;
      ensureCompanyAboutRow(r.ticker, { name: r.name, market: "BSE SME" });
      ensureGovernanceCompanyStub({ ticker: r.ticker, name: r.name, market: "BSE SME", isin: r.isin });
      newBse.push(r);
    }
    addBseSmeToCache(newBse);

    for (const x of res.retagged) {
      const src = mainBy.get(x.ticker) ?? smeBy.get(x.ticker);
      ensureGovernanceCompanyStub({
        ticker: x.ticker,
        name: src?.name ?? bseBy.get(x.ticker)?.name ?? null,
        market: x.to,
        isin: src?.isin ?? bseBy.get(x.ticker)?.isin ?? null,
      });
    }

    type StatusRow = {
      ticker: string;
      status: ListingStatus;
      new_ticker: string | null;
      isin: string | null;
      detail: string;
      at: string;
    };
    const statusRows: StatusRow[] = [];
    for (const [from, to] of renameTo) {
      if (!appMarket.has(to)) {
        const r = mainBy.get(to) ?? smeBy.get(to);
        if (r) {
          ensureCompanyAboutRow(r.ticker, { name: r.name, market: mainBy.has(to) ? "NSE" : "NSE SME" });
          ensureGovernanceCompanyStub({ ticker: r.ticker, name: r.name, market: mainBy.has(to) ? "NSE" : "NSE SME", isin: r.isin });
        }
      }
      const moved = moveTickerRows(from, to);
      res.renamed.push({ from, to, moved_rows: moved });
      statusRows.push({
        ticker: from,
        status: "renamed" satisfies ListingStatus,
        new_ticker: to,
        isin: govIsin.get(from) ?? null,
        detail: `ISIN now trades as ${to}`,
        at,
      });
    }
    for (const t of res.delisted) {
      statusRows.push({
        ticker: t,
        status: "delisted" satisfies ListingStatus,
        new_ticker: null,
        isin: govIsin.get(t) ?? null,
        detail: "Not on NSE / NSE SME / BSE SME official lists",
        at,
      });
    }
    const summary = `+${res.added.nse.length} NSE · +${res.added.nse_sme.length} NSE SME · +${res.added.bse_sme.length} BSE SME · ${res.retagged.length} retagged · ${res.renamed.length} renamed · ${res.delisted.length} delisted`;
    // One short write: tags, statuses, meta — then checkpoint into the file.
    withAbout(true, (db) => {
      db.exec(STATUS_DDL);
      const setMarket = db.prepare(`UPDATE company_about SET market = ? WHERE UPPER(ticker) = ?`);
      const upsertStatus = db.prepare(
        `INSERT INTO listing_status (ticker, status, new_ticker, isin, detail, updated_at)
         VALUES (@ticker, @status, @new_ticker, @isin, @detail, @at)
         ON CONFLICT(ticker) DO UPDATE SET status=excluded.status,
           new_ticker=excluded.new_ticker, isin=excluded.isin,
           detail=excluded.detail, updated_at=excluded.updated_at`,
      );
      const clear = db.prepare(`DELETE FROM listing_status WHERE UPPER(ticker) = ?`);
      const meta = db.prepare(
        `INSERT INTO listing_sync_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      db.transaction(() => {
        for (const x of res.retagged) setMarket.run(x.to, x.ticker);
        for (const r of statusRows) upsertStatus.run(r);
        for (const t of res.relisted) clear.run(t);
        meta.run("last_run_at", at);
        meta.run("last_summary", summary);
      })();
    });

    // Boards for NSE names that still have none (new listings first run,
    // then whatever is left) — NSE governance filings carry DINs.
    if (opts?.scanBoards) {
      try {
        const { runGovernanceScanBatch } = await import("./governance-scan");
        const scan = await runGovernanceScanBatch({
          market: "NSE",
          ...(res.added.nse.length
            ? { tickers: res.added.nse.slice(0, BOARD_SCAN_PER_RUN) }
            : {}),
          limit: BOARD_SCAN_PER_RUN,
          missingOnly: true,
          concurrency: 2,
        });
        res.board_scan = { tried: scan.tried, saved: scan.saved };
      } catch {
        /* boards fill on later runs / manual DIN tools */
      }
    }

    invalidateCompanyCache();
    return res;
  }
}

let running: Promise<ListingSyncResult> | null = null;
/** In-process: don't retry a skipped / failed run more than every 30 min. */
let lastAttempt = 0;
const RETRY_GAP_MS = 30 * 60 * 1000;

/** Run when the last sync is older than LISTING_SYNC_EVERY_MS (one at a time). */
export async function runListingSyncIfDue(): Promise<ListingSyncResult | null> {
  if (running) return null;
  if (Date.now() - lastAttempt < RETRY_GAP_MS) return null;
  const last = lastListingSync().at;
  if (last && Date.now() - Date.parse(last) < LISTING_SYNC_EVERY_MS) return null;
  lastAttempt = Date.now();
  running = runListingSync({ scanBoards: true }).finally(() => {
    running = null;
  });
  return running;
}
