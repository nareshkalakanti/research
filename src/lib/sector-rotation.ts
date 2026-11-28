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
  created_at: string;
  members: SectorMember[];
};

function collapseSectorLabel(label: string): string {
  // "Aerospace & Defence" and "Aerospace and Defence" are the same basket.
  let t = label.replace(/ & /g, " and ").replace(/\s+/g, " ").trim();
  const parts = t
    .split(/\s*[,;|]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0]!.toLowerCase();
    if (parts.every((p) => p.toLowerCase() === first)) t = parts[0]!;
  }
  const lower = t.toLowerCase();
  const maxUnit = Math.min(Math.floor(t.length / 2), 96);
  for (let len = maxUnit; len >= 8; len--) {
    const unit = t.slice(0, len).replace(/[\s,;|/]+$/g, "").trim();
    if (unit.split(/\s+/).length < 2) continue;
    const u = unit.toLowerCase();
    let pos = 0;
    let n = 0;
    while (pos < lower.length) {
      while (pos < lower.length && /[\s,;|/]/.test(lower[pos]!)) pos++;
      if (pos >= lower.length) break;
      if (!lower.startsWith(u, pos)) {
        n = 0;
        break;
      }
      n += 1;
      pos += u.length;
    }
    if (n >= 2 && pos >= lower.length) return unit;
  }
  return t;
}

/** Fold Screener/OCR variants onto one key: hyphens, "Equipments" plural. */
function labelKey(label: string): string {
  return collapseSectorLabel(label)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\s*[-–—]\s*/g, " ")
    .replace(/\bequipments\b/g, "equipment")
    .replace(/\s+/g, " ")
    .trim();
}

/** Prefer an existing basket when Screener says "Welding Equipments" etc. */
function findSectorByLabel(
  sectors: RotationSector[],
  label: string,
): RotationSector | undefined {
  const want = labelKey(label);
  if (!want) return undefined;
  return (
    sectors.find((s) => s.label.toLowerCase() === label.toLowerCase()) ||
    sectors.find((s) => labelKey(s.label) === want)
  );
}

