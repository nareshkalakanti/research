import assert from "node:assert/strict";
import {
  listingQueryMatches,
  rankListingQuery,
  scoreListingName,
  shouldAugmentListingSearch,
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
assert.ok(
  rankListingQuery(
    "Foo Investment Consultancy Ltd",
    "FOOINV",
    "Foo Investment & Consultancy Ltd.",
  ) <= 3,
);
assert.equal(
  listingQueryMatches(
    "Foo Investment &amp; Consultancy Ltd.",
    "FOOINV",
    "Foo Investment & Consultancy Ltd.",
  ),
  true,
);
assert.equal(
  listingQueryMatches(
    "Foo Motor Agency (Delhi) Ltd",
    "FOOMA",
    "Foo Motor Agency (Delhi) Limited",
  ),
  true,
);
assert.ok(
  rankListingQuery(
    "Foo Auto International Ltd",
    "FOOAUTO",
    "Foo Auto International Ltd",
  ) <
    rankListingQuery(
      "Foo Auto International Ltd",
      "FOOAUTO-RE",
      "Foo Auto International Ltd",
    ),
);
assert.ok(
  rankListingQuery(
    "Baz Ganesh Bio-Tech (India)",
    "BAZBIO",
    "Baz Ganesh Biotech India Ltd",
  ) <= 1,
);
assert.ok(
  scoreListingName(
    "Foo Breweries Distilleries Ltd",
    "FOO",
    "Foo Limited",
  ) < 70,
);
assert.ok(
  rankListingQuery(
    "Foo Breweries Distilleries Ltd",
    "FOO",
    "Foo Limited",
  ) > 3,
);
assert.ok(
  scoreListingName(
    "Foo Breweries And Distilleries Ltd",
    "FOOBREW",
    "Foo Breweries And Distilleries Ltd",
  ) >= 88,
);
assert.equal(
  listingQueryMatches(
    "Ravikumar Distilleries Ltd",
    "FOORK",
    "Ravi Kumar Distilleries Limited",
  ),
  true,
);
assert.equal(
  listingQueryMatches("FOO", "FOO", "Foo Limited"),
  true,
);
assert.equal(
  shouldAugmentListingSearch("FOO", [{ ticker: "FOO", name: "Foo Limited" }], 12),
  true,
);
assert.equal(
  shouldAugmentListingSearch(
    "Foo Motor Agency",
    [{ ticker: "FOOMA", name: "Foo Motor Agency Ltd" }],
    12,
  ),
  false,
);
assert.equal(
  listingQueryMatches("fooble", "FAOBLE", "Faoble Cables Limited"),
  true,
);
assert.equal(
  listingQueryMatches("macro", "MARCOX", "Marco Cables Limited"),
  true,
);
assert.equal(
  listingQueryMatches("macro cables", "MARCOX", "Marco Cables Limited"),
  true,
);
assert.equal(
  listingQueryMatches(
    "fooble cables condusctrs",
    "FAOBLE",
    "Faoble Cables & Conductors Limited",
  ),
  true,
);
assert.equal(
  listingQueryMatches(
    "alphaable cable maufacturing",
    "ALPHAB",
    "Alphab Cable Manufacturing Ltd",
  ),
  true,
);
assert.equal(
  listingQueryMatches(
    "alphaable cable maufacturing",
    "ALPHADATA",
    "Alphaable Data Services Ltd",
  ),
  false,
);
console.log("ok");
