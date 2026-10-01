import assert from "node:assert/strict";
import { hintListingFitsQuery } from "../src/lib/listing-name-match";

assert.equal(
  hintListingFitsQuery(
    "Lotus Chocolate Company",
    "RENUKA",
    "Shree Renuka Sugars Limited",
  ),
  false,
);
assert.equal(
  hintListingFitsQuery(
    "Lotus Chocolate Company",
    "LOTUSCHO",
    "Lotus Chocolate Company Ltd.",
  ),
  true,
);
console.log("ok");
