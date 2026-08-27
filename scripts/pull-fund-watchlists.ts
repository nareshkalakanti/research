/**
 * Pull fund watchlist stock lists from Trendlyne → fund_watchlists.db.
 * Includes QoQ change (new / inc / dec). Then syncs missing tickers into company_about.db.
 *
 *   npm run pull:fund-watchlists
 *   npm run pull:fund-watchlists -- --list mukul,kedia
 */
import { invalidateCompanyCache } from "../src/lib/db";
import {
  ensureFundWatchlistInCompanyAbout,
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
  FUND_WATCHLIST_SOURCES,
  invalidateFundWatchlistCache,
  replaceFundWatchlists,
  type FundWatchlistKey,
} from "../src/lib/fund-watchlists";
import {
  fetchSourceHoldings,
  invalidateResolverCaches,
  resolveHoldings,
} from "../src/lib/superstars/scrape";
import {
  pickBetterFundChange,
  type FundChangeInfo,
} from "../src/lib/fund-watchlist-meta";
import { resolveTickerMeta } from "./lib/local-ticker-meta";

function mergeResolved(
  bySym: Map<
    string,
    ReturnType<typeof resolveHoldings>[number] & {
      change?: FundChangeInfo;
    }
  >,
  r: ReturnType<typeof resolveHoldings>[number],
): void {
  const sym = (r.symbol || "").toUpperCase();
  if (!sym) return;
  const key = `${sym}|${(r.exchange || "NSE").toUpperCase()}`;
  const prev = bySym.get(key);
  const change: FundChangeInfo = {
    change_type: (r.change_type ?? "unchanged").toLowerCase(),
    change_qtr:
      r.change_qtr != null && Number.isFinite(r.change_qtr) ? r.change_qtr : null,
  };
  if (!prev) {
    bySym.set(key, { ...r, change });
    return;
  }
  bySym.set(key, {
    ...prev,
    ...r,
    symbol: sym,
    change: pickBetterFundChange(prev.change, change)!,
  });
}

function parseListArg(): FundWatchlistKey[] {
  const idx = process.argv.indexOf("--list");
  if (idx === -1 || !process.argv[idx + 1]) return [...FUND_WATCHLIST_KEYS];
  const raw = process.argv[idx + 1].toLowerCase();
  const keys = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean) as FundWatchlistKey[];
  for (const k of keys) {
    if (!FUND_WATCHLIST_KEYS.includes(k)) {
      throw new Error(
        `Invalid --list ${k} (use ${FUND_WATCHLIST_KEYS.join(", ")})`,
      );
    }
  }
  return keys;
}

async function pullOne(listKey: FundWatchlistKey): Promise<number> {
  const src = FUND_WATCHLIST_SOURCES[listKey];
  const label = FUND_WATCHLIST_LABELS[listKey];
  console.log(`Fetching ${label} from Trendlyne…`);

  const sources = [
    src,
    ...(src.extra_sources ?? []),
  ];
  const parsed = [];
  for (const s of sources) {
    parsed.push(...(await fetchSourceHoldings(s, src.label)));
  }

  const bySym = new Map<
    string,
    ReturnType<typeof resolveHoldings>[number] & { change?: FundChangeInfo }
  >();
  for (const r of resolveHoldings(parsed)) {
    mergeResolved(bySym, r);
  }

  const rows = [...bySym.values()].map((r) => {
    const ticker = r.symbol.toUpperCase();
    const meta = resolveTickerMeta(ticker);
    const market = meta.market || (r.exchange === "BSE" ? "BSE" : "NSE");
    return {
      ticker,
      name: meta.name || r.company_name,
      market,
      change_qtr: r.change?.change_qtr ?? r.change_qtr,
      change_type: r.change?.change_type ?? r.change_type,
    };
  });

  const n = replaceFundWatchlists(listKey, rows);
  console.log(`  ${label}: ${n} stocks`);
  return n;
}

async function main() {
  const keys = parseListArg();
  let total = 0;
  for (const key of keys) {
    total += await pullOne(key);
  }
  invalidateResolverCaches();
  invalidateFundWatchlistCache();

  const added = ensureFundWatchlistInCompanyAbout();
  invalidateCompanyCache();
  console.log(`\nPulled ${total} rows → data/fund_watchlists.db`);
  if (added > 0) {
    console.log(`Added ${added} missing tickers → company_about.db`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
