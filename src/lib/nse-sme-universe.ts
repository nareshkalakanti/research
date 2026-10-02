/**
 * Apply NSE EQUITY_L + SME_EQUITY_L to company_about then governance.companies.
 * Rights entitlements are skipped. Main-board CSV wins over SME label.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { ensureCompanyAboutRow } from "./company-about-write";
import { invalidateCompanyCache } from "./db";
import {
  ensureGovernanceCompanyStub,
  getGovernanceWriteDb,
} from "./governance-write";
import { syncCompanyMetrics } from "./company-metrics";
import {
  isNseRightsEntitlement,
  nseSmeIssuers,
  type NseEquityListRow,
} from "./nse-equity-lists";

const DATA_DIR = path.join(process.cwd(), "data");
const ABOUT_PATH = path.join(DATA_DIR, "company_about.db");

export type NseUniverseApplyResult = {
  skipped_rights: string[];
  sme_issuers: number;
  main_issuers: number;
  inserted_about: string[];
  inserted_governance: string[];
  relabelled_to_nse: string[];
  isin_updated: number;
};

function listTickers(sqlFile: string, sql: string): Set<string> {
  const p = path.join(DATA_DIR, sqlFile);
  if (!fs.existsSync(p)) return new Set();
  const db = new Database(p, { readonly: true });
  try {
    return new Set(
      (db.prepare(sql).all() as Array<{ t: string }>).map((r) => r.t),
    );
  } finally {
    db.close();
  }
}

export function applyNseEquityUniverse(opts: {
  sme: NseEquityListRow[];
  main: NseEquityListRow[];
}): NseUniverseApplyResult {
  const skipped_rights = opts.sme
    .filter((r) => isNseRightsEntitlement(r))
    .map((r) => r.ticker)
    .sort();
  const smeIssuers = nseSmeIssuers(opts.sme);
  const mainByTicker = new Map(opts.main.map((r) => [r.ticker, r] as const));
  const smeOnly = smeIssuers.filter((r) => !mainByTicker.has(r.ticker));

  const govBefore = listTickers(
    "governance.db",
    `SELECT UPPER(ticker) AS t FROM companies`,
  );
  const haveAbout = listTickers(
    "company_about.db",
    `SELECT UPPER(ticker) AS t FROM company_about`,
  );

  const inserted_about: string[] = [];
  for (const r of smeOnly) {
    if (haveAbout.has(r.ticker)) continue;
    if (
      ensureCompanyAboutRow(r.ticker, {
        name: r.name,
        market: "NSE SME",
      })
    ) {
      inserted_about.push(r.ticker);
      haveAbout.add(r.ticker);
    }
  }

  const relabelled_to_nse: string[] = [];
  if (fs.existsSync(ABOUT_PATH)) {
    const about = new Database(ABOUT_PATH);
    try {
      const upd = about.prepare(
        `UPDATE company_about
         SET market = 'NSE',
             name = COALESCE(NULLIF(TRIM(?), ''), name)
         WHERE UPPER(ticker) = ?
           AND UPPER(TRIM(market)) = 'NSE SME'`,
      );
      const labeled = about
        .prepare(
          `SELECT UPPER(ticker) AS t FROM company_about
           WHERE UPPER(TRIM(market)) = 'NSE SME'`,
        )
        .all() as Array<{ t: string }>;
      const tx = about.transaction(() => {
        for (const row of labeled) {
          const main = mainByTicker.get(row.t);
          if (!main) continue;
          const info = upd.run(main.name, row.t);
          if (info.changes) relabelled_to_nse.push(row.t);
        }
      });
      tx();
    } finally {
      about.close();
    }
  }

  const inserted_governance: string[] = [];
  for (const r of smeOnly) {
    ensureGovernanceCompanyStub({
      ticker: r.ticker,
      name: r.name,
      market: "NSE SME",
      isin: r.isin,
    });
    if (!govBefore.has(r.ticker)) inserted_governance.push(r.ticker);
  }

  for (const t of relabelled_to_nse) {
    const main = mainByTicker.get(t);
    if (!main) continue;
    ensureGovernanceCompanyStub({
      ticker: t,
      name: main.name,
      market: "NSE",
      isin: main.isin,
    });
  }

  const gov = getGovernanceWriteDb();
  const now = new Date().toISOString();
  const fillIsin = gov.prepare(
    `UPDATE companies SET isin = ?, updated_at = ?
     WHERE UPPER(ticker) = ?
       AND (isin IS NULL OR TRIM(isin) = '')`,
  );
  let isin_updated = 0;
  const tx = gov.transaction(() => {
    for (const r of [...smeOnly, ...opts.main]) {
      if (!r.isin) continue;
      isin_updated += Number(fillIsin.run(r.isin, now, r.ticker).changes || 0);
    }
  });
  tx();

  syncCompanyMetrics(gov);
  invalidateCompanyCache();

  return {
    skipped_rights,
    sme_issuers: smeOnly.length,
    main_issuers: opts.main.length,
    inserted_about: inserted_about.sort(),
    inserted_governance: inserted_governance.sort(),
    relabelled_to_nse: relabelled_to_nse.sort(),
    isin_updated,
  };
}
