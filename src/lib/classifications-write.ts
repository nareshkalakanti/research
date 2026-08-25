import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { invalidateCompanyCache } from "./db";

const DATA_DIR = path.join(process.cwd(), "data");
const CLASS_PATH = path.join(DATA_DIR, "classifications.db");

function openClassDb(): Database.Database {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(CLASS_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS classifications (
      ticker TEXT,
      market TEXT,
      sector TEXT,
      industry TEXT,
      sub_sector TEXT
    );
  `);
  return db;
}

export function upsertClassification(
  ticker: string,
  market: string,
  opts: {
    sector: string;
    sub_sector: string;
    industry?: string | null;
  },
): void {
  const key = ticker.toUpperCase();
  const sector = opts.sector.trim();
  const sub_sector = opts.sub_sector.trim();
  if (!sector || !sub_sector) return;

  const db = openClassDb();
  try {
    db.prepare(
      `DELETE FROM classifications WHERE UPPER(ticker) = ? AND market = ?`,
    ).run(key, market);
    db.prepare(
      `INSERT INTO classifications (ticker, market, sector, industry, sub_sector)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      key,
      market,
      sector,
      (opts.industry ?? sub_sector).trim(),
      sub_sector,
    );
  } finally {
    db.close();
  }
  invalidateCompanyCache();
}
