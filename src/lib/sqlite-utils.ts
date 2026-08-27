import { execSync } from "child_process";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export const DATA_DIR = path.join(process.cwd(), "data");

const CLOUD_SYNC_MARKERS = [
  "Mobile Documents/com~apple~CloudDocs",
  "CloudDocs",
  "Dropbox",
  "Google Drive",
  "GoogleDrive",
  "OneDrive",
  "iCloud Drive",
];

const CORRUPT_BAK_DIR = path.join(DATA_DIR, ".corrupt-bak");

export type OpenSqliteOpts = {
  readonly?: boolean;
  fileMustExist?: boolean;
  wal?: boolean;
  busyTimeoutMs?: number;
  quickCheck?: boolean;
  /** Attempt WAL strip + sqlite3 .recover on SQLITE_CORRUPT (default true). */
  autoRecover?: boolean;
};

export type DbCheckResult = { file: string; ok: boolean; detail: string };

export function isSqliteCorrupt(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") return true;
  const msg = String((err as { message?: string }).message || err);
  return /malformed|corrupt|not a database/i.test(msg);
}

export function corruptDbError(name: string, err: unknown): Error {
  return new Error(
    `[db] ${name} is corrupt (${err instanceof Error ? err.message : err}). ` +
      `Run: npm run db:fix -- ${name}`,
  );
}

export function listDataDbs(): string[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter(
      (f) =>
        f.endsWith(".db") &&
        !f.includes(".corrupt.") &&
        !f.includes(".recovered") &&
        !f.startsWith("."),
    )
    .sort()
    .map((f) => path.join(DATA_DIR, f));
}

export function isCloudSyncedPath(p: string): boolean {
  const resolved = path.resolve(p);
  return CLOUD_SYNC_MARKERS.some((m) => resolved.includes(m));
}

/** Warn when data/ lives in iCloud/Dropbox/etc — cloud sync corrupts SQLite mid-write. */
export function warnIfCloudSyncedDataDir(): void {
  if (!isCloudSyncedPath(DATA_DIR)) return;
  console.warn(
    "[db] data/ appears to be in a cloud-synced folder (iCloud/Dropbox/Drive). " +
      "Move the repo out of cloud sync or SQLite files will corrupt again.",
  );
}

function quarantineSidecar(p: string): void {
  if (!fs.existsSync(p)) return;
  try {
    if (!fs.existsSync(CORRUPT_BAK_DIR)) {
      fs.mkdirSync(CORRUPT_BAK_DIR, { recursive: true });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(CORRUPT_BAK_DIR, `${path.basename(p)}.${stamp}`);
    fs.renameSync(p, dest);
  } catch {
    try {
      fs.unlinkSync(p);
    } catch {
      /* another process may hold the inode */
    }
  }
}

/** Remove / quarantine WAL sidecars so the main .db file is self-contained. */
export function removeWalSidecars(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    quarantineSidecar(dbPath + suffix);
  }
}

export function backupCorruptDb(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (!fs.existsSync(CORRUPT_BAK_DIR)) {
    fs.mkdirSync(CORRUPT_BAK_DIR, { recursive: true });
  }
  const backup = path.join(
    CORRUPT_BAK_DIR,
    `${path.basename(dbPath)}.corrupt.${stamp}`,
  );
  fs.copyFileSync(dbPath, backup);
  return backup;
}

function readQuickCheck(db: Database.Database): string {
  const row = db.pragma("quick_check", { simple: true }) as unknown;
  if (Array.isArray(row)) {
    return String((row[0] as { quick_check?: string })?.quick_check ?? row[0]);
  }
  return String(row);
}

function openRaw(
  dbPath: string,
  opts: OpenSqliteOpts,
): Database.Database {
  const readonly = opts.readonly ?? false;
  const db = new Database(dbPath, {
    readonly,
    fileMustExist: opts.fileMustExist ?? readonly,
  });
  db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  if (!readonly && (opts.wal ?? true)) db.pragma("journal_mode = WAL");
  if (readonly) db.pragma("query_only = ON");
  if (opts.quickCheck ?? true) {
    const detail = readQuickCheck(db);
    if (detail !== "ok") {
      db.close();
      throw Object.assign(new Error(detail), { code: "SQLITE_CORRUPT" });
    }
  }
  return db;
}

