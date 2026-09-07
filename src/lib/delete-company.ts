import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { invalidateCompanyCache } from "./db";
import { deleteAttachmentsForTicker } from "./note-attachments";
import { deleteNote } from "./notes";
import { resetScrapeForTicker } from "./scraper-store";
import { DATA_DIR } from "./sqlite-utils";
import { canonicalTicker } from "./ticker-aliases";

function deleteFromDb(
  file: string,
  sql: string,
  ticker: string,
): number {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return 0;
  const db = new Database(p);
  try {
    db.pragma("busy_timeout = 5000");
    const info = db.prepare(sql).run(ticker);
    return Number(info.changes ?? 0);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

function deleteSignals(ticker: string): void {
  const p = path.join(DATA_DIR, "signals.db");
  if (!fs.existsSync(p)) return;
  const db = new Database(p);
  try {
    db.pragma("busy_timeout = 5000");
    const tables = [
      "bb_signals",
      "tq_signals",
      "ema_signals",
      "ath_signals",
      "high52_signals",
      "mom_signals",
      "mrsi_signals",
      "scan_checked",
    ];
    for (const t of tables) {
      try {
        db.prepare(`DELETE FROM ${t} WHERE UPPER(ticker) = ?`).run(ticker);
      } catch {
        /* table may not exist */
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Remove a ticker from local research DBs (about, scrape, metrics, signals, notes, etc.).
 * Does not touch remote listings — only our caches.
 */
export function deleteCompanyEverywhere(tickerRaw: string): {
  ok: boolean;
  ticker: string;
  removed: Record<string, number>;
} {
  const ticker = canonicalTicker(tickerRaw) || tickerRaw.trim().toUpperCase();
  if (!ticker || ticker.length < 1) {
    return { ok: false, ticker: "", removed: {} };
  }

  const removed: Record<string, number> = {};

  removed.company_about = deleteFromDb(
    "company_about.db",
    `DELETE FROM company_about WHERE UPPER(ticker) = ?`,
    ticker,
  );

  removed.classifications = deleteFromDb(
    "classifications.db",
    `DELETE FROM classifications WHERE UPPER(ticker) = ?`,
    ticker,
  );

  try {
    resetScrapeForTicker(ticker);
    removed.scrape = 1;
  } catch {
    removed.scrape = 0;
  }

  removed.metrics = deleteFromDb(
    "metrics.db",
    `DELETE FROM stock_metrics WHERE UPPER(ticker) = ?`,
    ticker,
  );

  removed.quarter_metrics = deleteFromDb(
    "metrics.db",
    `DELETE FROM quarter_metrics WHERE UPPER(ticker) = ?`,
    ticker,
  );

  try {
    deleteSignals(ticker);
    removed.signals = 1;
  } catch {
    removed.signals = 0;
  }

  try {
    deleteNote(ticker);
    removed.notes = 1;
  } catch {
    removed.notes = 0;
  }

  try {
    removed.attachments = deleteAttachmentsForTicker(ticker);
  } catch {
    removed.attachments = 0;
  }

  removed.board_seats = deleteFromDb(
    "governance.db",
    `DELETE FROM board_seats WHERE UPPER(ticker) = ?`,
    ticker,
  );

  removed.fund_watchlists = deleteFromDb(
    "fund_watchlists.db",
    `DELETE FROM fund_watchlists WHERE UPPER(ticker) = ?`,
    ticker,
  );

  removed.holdings = deleteFromDb(
    "holdings.db",
    `DELETE FROM holdings WHERE UPPER(ticker) = ?`,
    ticker,
  );

  removed.edge = deleteFromDb(
    "edge.db",
    `DELETE FROM edge WHERE UPPER(ticker) = ?`,
    ticker,
  );

  removed.soic = deleteFromDb(
    "soic.db",
    `DELETE FROM soic WHERE UPPER(ticker) = ?`,
    ticker,
  );

  removed.concall_drift = deleteFromDb(
    "strategy.db",
    `DELETE FROM concall_drift_events WHERE UPPER(ticker) = ?`,
    ticker,
  );
  deleteFromDb(
    "strategy.db",
    `DELETE FROM strategy_scan_log WHERE UPPER(ticker) = ?`,
    ticker,
  );

  removed.investor_materials = deleteFromDb(
    "company_about.db",
    `DELETE FROM investor_materials WHERE UPPER(ticker) = ?`,
    ticker,
  );

  removed.index_constituents = deleteFromDb(
    "index_constituents.db",
    `DELETE FROM index_constituents WHERE UPPER(ticker) = ?`,
    ticker,
  );

  invalidateCompanyCache();
  return { ok: true, ticker, removed };
}
