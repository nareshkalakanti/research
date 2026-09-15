/**
 * Live NSE pairing + drift for reference-board tickers.
 * Asserts eng invariants — does not hardcode screenshot % / dates.
 * Run: npx tsx scripts/test-concall-drift.ts
 */
import assert from "node:assert/strict";
import { scanTickerConcallDrift } from "../src/lib/strategy/concall-drift-scan";
import { upsertConcallDriftEvents } from "../src/lib/strategy/concall-drift-store";
import { loadAllCompanies } from "../src/lib/db";

const TICKERS = [
  "BHAGYANGR",
  "EPACKPEB",
  "AVALON",
  "SENORES",
  "HIRECT",
];

async function main() {
  const companies = loadAllCompanies();
  let withPair = 0;
  let withDrift = 0;

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
        200,
      );
      if (rows.length) upsertConcallDriftEvents(rows);

      for (const r of rows) {
        if (r.concall_at) {
          assert.ok(
            r.concall_at.slice(0, 10) >= r.earn_at.slice(0, 10),
            `${ticker}: concall before earn (${r.concall_at} < ${r.earn_at})`,
          );
          withPair += 1;
        }
        if (r.drift_pct != null) {
          assert.equal(r.has_baseline, true, `${ticker}: drift without baseline`);
          assert.ok(r.baseline_close != null);
          withDrift += 1;
        }
      }

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
      throw err;
    }
  }

  assert.ok(withPair >= 2, `expected ≥2 post-earn pairs, got ${withPair}`);
  assert.ok(withDrift >= 1, `expected ≥1 drift row, got ${withDrift}`);
  console.log(`ok — ${withPair} pairs, ${withDrift} drifts across ${TICKERS.length} tickers`);
}

void main();
