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
seg(100, 160, 30, 150); // steady rise after listing: every day green (urgency)
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
assert.equal(a.green_days, 9);
assert.equal(a.days_seen, 9);
assert.equal(a.weeks_seen, 8);
assert.ok(a.run_pct! >= 50);

// Urgency is green bars, not size: a big pop then up-down chop has no urgency.
const chop = [100, 150, ...Array.from({ length: 70 }, (_, i) => (i % 2 ? 151 : 149) + (i % 7 === 0 ? -3 : 0))];
const ch = analyzeIpo2(chop.map((close, i) => ({ date: dates[i]!, close, volume: 100 })))!;
assert.ok(ch.run_pct! >= 50, "big listing run");
assert.ok(ch.green_days! < 6, `green days ${ch.green_days}`);
assert.equal(ch.urgency, false);
// Six green weeks out of eight (small steady gains, red days inside the weeks) is urgency.
// Listed on a Sunday so each 7-day block is one Mon–Sun week; the listing week itself is flat (not green).
const sun = Date.UTC(2025, 0, 5);
const weekly: number[] = [100];
for (let w = 0; w < 8; w++)
  for (let dd = 0; dd < 7; dd++) {
    const last = weekly[weekly.length - 1]!;
    weekly.push(dd % 2 ? last - 1 : w === 3 ? last - 0.5 : last + 2); // block 3 red
  }
const wkDates = weekly.map((_, i) => new Date(sun + i * 86_400_000).toISOString().slice(0, 10));
const wkA = analyzeIpo2(weekly.map((close, i) => ({ date: wkDates[i]!, close, volume: 100 })))!;
assert.ok(wkA.green_days! < 6, `green days ${wkA.green_days}`);
assert.equal(wkA.green_weeks, 6, `green weeks ${wkA.green_weeks}`);
assert.equal(wkA.urgency, true);
assert.equal(a.bases.length, 1);
assert.equal(a.bases[0]!.status, "breakout");
assert.ok(a.bases[0]!.depth_pct > 18 && a.bases[0]!.depth_pct < 26);
const kinds = a.entries.map((e) => e.kind);
// Climbing straight out of listing: the listing-range breakout on day 3 comes first.
assert.deepEqual(kinds, ["ipo_range", "low_cheat", "pivot", "add"], kinds.join(","));
assert.equal(a.entries[0]!.idx, 3);
const pivot = a.entries[2]!;
assert.equal(pivot.level, 160);
assert.ok(pivot.risk_pct <= 8, `pivot stop capped at 8%: ${pivot.risk_pct}`);
assert.ok(pivot.vol_x! >= 1.5);
assert.equal(a.entries[3]!.label, "E1B add");
assert.equal(a.legs, 2);

// IREDA-like listing: tight range for a week after listing, then a close above it.
const ireda = [60, 65, 63, 65, 63, 64, 64, 71, 85, 102, 112, 120, 118, 121];
const ir = analyzeIpo2(ireda.map((close, i) => ({ date: dates[i]!, close, volume: 100 })))!;
const rb = ir.entries[0]!;
assert.equal(rb.kind, "ipo_range");
assert.equal(rb.label, "Listing-range breakout");
assert.equal(rb.idx, 7);
assert.equal(rb.level, 65);
assert.equal(rb.stop, 60); // post-listing low, within the 8% cap
assert.equal(ir.entries.filter((e) => e.kind === "ipo_range").length, 1);
// Too late (after 15 sessions) or too wide a range: no listing-range breakout.
const late = [100, ...Array.from({ length: 16 }, (_, i) => 95 + (i % 3)), 110];
assert.ok(!analyzeIpo2(late.map((close, i) => ({ date: dates[i]!, close, volume: 100 })))!.entries.some((e) => e.kind === "ipo_range"));
const wide = [100, 120, 98, 100, 104, 108, 125];
assert.ok(!analyzeIpo2(wide.map((close, i) => ({ date: dates[i]!, close, volume: 100 })))!.entries.some((e) => e.kind === "ipo_range"));

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

// First run from the issue price: issue 80, listed at 100 (+25% day 1), best close 160 → +100%.
const fromIssue = analyzeBases(px.map((close, i) => ({ date: dates[i]!, close, volume: vol[i] })), { listed: true, issuePrice: 80 })!;
assert.equal(fromIssue.run_base, "issue");
assert.equal(fromIssue.listing_gain_pct, 25);
assert.equal(fromIssue.run_pct, 100);
assert.equal(a.run_base, "first_close");
// Prices adjusted for a later 1:10 split, issue price not: issue 900 vs day-1 close 100 → not used.
const splitIssue = analyzeBases(px.map((close, i) => ({ date: dates[i]!, close, volume: vol[i] })), { listed: true, issuePrice: 900 })!;
assert.equal(splitIssue.issue_mismatch, true);
assert.equal(splitIssue.run_base, "first_close");

console.log("ipo2 ok");
