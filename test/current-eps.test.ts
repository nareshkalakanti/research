/**
 *   npx tsx test/current-eps.test.ts
 */
import assert from "node:assert/strict";
import { ttmEpsFromQuarters } from "../src/lib/napkin/current-eps";

const now = Date.parse("2026-10-01");
const q = (date: string, eps: number | null) => ({ date, eps });

const four = [
  q("2025-06-30", 2),
  q("2025-09-30", 3),
  q("2025-12-31", 4),
  q("2026-03-31", 5),
  q("2026-06-30", 6),
];
assert.equal(ttmEpsFromQuarters(four, now), 18, "last four quarters summed");
assert.equal(ttmEpsFromQuarters([...four].reverse(), now), 18, "order does not matter");

assert.equal(ttmEpsFromQuarters(four.slice(0, 3), now), null, "needs four quarters");
assert.equal(
  ttmEpsFromQuarters([q("2025-03-31", 1), q("2025-06-30", 1), q("2025-12-31", 1), q("2026-06-30", 1)], now),
  null,
  "gap in quarters",
);
assert.equal(ttmEpsFromQuarters(four, Date.parse("2027-08-01")), null, "latest quarter too old");
assert.equal(
  ttmEpsFromQuarters([q("2025-06-30", 2), q("2025-09-30", null), q("2025-12-31", 4), q("2026-03-31", 5), q("2026-06-30", 6)], now),
  null,
  "missing EPS breaks the consecutive run",
);
assert.equal(
  ttmEpsFromQuarters([q("2025-09-30", -2), q("2025-12-31", 1), q("2026-03-31", 1), q("2026-06-30", 1)], now),
  1,
  "losses are kept, not zeroed",
);

console.log("current-eps: ok");
