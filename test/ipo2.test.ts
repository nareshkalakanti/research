import assert from "node:assert/strict";
import { adjustCorporateActions, analyzeBases, analyzeIpo2, favouredSector, parseNseListingDate } from "../src/lib/ipo2";

// NSE list date formats.
assert.equal(parseNseListingDate("06-OCT-2008"), "2008-10-06");
assert.equal(parseNseListingDate("16-Nov-26"), "2026-11-16");
assert.equal(parseNseListingDate("bad"), null);

// Synthetic IPO: urgency run, a base with a low-cheat pause, pivot breakout, an E1B add.
const px: number[] = [];
const vol: number[] = [];
const seg = (from: number, to: number, days: number, v: number) => {
  for (let i = 1; i <= days; i++) {
    px.push(from + ((to - from) * i) / days);
    vol.push(v);
  }
};
px.push(100);
vol.push(300);
seg(100, 160, 30, 150); // +60% in 30 days: urgency
seg(160, 126, 12, 160); // heavy selling into the base (21% deep)
seg(126, 127, 8, 40); // tight, quiet pause in the lower third
seg(127, 145, 10, 90); // clears the pause: low cheat
seg(145, 158, 8, 60);
seg(158, 162, 2, 400); // above 160: pivot breakout on volume
seg(162, 185, 10, 150); // E1
seg(185, 176, 6, 60); // 5% pause
seg(176, 190, 5, 200); // new high: E1B add
const dates = px.map((_, i) => new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
const a = analyzeIpo2(px.map((close, i) => ({ date: dates[i]!, close, volume: vol[i] })))!;

assert.equal(a.urgency, true);
assert.ok(a.run_pct! >= 50);
assert.equal(a.bases.length, 1);
assert.equal(a.bases[0]!.status, "breakout");
assert.ok(a.bases[0]!.depth_pct > 18 && a.bases[0]!.depth_pct < 26);
const kinds = a.entries.map((e) => e.kind);
assert.deepEqual(kinds, ["low_cheat", "pivot", "add"], kinds.join(","));
const pivot = a.entries[1]!;
assert.equal(pivot.level, 160);
assert.ok(pivot.risk_pct <= 8, `pivot stop capped at 8%: ${pivot.risk_pct}`);
assert.ok(pivot.vol_x! >= 1.5);
assert.equal(a.entries[2]!.label, "E1B add");
assert.equal(a.legs, 2);

// Base deeper than 40% after listing: broken, no entries from it.
const deep = [100, ...Array.from({ length: 20 }, (_, i) => 100 - i * 3)];
const b = analyzeIpo2(deep.map((close, i) => ({ date: dates[i]!, close, volume: 100 })))!;
assert.equal(b.stage, "broken");
assert.equal(b.entries.length, 0);

// Unadjusted 1:1 bonus (price halves overnight): earlier prices halved, flagged, no fake failed base.
const pre = Array.from({ length: 60 }, (_, i) => 300 + i);
const post = Array.from({ length: 30 }, (_, i) => 180 + i);
const bonus = [...pre, ...post].map((close, i) => ({ date: dates[i]!, close, volume: 100 }));
const adj = adjustCorporateActions(bonus);
assert.equal(adj.actions.length, 1);
assert.equal(adj.actions[0]!.ratio, 0.5);
assert.equal(Math.round(adj.series[59]!.close), 180); // 359 × (180 / 359)
const ab = analyzeBases(bonus, { listed: false })!;
assert.equal(ab.corp_actions.length, 1);
assert.ok(ab.bases.every((b) => b.status !== "failed"));
// Ordinary 15% fall: not a corporate action.
assert.equal(adjustCorporateActions([{ date: dates[0]!, close: 100 }, { date: dates[1]!, close: 85 }]).actions.length, 0);

// Sector: industry decides; "Trading" under Pharma isn't favoured.
assert.equal(favouredSector("Trading", "Pharmaceuticals"), false);
assert.equal(favouredSector("Pharma Formulations", "Healthcare"), true);
assert.equal(favouredSector(null, "Healthcare"), true);

console.log("ipo2 ok");