function foldDuplicateSectors(db: Database.Database): void {
  const heads = db
    .prepare(
      `SELECT id, label, created_at FROM sectors ORDER BY created_at, id`,
    )
    .all() as Array<{ id: string; label: string; created_at: string }>;
  const mergeInto = (winnerId: string, loserId: string) => {
    if (winnerId === loserId) return;
    db.prepare(
      `INSERT INTO sector_members (sector_id, ticker, name, market, updated_at)
       SELECT ?, ticker, name, market, updated_at FROM sector_members WHERE sector_id = ?
       ON CONFLICT(sector_id, ticker) DO NOTHING`,
    ).run(winnerId, loserId);
    db.prepare(`DELETE FROM sector_members WHERE sector_id = ?`).run(loserId);
    db.prepare(`DELETE FROM sectors WHERE id = ?`).run(loserId);
  };
  // Collapse "X & Y" / OCR dumps onto a single label before folding dupes.
  // If the cleaned name already exists, merge into that basket (UNIQUE label).
  const byLabel = new Map(heads.map((h) => [h.label.toLowerCase(), h.id]));
  const alive = new Set(heads.map((h) => h.id));
  for (const h of heads) {
    if (!alive.has(h.id)) continue;
    const clean = collapseSectorLabel(h.label);
    if (!clean || clean === h.label) continue;
    const clashId = byLabel.get(clean.toLowerCase());
    if (clashId && clashId !== h.id && alive.has(clashId)) {
      mergeInto(clashId, h.id);
      alive.delete(h.id);
      continue;
    }
    db.prepare(`UPDATE sectors SET label = ? WHERE id = ?`).run(clean, h.id);
    byLabel.delete(h.label.toLowerCase());
    byLabel.set(clean.toLowerCase(), h.id);
    h.label = clean;
  }
  const keep = new Map<string, string>();
  for (const h of heads) {
    if (!alive.has(h.id)) continue;
    const k = labelKey(h.label);
    if (!k) continue;
    const winner = keep.get(k);
    if (!winner) {
      keep.set(k, h.id);
      continue;
    }
    mergeInto(winner, h.id);
    alive.delete(h.id);
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
      `SELECT id, label, COALESCE(starred, 0) AS starred, created_at FROM sectors
       ORDER BY created_at DESC, id DESC`,
    )
    .all() as Array<{
      id: string;
      label: string;
      starred: number;
      created_at: string;
    }>;
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
    created_at: h.created_at,
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
    const createdAt = new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO sectors (id, label, created_at) VALUES (?, ?, ?)`,
      ).run(id, name, createdAt);
    } catch {
      const again = db
        .prepare(`SELECT id FROM sectors WHERE label = ? COLLATE NOCASE`)
        .get(name) as { id: string } | undefined;
      if (again?.id) return getRotationSector(again.id)!;
      throw new Error("Could not create sector");
    }
    return { id, label: name, starred: false, created_at: createdAt, members: [] };
  } finally {
    db.close();
  }
}

/** Returns the surviving sector id (may differ when renaming into an existing label). */
export function renameRotationSector(id: string, label: string): string {
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
      return clash.id;
    }
    const info = db
      .prepare(`UPDATE sectors SET label = ? WHERE id = ?`)
      .run(name, id);
    if (!info.changes) throw new Error("Sector not found");
    return id;
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
  const have = findSectorByLabel(listRotationSectors(), name);
  // Keep the existing basket title when only plural/hyphen differs.
  const id = have?.id ?? createRotationSector(name).id;
  for (const m of members) addRotationMember(id, m);
  return getRotationSector(id)!;
}

export function upsertRotationSectorByLabel(
  label: string,
  members: SectorMember[],
): RotationSector {
  const name = collapseSectorLabel(label);
  const have = findSectorByLabel(listRotationSectors(), name);
  const id = have?.id ?? createRotationSector(name).id;
  replaceRotationMembers(id, members);
  return getRotationSector(id)!;
}

export type RotationAssign = {
  ticker: string;
  name: string;
  market: string;
  /** StockScans industry — one basket per stock. */
  industry: string;
};
export type RotationSyncResult = {
  placed: number;
  moved: number;
  created: string[];
  removed_empty: string[];
  sectors: number;
};

/**
 * Put each stock in the basket named after its StockScans industry (creating
 * baskets as needed). A stock sits in one basket only, so it leaves its old one.
 * full = true also drops baskets left empty afterwards.
 * Sector Trend “Sectors” view groups these by StockScans sector (ss_sector).
 */
export function syncRotationFromStockscans(rows: RotationAssign[], opts?: { full?: boolean }): RotationSyncResult {
  const db = openWrite();
  try {
    const sectors = db.prepare(`SELECT id, label FROM sectors`).all() as Array<{ id: string; label: string }>;
    const byKey = new Map<string, string>();
    for (const s of sectors) {
      byKey.set(s.label.toLowerCase(), s.id);
      if (!byKey.has(labelKey(s.label))) byKey.set(labelKey(s.label), s.id);
    }
    const current = new Map<string, string>();
    for (const m of db.prepare(`SELECT UPPER(ticker) AS t, sector_id FROM sector_members`).all() as Array<{
      t: string;
      sector_id: string;
    }>)
      current.set(m.t, m.sector_id);
    const created: string[] = [];
    let placed = 0;
    let moved = 0;
    let seq = 0;
    const now = new Date().toISOString();
    const insSector = db.prepare(`INSERT INTO sectors (id, label, created_at) VALUES (?, ?, ?)`);
    const delOther = db.prepare(`DELETE FROM sector_members WHERE UPPER(ticker) = ? AND sector_id != ?`);
    const upsert = db.prepare(
      `INSERT INTO sector_members (sector_id, ticker, name, market, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sector_id, ticker) DO UPDATE SET name = excluded.name, market = excluded.market, updated_at = excluded.updated_at`,
    );
    db.transaction(() => {
      for (const r of rows) {
        const label = collapseSectorLabel(r.industry);
        if (label.length < 2) continue;
        const t = r.ticker.trim().toUpperCase();
        let id = byKey.get(label.toLowerCase()) ?? byKey.get(labelKey(label));
        if (!id) {
          id = `sec-${Date.now().toString(36)}-${(seq++).toString(36)}`;
          insSector.run(id, label, now);
          byKey.set(label.toLowerCase(), id);
          byKey.set(labelKey(label), id);
          created.push(label);
        }
        const was = current.get(t);
        if (was === id) continue;
        delOther.run(t, id);
        upsert.run(id, t, (r.name || t).trim() || t, (r.market || "NSE").trim() || "NSE", now);
        if (was) moved++;
        else placed++;
        current.set(t, id);
      }
    })();
    const removed: string[] = [];
    if (opts?.full) {
      for (const s of db
        .prepare(
          `SELECT id, label FROM sectors WHERE COALESCE(starred, 0) = 0
           AND id NOT IN (SELECT DISTINCT sector_id FROM sector_members)`,
        )
        .all() as Array<{ id: string; label: string }>) {
        db.prepare(`DELETE FROM sectors WHERE id = ?`).run(s.id);
        removed.push(s.label);
      }
    }
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM sectors`).get() as { n: number }).n;
    return { placed, moved, created, removed_empty: removed, sectors: n };
  } finally {
    db.close();
  }
}
