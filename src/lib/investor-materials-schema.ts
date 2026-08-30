import fs from "fs";
import path from "path";
import { openSqliteNamed } from "./sqlite-utils";

const DATA_DIR = path.join(process.cwd(), "data");

let ensured = false;

/** Concall / PPT / transcript text for Business LLM briefs (company_about.db). */
export function ensureInvestorMaterialsSchema(): boolean {
  if (ensured) return false;

  let migrated = false;
  const aboutPath = path.join(DATA_DIR, "company_about.db");
  if (!fs.existsSync(aboutPath)) {
    ensured = true;
    return migrated;
  }

  const db = openSqliteNamed("company_about.db", { readonly: false, wal: true });
  try {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='investor_materials'`,
      )
      .all() as Array<{ name: string }>;
    if (!tables.length) {
      db.exec(`
        CREATE TABLE investor_materials (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticker TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'concall',
          title TEXT NOT NULL DEFAULT '',
          period TEXT,
          source_url TEXT,
          raw_text TEXT NOT NULL,
          brief_text TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_investor_materials_ticker ON investor_materials(ticker);
      `);
      migrated = true;
    }
  } finally {
    db.close();
  }

  ensured = true;
  return migrated;
}
