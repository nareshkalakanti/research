/**
 *   npx tsx test/breakout-screen.test.ts
 */
import assert from "node:assert/strict";
import { basePullbacks, detectBreakout, detectFreshBreakout, isCoiling, passesUniverse } from "../src/lib/breakout-screen";
import type { Close } from "../src/lib/rotation-bars";

const days = (n: number, start = Date.UTC(2025, 0, 1)) =>
  Array.from({ length: n }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));

/**
 * Volume in shares so ₹ Cr traded (close×vol/1e7) clears the ₹1cr floor, then dries in the base.
 * Lead is long enough for a 200-day SMA (universe gate).
 */
const series = (closes: number[], start?: number, baseFrom = 220): Close[] => {
  const d = days(closes.length, start);
  return closes.map((close, i) => {
    const inBase = i >= baseFrom;
    const baseI = i - baseFrom;
    // ~₹2–5 Cr/day early, drying toward ~₹1 Cr late in the base.
    const volume = inBase ? Math.max(120_000, 500_000 - baseI * 12_000) : 400_000;
    return { date: d[i]!, close, volume };
  });
};
const lead = Array.from({ length: 220 }, (_, i) => 40 + i * (60 / 219)); // slow grind to ~100

// Tightening late base (ATR + volume dry) → VCP.
const vcpBase = [
  100, 92, 98, 88, 97, 90, 96, 91, 95, 92, 94.5, 93, 94, 93.5, 94.2, 93.8, 94.5, 94.8, 95.2, 95.5, 96, 96.5, 97, 97.5, 98,
  98.5, 99, 99.5,
];
const vcpSeries = series([...lead, ...vcpBase, 101]);
assert.ok(isCoiling(vcpSeries, lead.length, vcpSeries.length - 1), "VCP base should coil");
const vcp = detectBreakout(vcpSeries, { rs: 75 })!;
assert.ok(vcp, "breakout found");
assert.ok(vcp.screen === "vcp" || vcp.also.includes("vcp"), `VCP: ${vcp.screen} ${vcp.also}`);
assert.ok(basePullbacks(series(vcpBase, undefined, 0), 0, vcpBase.length).length >= 2);

// Pullbacks that keep getting deeper (the deepest is the last) are not a VCP.
const wide = [100, 97, 99, 94, 98, 88, 96, 84, 86, 88, 90, 92, 94, 95, 96, 97, 98, 99, 99.5];
const nv = detectBreakout(series([...lead, ...wide, 102]), { rs: 75 });
assert.ok(!nv || (nv.screen !== "vcp" && !nv.also.includes("vcp")), "widening base is not a VCP");

// A big first close through the pivot (+9%) still counts; a day later, 9% above is extended.
const big = detectBreakout(series([...lead, ...vcpBase, 108.5]), { rs: 75 })!;
assert.ok(big, "big breakout day counts");
assert.equal(detectBreakout(series([...lead, ...vcpBase, 104, 108.5]), { rs: 75 }), null);

// Base deeper than 35% is rejected for short bases.
const deep = [100, 60, 65, 70, 75, 80, 85, 88, 90, 92, 94, 95, 96, 97, 98, 99, 99.5];
assert.equal(detectBreakout(series([...lead, ...deep, 102]), { rs: 75 }), null, "≤35% depth");

// Multi-year: 52+ week base may be deeper than 35% and still count.
const multiLead = Array.from({ length: 220 }, (_, i) => 40 + i * (60 / 219)); // → ~100, enough for SMA200
const multiBase: number[] = [];
for (let i = 0; i < 260; i++) {
  // Pivot 100, trough ~55 (45% deep), then grind back to ~99.5
  if (i < 40) multiBase.push(100 - (i / 40) * 45);
  else if (i < 220) multiBase.push(55 + ((i - 40) / 180) * 43);
  else multiBase.push(98 + ((i - 220) / 39) * 1.5);
}
const multiSeries = series([...multiLead, ...multiBase, 101], undefined, multiLead.length);
const multiHit = detectBreakout(multiSeries, { rs: 65 })!;
assert.ok(multiHit, "multi-year deep base found");
assert.ok(multiHit.screen === "multi" || multiHit.also.includes("multi"), `multi tag: ${multiHit.screen}`);
assert.ok((multiHit.base_weeks ?? 0) >= 50, `base weeks ${multiHit.base_weeks}`);

