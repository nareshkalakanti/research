/**
 * Unit checks for IST baseline + pending-session gate.
 * Run: npx tsx scripts/test-concall-drift-math.ts
 */
import assert from "node:assert/strict";
import {
  baselineCloseBefore,
  computeDriftPct,
  driftPctDisplayReady,
  hasPostCallTradingSession,
  istEventClock,
} from "../src/lib/strategy/concall-drift-math";

/** Fri 6 Nov 2026 bars through Fri; Sat call → Fri close (last session before weekend). */
const bars = [
  { date: "2026-11-04", close: 2500 },
  { date: "2026-11-05", close: 2582.9 },
  { date: "2026-11-06", close: 2963.2 },
];

// Sat 7 Nov 2026 14:08 IST = 08:38 UTC
const satCall = "2026-11-07T08:38:01.000Z";
assert.equal(istEventClock(satCall).ymd, "2026-11-07");
assert.equal(baselineCloseBefore(bars, satCall), 2963.2);
assert.equal(hasPostCallTradingSession(bars, satCall), false);
assert.equal(
  driftPctDisplayReady(satCall, new Date("2026-11-07T10:00:00.000Z")),
  false,
);
assert.equal(
  driftPctDisplayReady(satCall, new Date("2026-11-09T04:00:00.000Z")), // Mon 9:30 IST
  true,
);

// Fri after close 18:27 IST = 12:57 UTC → baseline = Fri close; pending until next TD
const friAfterClose = "2026-11-06T12:57:44.000Z";
assert.equal(baselineCloseBefore(bars, friAfterClose), 2963.2);
assert.equal(hasPostCallTradingSession(bars, friAfterClose), false);
// Same-day Fri bar must not print 0% vs Fri close — wait for next session.
assert.equal(
  driftPctDisplayReady(friAfterClose, new Date("2026-11-07T10:00:00.000Z")),
  false,
);

// Fri during session — once Fri bar exists, post-concall anchor is Fri close
// (not Thu — that would include the announcement-day move).
const friMidday = "2026-11-06T07:30:00.000Z"; // 13:00 IST
assert.equal(baselineCloseBefore(bars, friMidday), 2963.2);
assert.equal(hasPostCallTradingSession(bars, friMidday), false);

// Fri before open, Fri bar not in yet → prior close (session still open / incomplete)
const beforeFriBar = [
  { date: "2026-11-04", close: 2500 },
  { date: "2026-11-05", close: 2582.9 },
];
const friBeforeOpen = "2026-11-06T02:00:00.000Z"; // 07:30 IST
assert.equal(baselineCloseBefore(beforeFriBar, friBeforeOpen), 2582.9);

// Once Monday bar exists, weekend call has a post session
const withMon = [...bars, { date: "2026-11-09", close: 3000 }];
assert.equal(hasPostCallTradingSession(withMon, satCall), true);
assert.equal(computeDriftPct(2963.2, 2963.2), 0);

// Yahoo sometimes stamps a Sunday live quote as a bar — must not unlock % since.
const withSunGhost = [...bars, { date: "2026-11-08", close: 2970 }];
assert.equal(hasPostCallTradingSession(withSunGhost, satCall), false);
assert.equal(baselineCloseBefore(withSunGhost, satCall), 2963.2);
assert.equal(
  driftPctDisplayReady(satCall, new Date("2026-11-08T06:00:00.000Z")), // Sun noon IST
  false,
);

console.log("ok — concall-drift-math baseline + pending gate");
