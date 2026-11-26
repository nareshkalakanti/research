import assert from "node:assert/strict";
import { earlyGrowth } from "../src/lib/ipo-growth";
import { igniteBar } from "../src/lib/momentum-money";

const days = Array.from({ length: 50 }, (_, i) => new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
const candles = days.map((date, i) => (i === 0 ? { date, open: 100, high: 120, low: 98, close: 118 } : { date, open: 115, high: 117, low: 110, close: 112 }));
const vols = days.map((date, i) => ({ date, close: 0, volume: i === 0 ? 900 : 100 }));

// Strong green day 1, closing near its high, on the highest volume: an ignite bar, held above its low.
const ig = igniteBar(candles, "2024-01-01", vols)!;
assert.equal(ig.ignite, true);
assert.equal(ig.hve, true);
assert.equal(ig.held, true);
assert.ok(ig.close_pos > 0.8);

// Green but closing low in its range: not an ignite bar.
const weak = igniteBar([{ ...candles[0]!, close: 102 }, ...candles.slice(1)], "2024-01-01", vols)!;
assert.equal(weak.ignite, false);

// Not the highest volume since listing: not an ignite bar.
assert.equal(igniteBar(candles, "2024-01-01", vols.map((v, i) => (i === 5 ? { ...v, volume: 2000 } : v)))!.ignite, false);

// No candle on the listing day: no read.
assert.equal(igniteBar(candles.slice(10), "2024-01-01", vols), null);

// Early growth: the first 4 quarters after listing, each vs a year earlier.
const q = (date: string, revenue: number, netIncome: number) => ({ date, revenue, netIncome });
const qs = [q("2023-03-31", 100, 10), q("2023-06-30", 100, 10), q("2023-09-30", 100, 10), q("2023-12-31", 100, 10), q("2024-03-31", 130, 14), q("2024-06-30", 125, 13), q("2024-09-30", 110, 11), q("2024-12-31", 140, 15)];
const eg = earlyGrowth(qs, "2024-02-15")!;
assert.equal(eg.quarters.length, 4);
assert.equal(eg.measured, 4);
assert.equal(eg.strong, 3); // Sep-24 only +10%
assert.equal(eg.ok, true);
assert.equal(earlyGrowth(qs, "2025-06-01"), null);

console.log("ipo-v2 ok");
