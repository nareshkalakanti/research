import assert from "node:assert/strict";
import { bseAnnouncementDateWindows } from "../src/lib/bse-investor-discover";

const now = new Date("2026-09-22T12:00:00Z");
const wins = bseAnnouncementDateWindows(3, now);
assert.ok(wins.length >= 3);
for (const w of wins) {
  const days = (w.to.getTime() - w.from.getTime()) / 86400000;
  assert.ok(days <= 370, `window too long: ${days}`);
  assert.ok(w.to.getTime() >= w.from.getTime());
}
assert.ok(wins[0]!.to.getTime() >= now.getTime() - 86400000);

console.log("ok", wins.length, "windows");
