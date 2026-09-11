/**
 * Dedicated SQLite files for MarketIQ / OrderBookIQ / BoardRoomIQ (save + reuse).
 * One-time copy from legacy filenames when the new DB is missing.
 */
import fs from "fs";
import path from "path";
import { DATA_DIR } from "./sqlite-utils";

export const MARKETIQ_DB_FILE = "marketiq.db";
export const ORDERBOOKIQ_DB_FILE = "orderbookiq.db";
export const BOARDROOMIQ_DB_FILE = "boardroomiq.db";

const LEGACY_MARKETIQ = "announcement_screen.db";
const LEGACY_ORDERBOOK = "orderbook_screen.db";

const migrated = new Set<string>();

function migrateOnce(canonical: string, legacy: string): void {
  if (migrated.has(canonical)) return;
  migrated.add(canonical);

  const dest = path.join(DATA_DIR, canonical);
  const src = path.join(DATA_DIR, legacy);
  if (fs.existsSync(dest)) return;
  if (!fs.existsSync(src)) return;

  try {
    fs.copyFileSync(src, dest);
  } catch (err) {
    console.error(
      `[iq-dbs] Could not migrate ${legacy} → ${canonical}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** MarketIQ persistence (`data/marketiq.db`). */
export function marketIqDbFile(): string {
  migrateOnce(MARKETIQ_DB_FILE, LEGACY_MARKETIQ);
  return MARKETIQ_DB_FILE;
}

/** OrderBookIQ persistence (`data/orderbookiq.db`). */
export function orderBookIqDbFile(): string {
  migrateOnce(ORDERBOOKIQ_DB_FILE, LEGACY_ORDERBOOK);
  return ORDERBOOKIQ_DB_FILE;
}

/** BoardRoomIQ persistence (`data/boardroomiq.db`). */
export function boardRoomIqDbFile(): string {
  return BOARDROOMIQ_DB_FILE;
}
