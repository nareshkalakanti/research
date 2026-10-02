/**
 * NSE SME / main-board universe from official nsearchives CSVs.
 *   npx tsx scripts/sync-nse-sme-universe.ts
 *   npx tsx scripts/sync-nse-sme-universe.ts --dry-run
 */
import {
  fetchNseMainEquityList,
  fetchNseSmeEquityList,
  isNseRightsEntitlement,
  nseSmeIssuers,
} from "../src/lib/nse-equity-lists";
import { applyNseEquityUniverse } from "../src/lib/nse-sme-universe";
import { runGovernanceScanBatch } from "../src/lib/governance-scan";
import { openSqliteNamed } from "../src/lib/sqlite-utils";

function govTickers(market?: string): Set<string> {
  const db = openSqliteNamed("governance.db", { readonly: true });
  try {
    const sql = market
      ? `SELECT UPPER(ticker) AS t FROM companies WHERE market = ?`
      : `SELECT UPPER(ticker) AS t FROM companies`;
    const rows = market
      ? (db.prepare(sql).all(market) as Array<{ t: string }>)
      : (db.prepare(sql).all() as Array<{ t: string }>);
    return new Set(rows.map((r) => r.t));
  } finally {
    db.close();
  }
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  console.log("Fetch NSE EQUITY_L + SME_EQUITY_L…");
  const [main, sme] = await Promise.all([
    fetchNseMainEquityList(),
    fetchNseSmeEquityList(),
  ]);
  const rights = sme.filter((r) => isNseRightsEntitlement(r));
  const smeIssuers = nseSmeIssuers(sme).filter(
    (r) => !main.some((m) => m.ticker === r.ticker),
  );
  const gov = govTickers();
  const govSme = govTickers("NSE SME");
  const missing = smeIssuers.filter((r) => !gov.has(r.ticker));
  const relabel = [...govSme].filter((t) => main.some((m) => m.ticker === t));
  const extra = [...govSme].filter(
    (t) => !smeIssuers.some((r) => r.ticker === t) && !relabel.includes(t),
  );

  console.log("\n--- Phase A plan (from CSVs, not hardcoded) ---");
  console.log(`SME CSV rows ${sme.length}; issuers ${smeIssuers.length}; rights skipped ${rights.map((r) => r.ticker).join(", ") || "(none)"}`);
  console.log(`Insert into companies (${missing.length}):`);
  for (const r of missing) {
    console.log(
      `  ${r.ticker.padEnd(12)} ${r.series.padEnd(4)} ${r.isin || "-"}  ${r.name}`,
    );
  }
  console.log(`Relabel NSE SME → NSE (${relabel.length}): ${relabel.join(", ") || "(none)"}`);
  console.log(`KEL / extra NSE SME not on Emerge: ${extra.join(", ") || "(none)"}`);
  console.log("ISIN stored on governance.companies.isin (existing column).");
  console.log(
    "Reuse: ensureCompanyAboutRow → getGovernanceWriteDb/syncListedSmeFromAbout + ensureGovernanceCompanyStub; boards via runGovernanceScanBatch.",
  );

  if (dry) {
    console.log("\n--dry-run: no writes");
    return;
  }

  const result = applyNseEquityUniverse({ sme, main });
  console.log("\nApplied", result);

  console.log("\nNSE board scan for NSE SME issuers with no seats…");
  const seatDb = openSqliteNamed("governance.db", { readonly: true });
  let needSeats: string[] = [];
  try {
    needSeats = (
      seatDb
        .prepare(
          `SELECT c.ticker
           FROM companies c
           WHERE c.market = 'NSE SME'
             AND NOT EXISTS (
               SELECT 1 FROM board_seats s WHERE s.ticker = c.ticker
             )
           ORDER BY c.ticker`,
        )
        .all() as Array<{ ticker: string }>
    ).map((r) => r.ticker);
  } finally {
    seatDb.close();
  }
  console.log(`missing seats: ${needSeats.length}`);
  if (needSeats.length) {
    const scan = await runGovernanceScanBatch({
      tickers: needSeats,
      limit: Math.min(40, Math.max(needSeats.length, 1)),
      missingOnly: true,
      concurrency: 2,
    });
    console.log("scan", {
      tried: scan.tried,
      saved: scan.saved,
      empty: scan.skipped_empty,
      failed: scan.failed,
      remaining: scan.remaining,
      saved_tickers: scan.saved_tickers,
    });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
