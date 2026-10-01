/**
 * User edits on business-group cards (rename / add / remove).
 * Keyed by auto-group ticker fingerprint; rebound by house label when
 * membership (and the fingerprint) changes after a data pull.
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { DATA_DIR } from "./sqlite-utils";
import { groupFingerprint } from "./family-group-refine";
import { listListingCompaniesLite } from "./db";
import { ensureGovernanceCompanyStub } from "./governance-write";

export type FamilyGroupEdit = {
  group_id: string;
  label: string | null;
  add: string[];
  remove: string[];
  updated_at: string | null;
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
  updated_at?: string | null;
}): FamilyGroupEdit {
  return {
    group_id: row.group_id,
    label: row.label?.trim() || null,
    add: parseTickers(row.add_json),
    remove: parseTickers(row.remove_json),
    updated_at: row.updated_at?.trim() || null,
  };
}

export function loadFamilyGroupEditMap(): Map<string, FamilyGroupEdit> {
  const db = openRead();
  if (!db) return new Map();
  try {
    const rows = db
      .prepare(
        `SELECT group_id, label, add_json, remove_json, updated_at FROM family_group_edits`,
      )
      .all() as Array<{
      group_id: string;
      label: string | null;
      add_json: string;
      remove_json: string;
      updated_at: string | null;
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
    updated_at: null,
  };
  const db = openRead();
  if (!db) return empty;
  try {
    const row = db
      .prepare(
        `SELECT group_id, label, add_json, remove_json, updated_at FROM family_group_edits
         WHERE group_id = ?`,
      )
      .get(groupId) as
      | {
          group_id: string;
          label: string | null;
          add_json: string;
          remove_json: string;
          updated_at: string | null;
        }
      | undefined;
    return row ? rowToEdit(row) : empty;
  } finally {
    db.close();
  }
}

function listingByTicker(): Map<string, { name: string; market: string }> {
  const map = new Map<string, { name: string; market: string }>();
  try {
    for (const c of listListingCompaniesLite()) {
      map.set(c.ticker, { name: c.name, market: c.market });
    }
  } catch {
    /* about db optional */
  }
  return map;
}

function persistAddedTickers(tickers: string[]): void {
  const listings = listingByTicker();
  for (const t of tickers) {
    try {
      const hit = listings.get(t);
      ensureGovernanceCompanyStub({
        ticker: t,
        name: hit?.name,
        market: hit?.market,
      });
    } catch {
      /* skip one ticker; others still persist */
    }
  }
}

/** Write listing stubs for every ticker in saved group edits (so the map can show them). */
export function persistAllFamilyEditListings(): void {
  for (const e of loadFamilyGroupEditMap().values()) persistAddedTickers(e.add);
}

