/**
 * Same folded name on the same listed boards collapses to one director.
 */
import assert from "node:assert/strict";
import {
  collapseSameBoardDirectors,
  dateShapedDin,
} from "../src/lib/governance-map";

const kept = collapseSameBoardDirectors([
  {
    person_id: "date-id",
    name: "Patel A.",
    din: "20190703",
    tickers: ["AAA"],
    dir_score: 1,
  },
  {
    person_id: "00011111",
    name: "PATEL A",
    din: "00011111",
    tickers: ["AAA"],
    dir_score: 1,
  },
]);
assert.equal(kept.length, 1);
assert.equal(kept[0]!.din, "00011111");
assert.equal(dateShapedDin("20190703"), true);
assert.equal(dateShapedDin("00011111"), false);

const twoBoards = collapseSameBoardDirectors([
  {
    person_id: "p1",
    name: "Same Name",
    din: "00000001",
    tickers: ["AAA"],
  },
  {
    person_id: "p2",
    name: "Same Name",
    din: "00000002",
    tickers: ["BBB"],
  },
]);
assert.equal(twoBoards.length, 2);
