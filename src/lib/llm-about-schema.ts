import { openSqliteNamed } from "./sqlite-utils";

let schemaEnsured = false;

/** Add llm_about columns to company_about.db (idempotent). */
export function ensureLlmAboutSchema(): boolean {
  if (schemaEnsured) return false;
  let migrated = false;
  const db = openSqliteNamed("company_about.db", { readonly: false, wal: true });
  try {
    const cols = db
      .prepare(`PRAGMA table_info(company_about)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("llm_about")) {
      db.exec(`ALTER TABLE company_about ADD COLUMN llm_about TEXT`);
      migrated = true;
    }
    if (!names.has("has_llm_about")) {
      db.exec(
        `ALTER TABLE company_about ADD COLUMN has_llm_about INTEGER NOT NULL DEFAULT 0`,
      );
      migrated = true;
    }
    if (!names.has("llm_about_at")) {
      db.exec(`ALTER TABLE company_about ADD COLUMN llm_about_at TEXT`);
      migrated = true;
    }
  } finally {
    db.close();
  }
  schemaEnsured = true;
  return migrated;
}

export function resetLlmAboutSchemaCache(): void {
  schemaEnsured = false;
}
