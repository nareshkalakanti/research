/**
 * Smoke checks for local BB / TQ scanners (no stocks-ai).
 * Run: npx tsx scripts/test-scan.ts
 */
import assert from "node:assert/strict";
import {
  analyzeBbWeekly,
  analyzeTqWeekly,
  breakoutCounts,
  loadBreakoutMap,
  runSignalBatch,
} from "../src/lib/signals";
import type { Bar } from "../src/lib/indicators";
import { bollingerBands } from "../src/lib/indicators";
import { fetchNiftyWeeklyBars, fetchWeeklyBars } from "../src/lib/ohlc";

function bar(
  date: string,
  close: number,
  opts?: Partial<Bar>,
): Bar {
  return {
    date,
    open: opts?.open ?? close,
    high: opts?.high ?? close * 1.01,
    low: opts?.low ?? close * 0.99,
    close,
    volume: opts?.volume ?? 1_000_000,
  };
}

function testSyntheticBbNew() {
  // 52 flat bars then a clear breakout above upper band
  const bars: Bar[] = [];
  for (let i = 0; i < 52; i += 1) {
    const d = new Date(Date.UTC(2024, 0, 1 + i * 7));
    bars.push(bar(d.toISOString().slice(0, 10), 100));
  }
  const lastFlat = bars[bars.length - 1];
  const boomDate = new Date(Date.UTC(2024, 0, 1 + 52 * 7));
  bars.push(
    bar(boomDate.toISOString().slice(0, 10), 130, {
      high: 132,
      low: 120,
      volume: 2_000_000,
    }),
  );

  const closes = bars.map((b) => b.close);
  const { upper } = bollingerBands(closes, 50, 2);
  const u = upper[upper.length - 1];
  assert.ok(u != null && 130 > u, `expected breakout above upper (${u})`);

  const hit = analyzeBbWeekly(bars);
  assert.ok(hit, "expected NEW_BREAKOUT on synthetic series");
  assert.equal(hit!.signal, "NEW_BREAKOUT");
  console.log("✓ synthetic BB NEW", hit);

  // No breakout when last bar stays at the same level as the band mid
  const flat = bars.slice(0, -1);
  flat.push(bar(boomDate.toISOString().slice(0, 10), 100));
  assert.equal(analyzeBbWeekly(flat), null, "flat series should not BB NEW");
  console.log("✓ synthetic BB flat → null");
}

async function testLiveFetchAndBatch() {
  const nifty = await fetchNiftyWeeklyBars();
  assert.ok(nifty.length >= 65, `nifty weekly bars too few: ${nifty.length}`);
  console.log(`✓ nifty weekly bars: ${nifty.length}`);

  const sample = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ITC"];
  for (const t of sample) {
    const bars = await fetchWeeklyBars(t, "NSE", 2);
    assert.ok(bars.length >= 50, `${t} weekly bars too few: ${bars.length}`);
    const bb = analyzeBbWeekly(bars);
    const tq = analyzeTqWeekly(bars, nifty);
    console.log(
      `  ${t}: bars=${bars.length} bb=${bb ? "YES" : "—"} tq=${tq ? tq.crossover_type : "—"}`,
    );
  }
  console.log("✓ live weekly fetch + analyze");

  const result = await runSignalBatch(
    sample.map((ticker) => ({ ticker, market: "NSE" })),
    "both",
    { concurrency: 3 },
  );
  assert.ok(result.tried === sample.length, `tried=${result.tried}`);
  console.log("✓ runSignalBatch", result);

  const map = loadBreakoutMap();
  const counts = breakoutCounts(map);
  console.log("✓ signals.db counts", counts);
  for (const t of sample) {
    const f = map.get(t);
    if (f?.has_bb || f?.has_tq) {
      console.log(
        `  tagged ${t}:`,
        f.has_bb ? "BB" : "",
        f.has_tq ? `TQ(${f.tq?.crossover_type})` : "",
      );
    }
  }
}

async function testKnownBbTickers() {
  // Tickers recently flagged NEW_BREAKOUT weekly in a sibling Strategy cache
  // (used only as expected candidates — we recompute locally).
  const candidates = [
    "NEULANDLAB",
    "OFSS",
    "SIEMENS",
    "CENTUM",
    "SANSERA",
    "SHAILY",
    "BETA",
    "VINDHYATEL",
  ];
  let hits = 0;
  for (const t of candidates) {
    const bars = await fetchWeeklyBars(t, "NSE", 2);
    const bb = analyzeBbWeekly(bars);
    console.log(
      `  ${t}: bars=${bars.length} close=${bars.at(-1)?.close ?? "—"} bb=${bb ? "YES@" + bb.signal_date : "—"}`,
    );
    if (bb) hits += 1;
  }
  console.log(`✓ known-candidate BB recompute: ${hits}/${candidates.length} hit`);
  assert.ok(
    hits >= 1,
    "expected at least one local BB NEW among recent breakout candidates",
  );
}

async function main() {
  console.log("=== BB / TQ smoke tests ===\n");
  testSyntheticBbNew();
  await testLiveFetchAndBatch();
  await testKnownBbTickers();
  console.log("\nAll checks passed.");
}

main().catch((e) => {
  console.error("\nFAILED", e);
  process.exit(1);
});
