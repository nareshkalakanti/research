/**
 * company_groups on governance.db: ticker → business group, copied from the
 * dashboard family map (auto groups plus user edits). A ticker is in at most
 * one group unless a user add placed it on a second house; a ticker in no
 * group is standalone.
 */
import type Database from "better-sqlite3";
import { loadGovernanceFamilyMap } from "@/lib/governance-map";

export const COMPANY_GROUPS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS company_groups (
    ticker TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
    group_key TEXT NOT NULL,
    group_name TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (ticker, group_key)
);
CREATE INDEX IF NOT EXISTS idx_company_groups_key ON company_groups(group_key)`;

const SYNC_MAX_AGE_MS = 60 * 60 * 1000;

export function ensureCompanyGroupsTable(db: Database.Database): void {
  db.exec(COMPANY_GROUPS_TABLE_SQL);
}

export type CompanyGroupLink = { ticker: string; group_key: string; group_name: string };

/** Flatten dashboard groups into ticker → group rows. */
export function companyGroupLinks(
  groups: Array<{
    family_name: string;
    group_id?: string;
    companies: Array<{ ticker: string }>;
  }>,
): CompanyGroupLink[] {
  const out = new Map<string, CompanyGroupLink>();
  for (const g of groups) {
    const name = (g.family_name || "").trim();
    const key = (g.group_id || name).trim();
    if (!key || !name) continue;
    for (const c of g.companies) {
      const ticker = (c.ticker || "").trim().toUpperCase();
      if (!ticker) continue;
      out.set(`${ticker}|${key}`, { ticker, group_key: key, group_name: name });
    }
  }
  return [...out.values()];
}

/** Read the family map first; it opens governance.db on its own. */
export function loadCompanyGroupLinks(refresh = false): CompanyGroupLink[] {
  return companyGroupLinks(loadGovernanceFamilyMap({ refresh }));
}

export function writeCompanyGroups(
  db: Database.Database,
  links: CompanyGroupLink[],
): number {
  ensureCompanyGroupsTable(db);
  const known = new Set(
    (db.prepare(`SELECT ticker FROM companies`).all() as Array<{ ticker: string }>).map(
      (r) => r.ticker.toUpperCase(),
    ),
  );
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO company_groups (ticker, group_key, group_name, updated_at)
     VALUES (?, ?, ?, ?)`,
  );
  return db.transaction(() => {
    db.prepare(`DELETE FROM company_groups`).run();
    let n = 0;
    for (const l of links) {
      if (!known.has(l.ticker)) continue;
      insert.run(l.ticker, l.group_key, l.group_name, now);
      n += 1;
    }
    return n;
  })();
}

export function companyGroupsStale(db: Database.Database): boolean {
  ensureCompanyGroupsTable(db);
  const row = db
    .prepare(`SELECT MAX(updated_at) AS at, COUNT(*) AS n FROM company_groups`)
    .get() as { at: string | null; n: number };
  if (!row.n || !row.at) return true;
  return Date.now() - Date.parse(row.at) >= SYNC_MAX_AGE_MS;
}
