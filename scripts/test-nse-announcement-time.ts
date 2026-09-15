/**
 * NSE announcement timestamps + Today/Yesterday IST day keys.
 * Run: npx tsx scripts/test-nse-announcement-time.ts
 */
import assert from "node:assert/strict";
import {
  formatNseApiDateFromInstant,
  istDateKey,
  istDayWindow,
  istTodayParts,
  parseNseDateTime,
  repairLegacyNseIso,
} from "../src/lib/nse-time";
import { windowRange } from "../src/lib/strategy/concall-drift-quarters";

function main() {
  // NSE wall clock must not depend on host TZ
  const evening = parseNseDateTime("10-09-2026 21:52:41");
  assert.ok(evening);
  assert.equal(istDateKey(evening!), "2026-09-10");

  const late = parseNseDateTime("14-09-2026 23:30:00");
  assert.ok(late);
  assert.equal(istDateKey(late!), "2026-09-14");

  // Legacy stuffed UTC ISO (IST digits written as Z)
  const legacy = repairLegacyNseIso("2026-09-10T21:52:41.000Z");
  assert.ok(legacy);
  assert.equal(istDateKey(legacy!), "2026-09-10");

  const today = windowRange("today");
  const yest = windowRange("yesterday");
  assert.ok(today && yest);
  const todayKey = today!.from.toISOString().slice(0, 10);
  const yestKey = yest!.from.toISOString().slice(0, 10);
  assert.notEqual(todayKey, yestKey);
  assert.equal(istDateKey(evening!), "2026-09-10");

  // Evening filing must not land in "next IST day" bucket
  assert.notEqual(istDateKey(evening!), "2026-09-11");

  // API date strings follow IST civil day, not host local getters
  const win = istDayWindow(0);
  const parts = istTodayParts();
  const expected = `${String(parts.day).padStart(2, "0")}-${String(parts.month).padStart(2, "0")}-${parts.year}`;
  assert.equal(win.nseApiFrom, expected);
  assert.equal(formatNseApiDateFromInstant(new Date()), expected);

  console.log("ok — NSE announcement IST day keys", {
    evening: istDateKey(evening!),
    late: istDateKey(late!),
    todayKey,
    yestKey,
    nseApiToday: expected,
    hostTz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

main();
