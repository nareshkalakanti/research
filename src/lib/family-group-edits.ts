/**
 * User edits on business-group cards (rename / add / remove).
 * Keyed by the auto-grouped ticker fingerprint, not by label.
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { DATA_DIR } from "./sqlite-utils";
import { groupFingerprint } from "./family-group-refine";

export type FamilyGroupEdit = {
  group_id: string;
  label: string | null;
  add: string[];
  remove: string[];
};

const DB_PATH = path.join(DATA_DIR, "family_group_edits.db");

function openWrite(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS family_group_edits (
      group_id TEXT PRIMARY KEY,
      label TEXT,
      add_json TEXT NOT NULL DEFAULT '[]',
      remove_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
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

function parseTickers(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return [
      ...new Set(
        v
          .map((x) => String(x || "").trim().toUpperCase())
          .filter((t) => /^[A-Z0-9][A-Z0-9.&-]{0,20}$/.test(t)),
      ),
    ];
  } catch {
    return [];
  }
}

function rowToEdit(row: {
  group_id: string;
  label: string | null;
  add_json: string;
  remove_json: string;
}): FamilyGroupEdit {
  return {
    group_id: row.group_id,
    label: row.label?.trim() || null,
    add: parseTickers(row.add_json),
    remove: parseTickers(row.remove_json),
  };
}

export function loadFamilyGroupEditMap(): Map<string, FamilyGroupEdit> {
  const db = openRead();
  if (!db) return new Map();
  try {
    const rows = db
      .prepare(
        `SELECT group_id, label, add_json, remove_json FROM family_group_edits`,
      )
      .all() as Array<{
      group_id: string;
      label: string | null;
      add_json: string;
      remove_json: string;
    }>;
    return new Map(rows.map((r) => [r.group_id, rowToEdit(r)]));
  } finally {
    db.close();
  }
}

export function familyGroupHasEdits(groupId: string): boolean {
  const e = loadFamilyGroupEditMap().get(groupId);
  if (!e) return false;
  return Boolean(e.label || e.add.length || e.remove.length);
}

function readOne(groupId: string): FamilyGroupEdit {
  const empty: FamilyGroupEdit = {
    group_id: groupId,
    label: null,
    add: [],
    remove: [],
  };
  const db = openRead();
  if (!db) return empty;
  try {
    const row = db
      .prepare(
        `SELECT group_id, label, add_json, remove_json FROM family_group_edits
         WHERE group_id = ?`,
      )
      .get(groupId) as
      | {
          group_id: string;
          label: string | null;
          add_json: string;
          remove_json: string;
        }
      | undefined;
    return row ? rowToEdit(row) : empty;
  } finally {
    db.close();
  }
}

function saveEdit(edit: FamilyGroupEdit): void {
  const db = openWrite();
  try {
    if (!edit.label && !edit.add.length && !edit.remove.length) {
      db.prepare(`DELETE FROM family_group_edits WHERE group_id = ?`).run(
        edit.group_id,
      );
      return;
    }
    db.prepare(
      `INSERT INTO family_group_edits (group_id, label, add_json, remove_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         label = excluded.label,
         add_json = excluded.add_json,
         remove_json = excluded.remove_json,
         updated_at = excluded.updated_at`,
    ).run(
      edit.group_id,
      edit.label,
      JSON.stringify(edit.add),
      JSON.stringify(edit.remove),
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

export function renameFamilyGroup(groupId: string, label: string): FamilyGroupEdit | null {
  const name = label.replace(/\s+/g, " ").trim();
  if (!groupId || name.length < 2 || name.length > 80) return null;
  const cur = readOne(groupId);
  cur.label = name;
  saveEdit(cur);
  return cur;
}

export function addFamilyGroupTicker(
  groupId: string,
  ticker: string,
): FamilyGroupEdit | null {
  const t = ticker.trim().toUpperCase();
  if (!groupId || !/^[A-Z0-9][A-Z0-9.&-]{0,20}$/.test(t)) return null;
  const cur = readOne(groupId);
  cur.remove = cur.remove.filter((x) => x !== t);
  if (!cur.add.includes(t)) cur.add.push(t);
  saveEdit(cur);
  return cur;
}

export function removeFamilyGroupTicker(
  groupId: string,
  ticker: string,
): FamilyGroupEdit | null {
  const t = ticker.trim().toUpperCase();
  if (!groupId || !t) return null;
  const cur = readOne(groupId);
  cur.add = cur.add.filter((x) => x !== t);
  if (!cur.remove.includes(t)) cur.remove.push(t);
  saveEdit(cur);
  return cur;
}

export function applyFamilyGroupEdits<
  C extends { ticker: string },
  G extends {
    family_name: string;
    company_count: number;
    companies: C[];
    group_id?: string;
  },
>(
  groups: G[],
  resolveCompany: (ticker: string) => C | null,
): void {
  const edits = loadFamilyGroupEditMap();
  for (const g of groups) {
    if (!g.group_id) {
      g.group_id = groupFingerprint(g.companies.map((c) => c.ticker));
    }
  }
  for (const g of groups) {
    const edit = g.group_id ? edits.get(g.group_id) : undefined;
    if (!edit) continue;
    if (edit.label) g.family_name = edit.label;
    const drop = new Set(edit.remove);
    g.companies = g.companies.filter((c) => !drop.has(c.ticker.toUpperCase()));
    for (const ticker of edit.add) {
      if (g.companies.some((c) => c.ticker.toUpperCase() === ticker)) continue;
      const extra = resolveCompany(ticker);
      if (!extra) continue;
      for (const other of groups) {
        if (other === g) continue;
        other.companies = other.companies.filter(
          (c) => c.ticker.toUpperCase() !== ticker,
        );
        other.company_count = other.companies.length;
      }
      g.companies.push(extra);
    }
    g.company_count = g.companies.length;
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i]!.companies.length < 1) groups.splice(i, 1);
  }
}

export function searchListedCompanies(
  q: string,
  limit = 12,
): Array<{ ticker: string; name: string }> {
  const needle = q.trim();
  if (needle.length < 1) return [];
  const govPath = path.join(DATA_DIR, "governance.db");
  if (!fs.existsSync(govPath)) return [];
  const db = new Database(govPath, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  try {
    const like = `%${needle.replace(/[%_]/g, "")}%`;
    const ticker = needle.trim().toUpperCase();
    return db
      .prepare(
        `SELECT ticker, name FROM companies
         WHERE UPPER(ticker) = ?
            OR ticker LIKE ? COLLATE NOCASE
            OR name LIKE ? COLLATE NOCASE
         ORDER BY CASE WHEN UPPER(ticker) = ? THEN 0 ELSE 1 END, name COLLATE NOCASE
         LIMIT ?`,
      )
      .all(ticker, like, like, ticker, Math.min(30, Math.max(1, limit))) as Array<{
      ticker: string;
      name: string;
    }>;
  } finally {
    db.close();
  }
}
