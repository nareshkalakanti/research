/**
 * Incrementally add fund watchlist tickers (does not replace list or touch superstar sync).
 *
 *   npm run add:fund-watchlist -- --list negen --tickers BEACON,CHETANA,NEWJAISA
 */
import { invalidateCompanyCache } from "../src/lib/db";
import {
  ensureFundWatchlistInCompanyAbout,
  type FundWatchlistKey,
  upsertFundWatchlistRows,
} from "../src/lib/fund-watchlists";
import { resolveTickerMeta } from "./lib/local-ticker-meta";

function parseArgs(): { listKey: FundWatchlistKey; tickers: string[] } {
  const args = process.argv.slice(2);
  let listKey: FundWatchlistKey = "negen";
  let tickers: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--list" && args[i + 1]) {
      const v = args[++i].toLowerCase();
      if (!FUND_WATCHLIST_KEYS.includes(v as FundWatchlistKey)) {
        throw new Error(`Invalid --list ${v} (use ${FUND_WATCHLIST_KEYS.join(", ")})`);
      }
      listKey = v;
    } else if (args[i] === "--tickers" && args[i + 1]) {
      tickers = args[++i]
        .split(/[,\s]+/)
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);
    }
  }

  if (!tickers.length) {
    throw new Error(
      "Usage: npm run add:fund-watchlist -- --list negen --tickers BEACON,CHETANA",
    );
  }
  return { listKey, tickers };
}

function main() {
  const { listKey, tickers } = parseArgs();
  const rows = tickers.map((ticker) => {
    const meta = resolveTickerMeta(ticker);
    return {
      ticker: meta.ticker,
      name: meta.name,
      market: meta.market,
    };
  });
  const added = upsertFundWatchlistRows(listKey, rows);
  const aboutAdded = ensureFundWatchlistInCompanyAbout(
    rows.map((r) => ({ ...r, list_key: listKey })),
  );
  invalidateCompanyCache();

  console.log(
    `Upserted ${added} ${listKey} tickers → data/fund_watchlists.db`,
  );
  console.log(rows.map((r) => `${r.ticker} (${r.market})`).join(", "));
  if (aboutAdded > 0) {
    console.log(`Added ${aboutAdded} missing tickers → company_about.db`);
  }
  console.log("(superstar_holdings.db unchanged)");
}

main();
