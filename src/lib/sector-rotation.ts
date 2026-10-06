/**
 * User-defined sectors for the rotation board — data/sector_rotation.db
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "sector_rotation.db");

export type SectorMember = {
  ticker: string;
  name: string;
  market: string;
};

export type RotationSector = {
  id: string;
  label: string;
  starred: boolean;
  members: SectorMember[];
};

function collapseSectorLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim();
}

function labelKey(label: string): string {
  return collapseSectorLabel(label).toLowerCase();
}

function foldDuplicateSectors(db: Database.Database): void {
  const heads = db
    .prepare(
      `SELECT id, label, created_at FROM sectors ORDER BY created_at, id`,
    )
    .all() as Array<{ id: string; label: string; created_at: string }>;
  const keep = new Map<string, string>();
  for (const h of heads) {
    const k = labelKey(h.label);
    if (!k) continue;
    const winner = keep.get(k);
    if (!winner) {
      keep.set(k, h.id);
      continue;
    }
    db.prepare(
      `INSERT INTO sector_members (sector_id, ticker, name, market, updated_at)
       SELECT ?, ticker, name, market, updated_at FROM sector_members WHERE sector_id = ?
       ON CONFLICT(sector_id, ticker) DO NOTHING`,
    ).run(winner, h.id);
    db.prepare(`DELETE FROM sector_members WHERE sector_id = ?`).run(h.id);
    db.prepare(`DELETE FROM sectors WHERE id = ?`).run(h.id);
  }
  const tickers = db
    .prepare(
      `SELECT UPPER(ticker) AS ticker FROM sector_members GROUP BY UPPER(ticker) HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ ticker: string }>;
  for (const row of tickers) {
    const places = db
      .prepare(
        `SELECT m.sector_id AS id FROM sector_members m
         JOIN sectors s ON s.id = m.sector_id
         WHERE UPPER(m.ticker) = ?
         ORDER BY s.created_at, s.id`,
      )
      .all(row.ticker) as Array<{ id: string }>;
    const keepId = places[0]?.id;
    if (!keepId || places.length < 2) continue;
    db.prepare(
      `DELETE FROM sector_members WHERE UPPER(ticker) = ? AND sector_id != ?`,
    ).run(row.ticker, keepId);
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS sectors_label_nocase ON sectors(label COLLATE NOCASE)`,
  );
}

function openWrite(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sectors (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sector_members (
      sector_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      name TEXT,
      market TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (sector_id, ticker)
    );
  `);
  const cols = db
    .prepare(`PRAGMA table_info(sectors)`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "starred")) {
    db.exec(`ALTER TABLE sectors ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`);
  }
  foldDuplicateSectors(db);
  return db;
}

function openRead(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

function newId(): string {
  return `sec-${Date.now().toString(36)}`;
}

function loadSectorsFrom(db: Database.Database): RotationSector[] {
  const heads = db
    .prepare(
      `SELECT id, label, COALESCE(starred, 0) AS starred FROM sectors
       ORDER BY created_at, label COLLATE NOCASE`,
    )
    .all() as Array<{ id: string; label: string; starred: number }>;
  const mems = db
    .prepare(
      `SELECT sector_id, ticker, name, market FROM sector_members
       ORDER BY updated_at, ticker COLLATE NOCASE`,
    )
    .all() as Array<{
      sector_id: string;
      ticker: string;
      name: string | null;
      market: string | null;
    }>;
  const by = new Map<string, SectorMember[]>();
  for (const m of mems) {
    const t = (m.ticker || "").toUpperCase();
    if (!t) continue;
    const list = by.get(m.sector_id) ?? [];
    if (list.some((x) => x.ticker === t)) continue;
    list.push({
      ticker: t,
      name: (m.name || t).trim() || t,
      market: (m.market || "NSE").trim() || "NSE",
    });
    by.set(m.sector_id, list);
  }
  return heads.map((h) => ({
    id: h.id,
    label: h.label,
    starred: Boolean(h.starred),
    members: by.get(h.id) ?? [],
  }));
}

export function listRotationSectors(): RotationSector[] {
  const migrate = openWrite();
  migrate.close();
  const db = openRead();
  if (!db) return [];
  try {
    return loadSectorsFrom(db);
  } finally {
    db.close();
  }
}

export function getRotationSector(id: string): RotationSector | null {
  const want = (id || "").trim();
  if (!want) return null;
  return listRotationSectors().find((s) => s.id === want) ?? null;
}

export function createRotationSector(label: string): RotationSector {
  const name = collapseSectorLabel(label);
  if (name.length < 2) throw new Error("Name the sector (2+ characters)");
  const db = openWrite();
  try {
    const have = db
      .prepare(`SELECT id FROM sectors WHERE label = ? COLLATE NOCASE`)
      .get(name) as { id: string } | undefined;
    if (have?.id) {
      return getRotationSector(have.id)!;
    }
    const id = newId();
    try {
      db.prepare(
        `INSERT INTO sectors (id, label, created_at) VALUES (?, ?, ?)`,
      ).run(id, name, new Date().toISOString());
    } catch {
      const again = db
        .prepare(`SELECT id FROM sectors WHERE label = ? COLLATE NOCASE`)
        .get(name) as { id: string } | undefined;
      if (again?.id) return getRotationSector(again.id)!;
      throw new Error("Could not create sector");
    }
    return { id, label: name, starred: false, members: [] };
  } finally {
    db.close();
  }
}

export function renameRotationSector(id: string, label: string): void {
  const name = collapseSectorLabel(label);
  if (name.length < 2) throw new Error("Name the sector (2+ characters)");
  const db = openWrite();
  try {
    const clash = db
      .prepare(
        `SELECT id FROM sectors WHERE label = ? COLLATE NOCASE AND id != ?`,
      )
      .get(name, id) as { id: string } | undefined;
    if (clash?.id) {
      db.prepare(
        `INSERT INTO sector_members (sector_id, ticker, name, market, updated_at)
         SELECT ?, ticker, name, market, updated_at FROM sector_members WHERE sector_id = ?
         ON CONFLICT(sector_id, ticker) DO NOTHING`,
      ).run(clash.id, id);
      db.prepare(`DELETE FROM sector_members WHERE sector_id = ?`).run(id);
      db.prepare(`DELETE FROM sectors WHERE id = ?`).run(id);
      return;
    }
    const info = db
      .prepare(`UPDATE sectors SET label = ? WHERE id = ?`)
      .run(name, id);
    if (!info.changes) throw new Error("Sector not found");
  } finally {
    db.close();
  }
}

export function setRotationStarred(id: string, starred: boolean): void {
  const db = openWrite();
  try {
    const info = db
      .prepare(`UPDATE sectors SET starred = ? WHERE id = ?`)
      .run(starred ? 1 : 0, id);
    if (!info.changes) throw new Error("Sector not found");
  } finally {
    db.close();
  }
}

export function deleteRotationSector(id: string): void {
  const db = openWrite();
  try {
    db.prepare(`DELETE FROM sector_members WHERE sector_id = ?`).run(id);
    db.prepare(`DELETE FROM sectors WHERE id = ?`).run(id);
  } finally {
    db.close();
  }
}

export function addRotationMember(
  sectorId: string,
  member: SectorMember,
): void {
  const t = (member.ticker || "").trim().toUpperCase();
  if (!t) throw new Error("ticker required");
  const db = openWrite();
  try {
    const row = db
      .prepare(`SELECT id FROM sectors WHERE id = ?`)
      .get(sectorId) as { id: string } | undefined;
    if (!row) throw new Error("Sector not found");
    db.prepare(
      `DELETE FROM sector_members WHERE UPPER(ticker) = ? AND sector_id != ?`,
    ).run(t, sectorId);
    db.prepare(
      `INSERT INTO sector_members (sector_id, ticker, name, market, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sector_id, ticker) DO UPDATE SET
         name = excluded.name,
         market = excluded.market,
         updated_at = excluded.updated_at`,
    ).run(
      sectorId,
      t,
      (member.name || t).trim() || t,
      (member.market || "NSE").trim() || "NSE",
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

export function removeRotationMember(sectorId: string, ticker: string): void {
  const t = ticker.trim().toUpperCase();
  const db = openWrite();
  try {
    db.prepare(
      `DELETE FROM sector_members WHERE sector_id = ? AND UPPER(ticker) = ?`,
    ).run(sectorId, t);
  } finally {
    db.close();
  }
}

export function replaceRotationMembers(
  sectorId: string,
  members: SectorMember[],
): void {
  const db = openWrite();
  try {
    const row = db
      .prepare(`SELECT id FROM sectors WHERE id = ?`)
      .get(sectorId) as { id: string } | undefined;
    if (!row) throw new Error("Sector not found");
    db.prepare(`DELETE FROM sector_members WHERE sector_id = ?`).run(sectorId);
  } finally {
    db.close();
  }
  for (const m of members) addRotationMember(sectorId, m);
}

export function mergeRotationSectorByLabel(
  label: string,
  members: SectorMember[],
): RotationSector {
  const name = collapseSectorLabel(label);
  const have = listRotationSectors().find(
    (s) => s.label.toLowerCase() === name.toLowerCase(),
  );
  const id = have?.id ?? createRotationSector(name).id;
  if (have && have.label !== name) renameRotationSector(id, name);
  for (const m of members) addRotationMember(id, m);
  return getRotationSector(id)!;
}

export function upsertRotationSectorByLabel(
  label: string,
  members: SectorMember[],
): RotationSector {
  const name = collapseSectorLabel(label);
  const have = listRotationSectors().find(
    (s) => s.label.toLowerCase() === name.toLowerCase(),
  );
  const id = have?.id ?? createRotationSector(name).id;
  if (have && have.label !== name) renameRotationSector(id, name);
  replaceRotationMembers(id, members);
  return getRotationSector(id)!;
}
