import fs from "fs";
import path from "path";
import { openSqliteNamed } from "./sqlite-utils";

const DATA_DIR = path.join(process.cwd(), "data");

let ensured = false;

/** CEO / MD / founded year on company_about.db (idempotent). */
export function ensureWebProfileSchema(): boolean {
  if (ensured) return false;
  const aboutPath = path.join(DATA_DIR, "company_about.db");
  if (!fs.existsSync(aboutPath)) {
    ensured = true;
    return false;
  }
  let migrated = false;
  const db = openSqliteNamed("company_about.db", { readonly: false, wal: true });
  try {
    const cols = db
      .prepare(`PRAGMA table_info(company_about)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const col of ["ceo", "managing_director", "founded_year"] as const) {
      if (!names.has(col)) {
        db.exec(`ALTER TABLE company_about ADD COLUMN ${col} TEXT`);
        migrated = true;
      }
    }
  } finally {
    db.close();
  }
  ensured = true;
  return migrated;
}
