import { scanTickerConcallDrift } from "../src/lib/strategy/concall-drift-scan";
import { upsertConcallDriftEvents } from "../src/lib/strategy/concall-drift-store";
import { loadAllCompanies } from "../src/lib/db";

const TICKERS = ["BHAGYANGR", "EPACKPEB", "AVALON"];

async function main() {
  const companies = loadAllCompanies();
  for (const ticker of TICKERS) {
    const c = companies.find((x) => x.ticker.toUpperCase() === ticker);
    if (!c) {
      console.log(`${ticker}: not in universe`);
      continue;
    }
    try {
      const rows = await scanTickerConcallDrift(
        c.ticker,
        c.market,
        c.price ?? null,
        150,
      );
      if (rows.length) upsertConcallDriftEvents(rows);
      const latest = rows[0];
      console.log(
        `${ticker}: ${rows.length} earn event(s)` +
          (latest
            ? ` · earn ${latest.earn_at.slice(0, 16)} · concall ${latest.concall_at?.slice(0, 16) ?? "—"} · drift ${latest.drift_pct?.toFixed(1) ?? "—"}%`
            : ""),
      );
    } catch (err) {
      console.log(
        `${ticker}: FAILED — ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

void main();