// IPO base: listed recently (<50 weeks) — any qualifying base tags IPO.
const ipo = series([...lead, ...vcpBase, 101], Date.UTC(2026, 0, 1));
const hit = detectBreakout(ipo, { listing: "2026-01-01", rs: null })!;
assert.ok(hit.screen === "ipo" || hit.also.includes("ipo"), `IPO base: ${hit.screen}`);
// Listed long ago: no IPO base tag.
const old = detectBreakout(ipo, { listing: "2020-01-01", rs: 75 })!;
assert.ok(old.screen !== "ipo" && !old.also.includes("ipo"));
// Very young IPO (<50 bars): 50-day waived, still tags IPO.
const youngLead = Array.from({ length: 20 }, (_, i) => 80 + i * 0.9); // stays under 100
const youngBase = [100, 94, 98, 92, 96, 93, 95, 94, 96, 97, 97.5, 98, 98.5, 99, 99.2, 99.5];
const young = series([...youngLead, ...youngBase, 101], Date.UTC(2026, 6, 1), youngLead.length);
const youngHit = detectBreakout(young, { listing: "2026-06-01", rs: null });
assert.ok(youngHit, "young IPO breakout found");
assert.ok(youngHit.screen === "ipo" || youngHit.also.includes("ipo"), `young IPO: ${youngHit.screen}`);
// Second base while still <50 weeks (not all-time) still tags IPO; pre-listing bars ignored.
const preIpo = Array.from({ length: 40 }, (_, i) => 150 - i); // earlier highs above the IPO range
const secondBase = [100, 92, 98, 88, 97, 90, 96, 91, 95, 92, 94.5, 93, 94, 93.5, 94.2, 93.8, 94.5, 94.8, 95.2, 95.5, 96, 96.5, 97, 97.5, 98, 98.5, 99, 99.5];
const second = series([...preIpo, ...secondBase, 101], Date.UTC(2025, 0, 1), preIpo.length);
const listingDate = second[preIpo.length]!.date;
const secondHit = detectBreakout(second, { listing: listingDate, rs: null });
assert.ok(secondHit, "second IPO-age base found");
assert.ok(secondHit.screen === "ipo" || secondHit.also.includes("ipo"), `second IPO base: ${secondHit.screen}`);
assert.ok((secondHit.base_weeks ?? 99) < 40, "pre-listing bars must not inflate the base");
// Fresh window: a breakout from 2 sessions ago still counts (StockScans “All 3 days”).
const freshBase = [100, 94, 98, 92, 96, 93, 95, 94, 96, 97, 97.5, 98, 98.5, 99, 99.2, 99.5];
// 101 = breakout day; 110/112 = extended (>5% above with prior already through) so today is null.
const fresh = series([...youngLead, ...freshBase, 101, 110, 112], Date.UTC(2026, 6, 1), youngLead.length);
const listingFresh = fresh[0]!.date;
assert.equal(detectBreakout(fresh, { listing: listingFresh, rs: null }), null, "extended past breakout day is not a today hit");
const freshHit = detectFreshBreakout(fresh, { listing: listingFresh, rs: null })!;
assert.ok(freshHit, "fresh lookback finds the breakout");
assert.ok(freshHit.screen === "ipo" || freshHit.also.includes("ipo"), `fresh IPO: ${freshHit.screen}`);
assert.equal(freshHit.breakout_date, fresh[fresh.length - 3]!.date);
assert.equal(freshHit.price, fresh[fresh.length - 1]!.close);

// Universe: liquidity + RS (mcap is UI-only; hard floor is 0).
assert.ok(passesUniverse(vcpSeries, { mcapCr: 50, rs: 80, screen: "vcp" }), "passes thin mcap when RS/liquidity ok");
assert.ok(passesUniverse(vcpSeries, { mcapCr: 400, rs: 40, screen: "ipo" }), "IPO waives RS");
assert.ok(!passesUniverse(vcpSeries, { mcapCr: 400, rs: 40, screen: "vcp" }), "non-IPO needs RS 70+");

console.log("breakout screen ok");