function saveEdit(edit: FamilyGroupEdit): void {
  persistAddedTickers(edit.add);
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

export function createFamilyGroup(
  label: string,
  tickers: string[] = [],
): FamilyGroupEdit | null {
  const name = label.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80) return null;
  const add = [
    ...new Set(
      tickers
        .map((t) => t.trim().toUpperCase())
        .filter((t) => /^[A-Z0-9][A-Z0-9.&-]{0,20}$/.test(t)),
    ),
  ];
  const groupId = `user-${groupFingerprint([name, ...add, Date.now().toString()])}`;
  const cur: FamilyGroupEdit = {
    group_id: groupId,
    label: name,
    add,
    remove: [],
    updated_at: null,
  };
  saveEdit(cur);
  return cur;
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

export function deleteFamilyGroup(
  groupId: string,
  tickers: string[] = [],
): boolean {
  const id = groupId.trim();
  if (!id) return false;
  if (id.startsWith("user-")) {
    const db = openWrite();
    try {
      db.prepare(`DELETE FROM family_group_edits WHERE group_id = ?`).run(id);
    } finally {
      db.close();
    }
    return true;
  }
  const drop = [
    ...new Set(
      tickers
        .map((t) => t.trim().toUpperCase())
        .filter((t) => /^[A-Z0-9][A-Z0-9.&-]{0,20}$/.test(t)),
    ),
  ];
  if (!drop.length) return false;
  const cur = readOne(id);
  const gone = new Set(drop);
  cur.add = cur.add.filter((t) => !gone.has(t));
  for (const t of drop) {
    if (!cur.remove.includes(t)) cur.remove.push(t);
  }
  saveEdit(cur);
  return true;
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

function labelKey(s: string | null | undefined): string {
  return (s || "")
    .split("·")[0]
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s+group of companies$/i, "")
    .replace(/\s+group$/i, "")
    .trim();
}

export function applyLoadedFamilyGroupEdits<
  C extends { ticker: string },
  G extends {
    family_name: string;
    company_count: number;
    companies: C[];
    group_id?: string;
  },
>(
  groups: G[],
  edits: Map<string, FamilyGroupEdit>,
  resolveCompany: (ticker: string) => C | null,
): void {
  for (const g of groups) {
    if (!g.group_id) {
      g.group_id = groupFingerprint(g.companies.map((c) => c.ticker));
    }
  }
  const used = new Set<string>();
  for (const g of groups) {
    if (g.group_id && edits.has(g.group_id)) used.add(g.group_id);
  }
  const leadKey = (s: string) => {
    const skip = new Set(["group", "groups", "house", "houses", "the", "of", "and"]);
    const parts = labelKey(s)
      .split(/\s+/)
      .filter((w) => w && !skip.has(w) && /^[a-z]{3,}$/.test(w));
    return (parts[0] || "").toUpperCase();
  };
  for (const edit of edits.values()) {
    if (used.has(edit.group_id) || !edit.label) continue;
    const want = labelKey(edit.label);
    if (want.length < 2) continue;
    const wantLead = leadKey(edit.label);
    let cands = groups
      .filter(
        (g) =>
          labelKey(g.family_name) === want &&
          !(g.group_id && used.has(g.group_id)),
      )
      .sort(
        (a, b) =>
          b.companies.length - a.companies.length ||
          a.family_name.localeCompare(b.family_name),
      );
    if (!cands.length && wantLead.length >= 3) {
      cands = groups
        .filter(
          (g) =>
            leadKey(g.family_name) === wantLead &&
            !(g.group_id && used.has(g.group_id)),
        )
        .sort(
          (a, b) =>
            b.companies.length - a.companies.length ||
            a.family_name.localeCompare(b.family_name),
        );
    }
    if (!cands.length) continue;
    if (cands.length > 1 && cands[0]!.companies.length === cands[1]!.companies.length) {
      continue;
    }
    cands[0]!.group_id = edit.group_id;
    used.add(edit.group_id);
  }
  const placeOn = (g: G, ticker: string) => {
    if (g.companies.some((c) => c.ticker.toUpperCase() === ticker)) return;
    const extra = resolveCompany(ticker);
    if (!extra) return;
    g.companies.push(extra);
  };
  for (const g of groups) {
    const edit = g.group_id ? edits.get(g.group_id) : undefined;
    if (!edit) continue;
    if (edit.label) g.family_name = edit.label;
    const drop = new Set(edit.remove);
    g.companies = g.companies.filter((c) => !drop.has(c.ticker.toUpperCase()));
    for (const ticker of edit.add) placeOn(g, ticker);
    g.company_count = g.companies.length;
  }
  const seen = new Set(groups.map((g) => g.group_id).filter(Boolean));
  for (const edit of edits.values()) {
    if (!edit.group_id.startsWith("user-") || seen.has(edit.group_id)) continue;
    const companies: C[] = [];
    const shell = {
      family_name: edit.label || "",
      company_count: 0,
      companies,
      group_id: edit.group_id,
    } as G;
    groups.push(shell);
    seen.add(edit.group_id);
    for (const ticker of edit.add) placeOn(shell, ticker);
    if (!edit.label && shell.companies.length < 1) {
      groups.pop();
      continue;
    }
    if (!shell.family_name) {
      shell.family_name = shell.companies[0]?.ticker || edit.group_id;
    }
    shell.company_count = shell.companies.length;
  }
  const editedTickers = new Set<string>();
  for (const g of groups) {
    if (g.group_id && edits.has(g.group_id)) {
      for (const c of g.companies) editedTickers.add(c.ticker.toUpperCase());
    }
  }
  if (editedTickers.size) {
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i]!;
      if (g.group_id && edits.has(g.group_id)) continue;
      if (
        g.companies.length &&
        g.companies.every((c) => editedTickers.has(c.ticker.toUpperCase()))
      ) {
        groups.splice(i, 1);
      }
    }
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    const edit = g.group_id ? edits.get(g.group_id) : undefined;
    if (g.companies.length < 1 && !edit?.label) groups.splice(i, 1);
  }
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
  applyLoadedFamilyGroupEdits(groups, loadFamilyGroupEditMap(), resolveCompany);
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
    const compact = ticker.replace(/[^A-Z0-9]/g, "");
    const compactLike = compact.length >= 2 ? `%${compact}%` : like;
    return db
      .prepare(
        `SELECT ticker, name FROM companies
         WHERE UPPER(ticker) = ?
            OR REPLACE(REPLACE(UPPER(ticker), ' ', ''), '.', '') = ?
            OR ticker LIKE ? COLLATE NOCASE
            OR name LIKE ? COLLATE NOCASE
            OR REPLACE(REPLACE(UPPER(ticker), ' ', ''), '.', '') LIKE ?
            OR REPLACE(REPLACE(UPPER(name), ' ', ''), '.', '') LIKE ?
         ORDER BY CASE
           WHEN UPPER(ticker) = ? THEN 0
           WHEN REPLACE(REPLACE(UPPER(ticker), ' ', ''), '.', '') = ? THEN 1
           ELSE 2 END, name COLLATE NOCASE
         LIMIT ?`,
      )
      .all(
        ticker,
        compact,
        like,
        like,
        compactLike,
        compactLike,
        ticker,
        compact,
        Math.min(30, Math.max(1, limit)),
      ) as Array<{
      ticker: string;
      name: string;
    }>;
  } finally {
    db.close();
  }
}
