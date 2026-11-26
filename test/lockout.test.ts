import assert from "node:assert/strict";
import { currentLockout, lockoutRallies } from "../src/lib/lockout";

// Daily bars Mon–Fri from Monday 6 Jan 2025; one weekly close per entry (all 5 days share it).
const series = (weekly: number[]) => {
  const out: { date: string; close: number }[] = [];
  const t0 = Date.UTC(2025, 0, 6);
  weekly.forEach((c, w) => {
    for (let d = 0; d < 5; d++) out.push({ date: new Date(t0 + (w * 7 + d) * 86_400_000).toISOString().slice(0, 10), close: c });
  });
  return out;
};
const flat = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 1 : -1));

// Stage 1 base, then 8 weeks with 6 up: a lockout rally, still running.
const run = [...flat, 104, 108, 107, 112, 116, 115, 120, 125];
const s = series(run);
const all = lockoutRallies(s);
assert.equal(all.length, 1);
assert.ok(all[0]!.green >= 6);
assert.ok(all[0]!.gain_pct > 20);
assert.ok(currentLockout(s, all));

// Only 5 of 8 up: not a lockout.
assert.equal(lockoutRallies(series([...flat, 104, 103, 107, 106, 110, 109, 113, 114])).length, 0);

// Already stretched far above the 30-week average when it starts (late stage 2): not a lockout.
const stretched = [...flat, ...Array.from({ length: 10 }, (_, i) => 110 + i * 8)];
const late = [...stretched, 200, 205, 204, 210, 216, 215, 222, 230];
assert.ok(!lockoutRallies(series(late)).some((l) => l.start_idx >= stretched.length * 5));

// Too little history for a 30-week read (a new listing): no lockout (urgency covers it).
assert.equal(lockoutRallies(series([100, 104, 108, 107, 112, 116, 115, 120, 125])).length, 0);

// Ended months ago: not current.
const old = series([...run, ...Array.from({ length: 10 }, (_, i) => 125 - (i % 2 ? 3 : 1))]);
assert.equal(currentLockout(old), null);

// Base recorded: weeks since the base high.
assert.ok(all[0]!.base_weeks >= 7);

// A steady +2%/week uptrend with a 3-week dip, no 7-week base: not a lockout.
const trend: number[] = [];
for (let i = 0; i < 40; i++) trend.push(100 * 1.02 ** i * (i % 2 ? 1.005 : 0.995));
const dip = [...trend, trend[39]! * 0.97, trend[39]! * 0.96, trend[39]! * 0.98];
assert.equal(lockoutRallies(series([...dip, ...[2, 4, 3, 6, 8, 7, 10, 12].map((d) => trend[39]! * (1 + d / 100))])).length, 0);

console.log("lockout ok");
