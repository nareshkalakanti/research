/**
 * Bulk / block deal SQLite store + smart-money client matching.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { BulkDealRow } from "./nse";
import { bareSymbol, symbolsMatch } from "./nse";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "bulk_deals.db");

import { allSmartMoneyPatterns } from "@/lib/smart-money/investors";

/** Client-name patterns for boutique funds / HNIs (not generic "bulk deal"). */
export const SMART_MONEY_CLIENT_PATTERNS: RegExp[] = [
  ...allSmartMoneyPatterns(),
  /ashish kacholia/i,
  /vijay kedia/i,
  /mukul agrawal/i,
  /whiteoak/i,
  /white oak/i,
  /marcellus/i,
  /a91/i,
  /unifi capital/i,
  /valiant/i,
  /jhunjhunwala/i,
  /dolly khanna/i,
  /porinju/i,
  /\bpms\b/i,
  /\baif\b/i,
  /portfolio manag/i,
  /alternative investment/i,
];

export type StoredDeal = BulkDealRow & {
  id: number;
  smart_money: boolean;
  matched_pattern: string | null;
};

function openDb(): Database.Database {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      security_name TEXT,
      client_name TEXT NOT NULL,
      side TEXT,
      quantity REAL,
      price REAL,
      deal_type TEXT NOT NULL,
      exchange TEXT NOT NULL DEFAULT 'NSE',
      smart_money INTEGER NOT NULL DEFAULT 0,
      matched_pattern TEXT,
      fetched_at TEXT NOT NULL,
      UNIQUE(trade_date, symbol, client_name, side, deal_type, quantity, price)
    );
    CREATE INDEX IF NOT EXISTS idx_deals_symbol ON deals(symbol);
    CREATE INDEX IF NOT EXISTS idx_deals_date ON deals(trade_date);
    CREATE INDEX IF NOT EXISTS idx_deals_smart ON deals(smart_money);
  `);
  return db;
}

export function matchSmartMoneyClient(clientName: string): string | null {
  const name = clientName.trim();
  if (!name) return null;
  for (const re of SMART_MONEY_CLIENT_PATTERNS) {
    const m = name.match(re);
    if (m) return m[0]!;
  }
  return null;
}

export function retagSmartMoneyDeals(): number {
  const db = openDb();
  try {
    const rows = db
      .prepare(`SELECT id, client_name FROM deals`)
      .all() as Array<{ id: number; client_name: string }>;
    const upd = db.prepare(
      `UPDATE deals SET smart_money = ?, matched_pattern = ? WHERE id = ?`,
    );
    let changed = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const matched = matchSmartMoneyClient(r.client_name);
        const sm = matched ? 1 : 0;
        const info = upd.run(sm, matched, r.id);
        if (info.changes > 0) changed += 1;
      }
    });
    tx();
    return changed;
  } finally {
    db.close();
  }
}

export function upsertDeals(rows: BulkDealRow[]): {
  inserted: number;
  total: number;
} {
  const db = openDb();
  let inserted = 0;
  try {
    const stmt = db.prepare(`
      INSERT INTO deals (
        trade_date, symbol, security_name, client_name, side,
        quantity, price, deal_type, exchange, smart_money,
        matched_pattern, fetched_at
      ) VALUES (
        @trade_date, @symbol, @security_name, @client_name, @side,
        @quantity, @price, @deal_type, @exchange, @smart_money,
        @matched_pattern, @fetched_at
      )
      ON CONFLICT(trade_date, symbol, client_name, side, deal_type, quantity, price)
      DO UPDATE SET
        security_name = excluded.security_name,
        smart_money = excluded.smart_money,
        matched_pattern = excluded.matched_pattern,
        fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction((batch: BulkDealRow[]) => {
      for (const r of batch) {
        const matched = matchSmartMoneyClient(r.client_name);
        const info = stmt.run({
          trade_date: r.trade_date,
          symbol: bareSymbol(r.symbol),
          security_name: r.security_name,
          client_name: r.client_name,
          side: r.side,
          quantity: r.quantity,
          price: r.price,
          deal_type: r.deal_type,
          exchange: r.exchange,
          smart_money: matched ? 1 : 0,
          matched_pattern: matched,
          fetched_at: r.fetched_at,
        });
        if (info.changes > 0) inserted += 1;
      }
    });
    tx(rows);
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM deals`).get() as { n: number }
    ).n;
    return { inserted, total };
  } finally {
    db.close();
  }
}

export function listDeals(opts?: {
  days?: number;
  symbol?: string;
  smartOnly?: boolean;
  dealType?: "bulk" | "block";
  limit?: number;
}): StoredDeal[] {
  const db = openDb();
  try {
    const days = opts?.days ?? 90;
    const limit = Math.min(opts?.limit ?? 500, 2000);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let sql = `
      SELECT * FROM deals
      WHERE trade_date >= ?
    `;
    const params: unknown[] = [cutoffStr];

    if (opts?.smartOnly) {
      sql += ` AND smart_money = 1`;
    }
    if (opts?.dealType) {
      sql += ` AND deal_type = ?`;
      params.push(opts.dealType);
    }
    sql += ` ORDER BY trade_date DESC, symbol ASC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as Array<
      BulkDealRow & {
        id: number;
        smart_money: number;
        matched_pattern: string | null;
      }
    >;

    let out = rows.map((r) => ({
      ...r,
      smart_money: r.smart_money === 1,
    }));

    if (opts?.symbol) {
      const sym = opts.symbol;
      out = out.filter((d) => symbolsMatch(d.symbol, sym));
    }

    return out;
  } finally {
    db.close();
  }
}

export function dealsForSymbol(
  symbol: string,
  days = 90,
): StoredDeal[] {
  const all = listDeals({ days, limit: 2000 });
  return all.filter((d) => symbolsMatch(d.symbol, symbol));
}

export function smartMoneyHitsForSymbol(
  symbol: string,
  days = 90,
): {
  flag: boolean;
  keywords: string[];
  deals: StoredDeal[];
} {
  const deals = dealsForSymbol(symbol, days).filter((d) => d.smart_money);
  const keywords = [
    ...new Set(
      deals
        .map((d) => d.matched_pattern || d.client_name)
        .filter(Boolean),
    ),
  ];
  return {
    flag: deals.length > 0,
    keywords,
    deals,
  };
}

export function dealStats(): {
  total: number;
  smart: number;
  latest_date: string | null;
} {
  const db = openDb();
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN smart_money = 1 THEN 1 ELSE 0 END) AS smart,
                MAX(trade_date) AS latest_date
         FROM deals`,
      )
      .get() as {
      total: number;
      smart: number | null;
      latest_date: string | null;
    };
    return {
      total: row.total,
      smart: row.smart ?? 0,
      latest_date: row.latest_date,
    };
  } finally {
    db.close();
  }
}
