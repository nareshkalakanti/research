/**
 * Refresh mcap + sector/subsector + about + CEO/MD from Tickertape (Groww fills blanks).
 *
 * Default: names missing mcap, sector, sub-sector, or about.
 *
 *   npx tsx scripts/fetch-market-cap.ts
 *   npx tsx scripts/fetch-market-cap.ts --holdings
 *   npx tsx scripts/fetch-market-cap.ts --all --force --resume --concurrency 2 --delay 750
 *   npx tsx scripts/fetch-market-cap.ts --force --limit 40
 */
import { invalidateCompanyCache, loadAllCompanies } from "../src/lib/db";
import { holdingsTickerSet } from "../src/lib/holdings";
import { fundWatchlistAllTickers } from "../src/lib/fund-watchlists";
import { openSqliteNamed } from "../src/lib/sqlite-utils";
import { fetchWebProfiles } from "../src/lib/web-mcap";
import { applyWebProfiles } from "../src/lib/web-profile-apply";

function argValue(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  return i >= 0 ? String(args[i + 1] || "").trim() : "";
}

function needsProfile(c: {
  mcap_cr: number | null;
  sector: string | null;
  sub_sector: string | null;
  about: string | null;
}): boolean {
  return (
    c.mcap_cr == null ||
    c.mcap_cr <= 0 ||
    !c.sector?.trim() ||
    !c.sub_sector?.trim() ||
    !c.about?.trim()
  );
}

function refreshedToday(): Set<string> {
  const db = openSqliteNamed("company_about.db", { readonly: true });
  try {
    const day = new Date().toISOString().slice(0, 10);
    const rows = db
      .prepare(
        `SELECT ticker FROM company_about
         WHERE source = 'tickertape-groww' AND fetched_at >= ?`,
      )
      .all(day) as Array<{ ticker: string }>;
    return new Set(rows.map((r) => r.ticker.toUpperCase()));
  } finally {
    db.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const market = argValue(args, "--market") || "All";
  const limit = Number(argValue(args, "--limit")) || 0;
  const concurrency = Math.max(1, Number(argValue(args, "--concurrency")) || 2);
  const delayMs = Math.max(0, Number(argValue(args, "--delay")) || 750);
  const force = args.includes("--force");
  const all = args.includes("--all");
  const resume = args.includes("--resume");
  const holdingsOnly = args.includes("--holdings");
  const fundsOnly = args.includes("--funds");

  let companies = loadAllCompanies();
  if (market !== "All") {
    companies = companies.filter((c) => c.market === market);
  }
  if (holdingsOnly) {
    const set = holdingsTickerSet();
    companies = companies.filter((c) => set.has(c.ticker.toUpperCase()));
  } else if (fundsOnly) {
    const set = fundWatchlistAllTickers();
    companies = companies.filter((c) => set.has(c.ticker.toUpperCase()));
  }

  let pending = companies.filter((c) => (force || all ? true : needsProfile(c)));
  if (resume) {
    const done = refreshedToday();
    pending = pending.filter((c) => !done.has(c.ticker.toUpperCase()));
    console.log(`Resume: skipping ${done.size.toLocaleString()} already written today`);
  }
  const batch = limit > 0 ? pending.slice(0, limit) : pending;

  console.log(
    `${pending.length.toLocaleString()} to refresh (${market}` +
      `${holdingsOnly ? ", holdings" : fundsOnly ? ", funds" : all || force ? ", all listed" : ", missing profile/mcap"}` +
      `) · running ${batch.length.toLocaleString()} · ${concurrency} workers · ${delayMs}ms delay`,
  );
  if (!batch.length) {
    console.log("Nothing to fill.");
    return;
  }

  const started = Date.now();
  const marketBy: Record<string, string> = {};
  for (const c of batch) marketBy[c.ticker.toUpperCase()] = c.market;

  const CHUNK = 40;
  let hits = 0;
  let metrics = 0;
  let about = 0;
  let sector = 0;
  let people = 0;
  let sampleShown = 0;

  for (let offset = 0; offset < batch.length; offset += CHUNK) {
    const slice = batch.slice(offset, offset + CHUNK);
    const profiles = await fetchWebProfiles(slice, {
      concurrency,
      delayMs,
    });
    const applied = applyWebProfiles(profiles, marketBy, {
      overwriteAbout: force,
    });
    invalidateCompanyCache();
    hits += profiles.length;
    metrics += applied.metrics;
    about += applied.about;
    sector += applied.sector;
    people += applied.people;

    const done = Math.min(offset + slice.length, batch.length);
    const sec = Math.max(1, Math.round((Date.now() - started) / 1000));
    const rate = done / sec;
    const eta = Math.max(0, Math.round((batch.length - done) / Math.max(rate, 0.01)));
    console.log(
      `[${done}/${batch.length}] hits ${hits} · mcap ${metrics} · about ${about} · ` +
        `sector ${sector} · people ${people} · ${sec}s · ~${eta}s left`,
    );
    for (const p of profiles) {
      if (sampleShown >= 8) break;
      sampleShown += 1;
      console.log(
        `  ${p.ticker} ₹${p.mcap_cr ?? "—"} Cr  ${p.sector || "—"} / ${p.subsector || "—"}  ` +
          `${p.ceo || p.managing_director || "—"}  ${p.source}`,
      );
    }
    if (offset + CHUNK < batch.length) {
      await sleep(2_000 + Math.random() * 1_500);
    }
  }

  const sec = Math.round((Date.now() - started) / 1000);
  console.log(
    `Done in ${sec}s — hits ${hits}/${batch.length}` +
      ` · mcap ${metrics} · about ${about} · sector ${sector} · people ${people}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
