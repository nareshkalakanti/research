/**
 *   npx tsx test/ttm.test.ts
 */
import assert from "node:assert/strict";
import { trailingYear } from "../src/lib/ttm";

const now = Date.parse("2026-11-20T00:00:00Z");
const rows = (ds: string[]) => ds.map((date, i) => ({ date, v: i + 1 }));

// Four consecutive quarters.
assert.equal(trailingYear(rows(["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"]), now)!.length, 4);
// SME half-yearly filer: 4 rows = 2 years → use the last 2 halves.
const h = trailingYear(rows(["2024-09-30", "2025-03-31", "2025-09-30", "2026-03-31"]), now)!;
assert.deepEqual(h.map((r) => r.date), ["2025-09-30", "2026-03-31"]);
// Gap (2023 → 2026): not a trailing year.
assert.equal(trailingYear(rows(["2023-06-30", "2023-09-30", "2023-12-31", "2026-09-30"]), now), null);
// Missing a quarter in the middle.
assert.equal(trailingYear(rows(["2025-06-30", "2026-03-31", "2026-06-30", "2026-09-30"]), now), null);
// Stale: newest result older than 300 days.
assert.equal(trailingYear(rows(["2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30"]), now), null);
// Unsorted input is fine.
assert.equal(trailingYear(rows(["2026-09-30", "2025-12-31", "2026-06-30", "2026-03-31"]), now)!.at(-1)!.date, "2026-09-30");
// Too few rows.
assert.equal(trailingYear(rows(["2026-09-30"]), now), null);
// Quarterly filer with June missing: Mar + Sep must not pass as two halves.
assert.equal(trailingYear(rows(["2025-12-31", "2026-03-31", "2026-09-30"]), now), null);
// Quarterly filer whose June row exists but has no figure → no trailing year.
const withGap = [{ date: "2025-12-31", v: 1 }, { date: "2026-03-31", v: 1 }, { date: "2026-06-30", v: null }, { date: "2026-09-30", v: 1 }];
assert.equal(trailingYear(withGap, now, (r) => r.v != null), null);
// Half-yearly filer whose latest half has no figure yet → null, not an older pair.
const hNull = [{ date: "2025-03-31", v: 1 }, { date: "2025-09-30", v: 1 }, { date: "2026-03-31", v: null }];
assert.equal(trailingYear(hNull, now, (r) => r.v != null), null);
console.log("ttm ok");
