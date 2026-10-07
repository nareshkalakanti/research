import type Database from "better-sqlite3";
import { openSqliteNamed } from "./sqlite-utils";
import { migrateValuepickr, VALUEPICKR_DB } from "./valuepickr-schema";

export function openValuepickr(opts?: { readonly?: boolean }): Database.Database {
  const db = openSqliteNamed(VALUEPICKR_DB, {
    readonly: opts?.readonly ?? false,
    wal: false,
  });
  if (!opts?.readonly) migrateValuepickr(db);
  return db;
}

export function vpMetaGet(db: Database.Database, k: string): string | null {
  try {
    const row = db.prepare("SELECT v FROM vp_meta WHERE k = ?").get(k) as
      | { v: string }
      | undefined;
    return row?.v ?? null;
  } catch {
    return null;
  }
}

export function vpMetaSet(db: Database.Database, k: string, v: string): void {
  db.prepare(
    "INSERT INTO vp_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
  ).run(k, v);
}
