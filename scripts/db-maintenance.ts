/**
 * SQLite maintenance for data/*.db — verify integrity, checkpoint WAL, recover corrupt files.
 *
 * Before copying this repo to another machine:
 *   npm run db:prepare-sync
 *
 * After copying or if you see "database disk image is malformed":
 *   npm run db:verify
 *   npm run db:fix-all
 *
 * Never copy *.db-wal / *.db-shm between machines. Only copy checkpointed *.db files
 * (or use git — sidecars are gitignored; committed .db files are self-contained).
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import {
  backupCorruptDb,
  checkDb,
  checkpointAllDbs,
  DATA_DIR,
  removeWalSidecars,
  verifyAllDbs,
  warnIfCloudSyncedDataDir,
} from "../src/lib/sqlite-utils";

function basename(p: string): string {
  return path.basename(p);
}

function gitTrackedDbPath(file: string): boolean {
  try {
    execSync(`git cat-file -e HEAD:data/${file}`, {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function restoreFromGit(dbPath: string): boolean {
  const file = basename(dbPath);
  if (!gitTrackedDbPath(file)) return false;
  const tmp = path.join(DATA_DIR, `.restore-${file}`);
  try {
    execSync(`git show HEAD:data/${file} > ${JSON.stringify(tmp)}`, {
      cwd: process.cwd(),
      shell: "/bin/bash",
    });
    const check = checkDb(tmp);
    if (!check.ok) {
      fs.unlinkSync(tmp);
      return false;
    }
    fs.renameSync(tmp, dbPath);
    removeWalSidecars(dbPath);
    return true;
  } catch {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    return false;
  }
}

function recoverWithSqliteCli(dbPath: string, outPath: string): boolean {
  try {
    execSync(
      `sqlite3 ${JSON.stringify(dbPath)} ".recover" | sqlite3 ${JSON.stringify(outPath)}`,
      { cwd: process.cwd(), shell: "/bin/bash", stdio: "ignore" },
    );
    return checkDb(outPath).ok;
  } catch {
    return false;
  }
}

function fixDb(name: string, quiet = false): boolean {
  const dbPath = path.join(DATA_DIR, name.endsWith(".db") ? name : `${name}.db`);
  if (!fs.existsSync(dbPath)) {
    if (!quiet) console.error(`missing ${basename(dbPath)}`);
    return false;
  }

  const before = checkDb(dbPath);
  if (before.ok) {
    if (!quiet) console.log(`${basename(dbPath)} — already ok`);
    return true;
  }

  if (!quiet) {
    console.warn(`${basename(dbPath)} — corrupt (${before.detail.slice(0, 120)})`);
  }
  const backup = backupCorruptDb(dbPath);
  if (!quiet) console.log(`backed up → ${basename(backup)}`);

  const recovered = path.join(DATA_DIR, `.recovered-${basename(dbPath)}`);
  if (recoverWithSqliteCli(backup, recovered)) {
    fs.renameSync(recovered, dbPath);
    removeWalSidecars(dbPath);
    if (!quiet) console.log(`recovered via sqlite3 .recover → ${basename(dbPath)}`);
    return true;
  }
  if (fs.existsSync(recovered)) fs.unlinkSync(recovered);

  if (restoreFromGit(dbPath)) {
    if (!quiet) console.log(`restored from git HEAD → ${basename(dbPath)}`);
    return true;
  }

  if (!quiet) {
    console.error(
      `could not fix ${basename(dbPath)} — manual recovery needed (backup kept)`,
    );
  }
  return false;
}

function cmdVerify(): number {
  const results = verifyAllDbs();
  if (!results.length) {
    console.log("no *.db files in data/");
    return 0;
  }
  let bad = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`ok   ${r.file}`);
    } else {
      console.log(`FAIL ${r.file}: ${r.detail.slice(0, 200)}`);
      bad += 1;
    }
  }
  if (bad) {
    console.log(`\n${bad} corrupt — run: npm run db:fix-all`);
    return 1;
  }
  return 0;
}

function cmdCheckpoint(): void {
  for (const r of checkpointAllDbs()) {
    if (r.ok) console.log(`checkpoint ${r.file} — ok`);
    else console.warn(`checkpoint ${r.file} — ${r.detail}`);
  }
}

function cmdFixAll(): number {
  const bad = verifyAllDbs().filter((r) => !r.ok);
  if (!bad.length) {
    console.log("all databases ok");
    return 0;
  }
  let fixed = 0;
  for (const r of bad) {
    if (fixDb(r.file)) fixed += 1;
  }
  const remaining = verifyAllDbs().filter((r) => !r.ok);
  if (remaining.length) {
    console.error(`${remaining.length} still corrupt after fix-all`);
    return 1;
  }
  console.log(`fixed ${fixed} database(s)`);
  return 0;
}

/** Runs before `npm run dev` — warn, auto-fix corrupt dbs, fail if still broken. */
function cmdPrepareDev(): number {
  warnIfCloudSyncedDataDir();
  const bad = verifyAllDbs().filter((r) => !r.ok);
  if (bad.length) {
    console.warn(`[db] ${bad.length} corrupt — auto-fixing…`);
    for (const r of bad) {
      if (!fixDb(r.file, true)) {
        console.error(`[db] could not fix ${r.file} — run: npm run db:fix -- ${r.file}`);
        return 1;
      }
      console.log(`[db] fixed ${r.file}`);
    }
  }
  return 0;
}

/** Checkpoint all DBs before copying repo to another machine or pushing to git. */
function cmdPrepareSync(): number {
  warnIfCloudSyncedDataDir();
  cmdCheckpoint();
  return cmdVerify();
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "verify":
      process.exit(cmdVerify());
      break;
    case "checkpoint":
      cmdCheckpoint();
      break;
    case "prepare-dev":
      process.exit(cmdPrepareDev());
      break;
    case "prepare-sync":
      process.exit(cmdPrepareSync());
      break;
    case "fix-all":
      process.exit(cmdFixAll());
      break;
    case "fix": {
      const target = rest[0];
      if (!target) {
        console.error("usage: npm run db:fix -- company_about.db");
        process.exit(1);
      }
      process.exit(fixDb(target) ? 0 : 1);
      break;
    }
    default:
      console.log(`usage:
  npm run db:verify
  npm run db:checkpoint
  npm run db:prepare-sync
  npm run db:fix-all
  npm run db:fix -- company_about.db`);
      process.exit(cmd ? 1 : 0);
  }
}

main();
