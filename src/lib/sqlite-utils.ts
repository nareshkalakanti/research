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

export type OpenSqliteOpts = {
  readonly?: boolean;
  fileMustExist?: boolean;
  wal?: boolean;
  busyTimeoutMs?: number;
  quickCheck?: boolean;
};

export type DbCheckResult = { file: string; ok: boolean; detail: string };

export function isSqliteCorrupt(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") return true;
  const msg = String((err as { message?: string }).message || err);
  return /malformed|corrupt/i.test(msg);
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
    .filter((f) => f.endsWith(".db"))
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

/** Remove WAL sidecars so the main .db file is self-contained (safe to copy / git commit). */
export function removeWalSidecars(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    const p = dbPath + suffix;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* another process may still hold the inode */
    }
  }
}

export function backupCorruptDb(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.corrupt.${stamp}`;
  fs.copyFileSync(dbPath, backup);
  return backup;
}

export function openSqlite(
  dbPath: string,
  opts: OpenSqliteOpts = {},
): Database.Database {
  const readonly = opts.readonly ?? false;
  const db = new Database(dbPath, {
    readonly,
    fileMustExist: opts.fileMustExist ?? readonly,
  });
  db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  if (!readonly && (opts.wal ?? true)) db.pragma("journal_mode = WAL");
  if (readonly) db.pragma("query_only = ON");
  if (opts.quickCheck ?? true) db.pragma("quick_check");
  return db;
}

export function openSqliteNamed(
  name: string,
  opts: OpenSqliteOpts = {},
): Database.Database {
  const dbPath = path.join(DATA_DIR, name);
  try {
    return openSqlite(dbPath, opts);
  } catch (err) {
    if (isSqliteCorrupt(err)) throw corruptDbError(name, err);
    throw err;
  }
}

function readQuickCheck(db: Database.Database): string {
  const row = db.pragma("quick_check", { simple: true }) as unknown;
  if (Array.isArray(row)) {
    return String((row[0] as { quick_check?: string })?.quick_check ?? row[0]);
  }
  return String(row);
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
    return { file, ok: detail === "ok", detail };
  } catch (err) {
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
  } finally {
    db?.close();
  }
}

/** Merge WAL into each .db and drop sidecars — run before copying to another machine. */
export function checkpointAllDbs(): DbCheckResult[] {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return listDataDbs().map(checkpointDb);
}