/**
 * Recover a corrupt .db via `sqlite3 .recover`.
 * Backs up the bad file, writes a recovered copy in place, strips WAL.
 */
export function recoverCorruptDb(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  const backup = backupCorruptDb(dbPath);
  const recovered = path.join(
    DATA_DIR,
    `.recovered-${path.basename(dbPath)}.${process.pid}`,
  );
  try {
    if (fs.existsSync(recovered)) fs.unlinkSync(recovered);
    execSync(
      `sqlite3 ${JSON.stringify(backup)} ".recover" | sqlite3 ${JSON.stringify(recovered)}`,
      { cwd: process.cwd(), shell: "/bin/bash", stdio: "ignore" },
    );
    const check = checkDb(recovered);
    if (!check.ok) {
      if (fs.existsSync(recovered)) fs.unlinkSync(recovered);
      return false;
    }
    fs.renameSync(recovered, dbPath);
    removeWalSidecars(dbPath);
    console.warn(
      `[db] recovered ${path.basename(dbPath)} via sqlite3 .recover (backup in data/.corrupt-bak/)`,
    );
    return true;
  } catch {
    if (fs.existsSync(recovered)) {
      try {
        fs.unlinkSync(recovered);
      } catch {
        /* ignore */
      }
    }
    return false;
  }
}

/**
 * Open a SQLite DB. On corruption: drop WAL sidecars and retry; if still bad,
 * run sqlite3 .recover once, then reopen. Prevents 503s from stale WAL/sync damage.
 */
export function openSqlite(
  dbPath: string,
  opts: OpenSqliteOpts = {},
): Database.Database {
  const autoRecover = opts.autoRecover ?? true;
  try {
    return openRaw(dbPath, opts);
  } catch (err) {
    if (!autoRecover || !isSqliteCorrupt(err)) throw err;

    // 1) Stale/corrupt WAL is the usual cause — strip and retry.
    removeWalSidecars(dbPath);
    try {
      return openRaw(dbPath, opts);
    } catch (err2) {
      if (!isSqliteCorrupt(err2)) throw err2;
    }

    // 2) Main file damaged — rebuild from recoverable pages.
    if (!recoverCorruptDb(dbPath)) {
      throw corruptDbError(path.basename(dbPath), err);
    }
    return openRaw(dbPath, opts);
  }
}

export function openSqliteNamed(
  name: string,
  opts: OpenSqliteOpts = {},
): Database.Database {
  return openSqlite(path.join(DATA_DIR, name), opts);
}

export function checkDb(dbPath: string): DbCheckResult {
  const file = path.basename(dbPath);
  if (!fs.existsSync(dbPath)) {
    return { file, ok: false, detail: "missing" };
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const detail = readQuickCheck(db);
    if (detail === "ok") return { file, ok: true, detail };
    db.close();
    db = null;
    // Retry without WAL — often the main file is fine.
    removeWalSidecars(dbPath);
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const detail2 = readQuickCheck(db);
    return { file, ok: detail2 === "ok", detail: detail2 };
  } catch (err) {
    // One more attempt after WAL strip if open itself failed.
    if (isSqliteCorrupt(err)) {
      try {
        removeWalSidecars(dbPath);
        db?.close();
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const detail = readQuickCheck(db);
        return { file, ok: detail === "ok", detail };
      } catch (err2) {
        return {
          file,
          ok: false,
          detail: err2 instanceof Error ? err2.message : String(err2),
        };
      }
    }
    return {
      file,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

export function verifyAllDbs(): DbCheckResult[] {
  return listDataDbs().map(checkDb);
}

export function checkpointDb(dbPath: string): DbCheckResult {
  const file = path.basename(dbPath);
  if (!fs.existsSync(dbPath)) {
    return { file, ok: false, detail: "missing" };
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    db.pragma("busy_timeout = 10000");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
    removeWalSidecars(dbPath);
    return checkDb(dbPath);
  } catch (err) {
    if (isSqliteCorrupt(err)) {
      removeWalSidecars(dbPath);
      if (recoverCorruptDb(dbPath)) return checkDb(dbPath);
    }
    return {
      file,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

/** Merge WAL into each .db and drop sidecars — run before copying to another machine. */
export function checkpointAllDbs(): DbCheckResult[] {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return listDataDbs().map(checkpointDb);
}
