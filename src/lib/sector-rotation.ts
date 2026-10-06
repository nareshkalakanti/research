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
  members: SectorMember[];
};

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
    .prepare(`SELECT id, label FROM sectors ORDER BY created_at, label COLLATE NOCASE`)
    .all() as Array<{ id: string; label: string }>;
  const mems = db
    .prepare(
      `SELECT sector_id, ticker, name, market FROM sector_members
       ORDER BY ticker COLLATE NOCASE`,
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
    members: by.get(h.id) ?? [],
  }));
}

export function listRotationSectors(): RotationSector[] {
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
  const name = label.replace(/\s+/g, " ").trim();
  if (name.length < 2) throw new Error("Name the sector (2+ characters)");
  const db = openWrite();
  try {
    const id = newId();
    db.prepare(`INSERT INTO sectors (id, label, created_at) VALUES (?, ?, ?)`).run(
      id,
      name,
      new Date().toISOString(),
    );
    return { id, label: name, members: [] };
  } finally {
    db.close();
  }
}

export function renameRotationSector(id: string, label: string): void {
  const name = label.replace(/\s+/g, " ").trim();
  if (name.length < 2) throw new Error("Name the sector (2+ characters)");
  const db = openWrite();
  try {
    const info = db
      .prepare(`UPDATE sectors SET label = ? WHERE id = ?`)
      .run(name, id);
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
  const name = label.replace(/\s+/g, " ").trim();
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
  const name = label.replace(/\s+/g, " ").trim();
  const have = listRotationSectors().find(
    (s) => s.label.toLowerCase() === name.toLowerCase(),
  );
  const id = have?.id ?? createRotationSector(name).id;
  if (have && have.label !== name) renameRotationSector(id, name);
  replaceRotationMembers(id, members);
  return getRotationSector(id)!;
}
