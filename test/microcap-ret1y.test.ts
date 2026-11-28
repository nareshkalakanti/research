import assert from "node:assert/strict";
import {
  AVG_RET_1Y_CLIP_HI,
  AVG_RET_1Y_CLIP_LO,
  clipRet1yForAvg,
  microcapRet1yPct,
} from "../src/lib/microcap-sector-returns";
import {
  rotationWindowStart,
  windowReturnPct,
  rebaseCloses,
} from "../src/lib/sector-rotation-series";

/** ~1 trading year of flat then +20% on the last close. */
function synthBars(tip: string, startClose: number, endClose: number) {
  const out: Array<{ date: string; close: number }> = [];
  const end = new Date(`${tip}T12:00:00Z`);
  // ~400 calendar days of daily bars so 370d window is covered.
  for (let i = 400; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    // Skip weekends.
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const date = d.toISOString().slice(0, 10);
    out.push({ date, close: date === tip ? endClose : startClose });
  }
  return out;
}

const tip = "2026-11-27";
const bars = synthBars(tip, 100, 120);
const got = microcapRet1yPct(bars, tip);
assert.ok(got != null, "expected a 1Y return");
assert.ok(Math.abs(got! - 20) < 1e-6, `got ${got}, want 20`);

// Same answer as Trend's windowReturnPct on the shared 1Y start.
const start = rotationWindowStart(tip, "1Y");
const viaTrend = windowReturnPct(rebaseCloses(bars, "1970-01-01"), start, "1Y");
assert.ok(viaTrend != null);
assert.ok(Math.abs(got! - viaTrend!) < 1e-9);

// Stale tip (>10d before board tip) → null.
const staleTip = "2026-12-20";
assert.equal(microcapRet1yPct(bars, staleTip), null);

// Empty / short series → null.
assert.equal(microcapRet1yPct([], tip), null);
assert.equal(microcapRet1yPct([{ date: tip, close: 10 }], tip), null);

// Pocket/sector means clip extreme rockets; mid-range passes through (n unchanged).
assert.equal(clipRet1yForAvg(20), 20);
assert.equal(clipRet1yForAvg(-40), -40);
assert.equal(clipRet1yForAvg(9449), AVG_RET_1Y_CLIP_HI);
assert.equal(clipRet1yForAvg(-99), AVG_RET_1Y_CLIP_LO);
assert.equal(
  [10, 9449, -20].reduce((a, r) => a + clipRet1yForAvg(r), 0) / 3,
  (10 + AVG_RET_1Y_CLIP_HI + -20) / 3,
);

console.log("microcap-ret1y.test.ts: ok");
