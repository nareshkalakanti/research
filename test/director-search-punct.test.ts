/**
 * Director search matches listed names even with trailing punctuation.
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import path from "node:path";
import { loadGovernanceMap } from "../src/lib/governance-map";

const db = new Database(path.join(process.cwd(), "data", "governance.db"), {
  readonly: true,
});
const row = db
  .prepare(
    `
    SELECT d.name
    FROM directors d
    JOIN board_seats s ON s.person_id = d.person_id
    WHERE d.name GLOB '*[.]'
      AND LENGTH(TRIM(d.name)) >= 8
    LIMIT 1
    `,
  )
  .get() as { name: string } | undefined;
db.close();

assert.ok(row, "need a director name with trailing punctuation");
const q = row.name.replace(/[.,]+$/g, "").trim();
assert.ok(q.length >= 3);
const hits = loadGovernanceMap({ q });
assert.ok(
  hits.some((h) => h.name.toLowerCase().startsWith(q.toLowerCase().slice(0, 8))),
  `search ${q} should find ${row.name}`,
);
