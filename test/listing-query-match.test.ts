import assert from "node:assert/strict";
import {
  listingQueryMatches,
  rankListingQuery,
} from "../src/lib/listing-name-match";

assert.equal(
  listingQueryMatches("MALX", "MAL", "Mangalam Alloys Limited"),
  true,
);
assert.equal(
  listingQueryMatches("MLOY", "LLOYDSENGG", "Lloyds Engineering Works Ltd."),
  false,
);
assert.ok(
  rankListingQuery("MAL", "MAL", "Mangalam Alloys Limited") <
    rankListingQuery("MAL", "MALLCOM", "Mallcom (India) Limited"),
);
assert.equal(
  rankListingQuery("ALPHA BETA", "ALPHABETA", "Alpha Beta Limited"),
  0,
);
assert.equal(
  listingQueryMatches("alpha beta", "ALPHABETA", "Alpha Beta Limited"),
  true,
);
assert.ok(
  rankListingQuery("alpha beta ltd", "ALPHABETA", "Alpha Beta Limited") <=
    rankListingQuery("alpha", "ALPHANUM", "Alphanum Limited"),
);
console.log("ok");
