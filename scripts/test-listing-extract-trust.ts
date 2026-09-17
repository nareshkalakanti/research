/**
 * Listing vs website-extract trust (no network).
 * Run: npx tsx scripts/test-listing-extract-trust.ts
 */
import assert from "node:assert/strict";
import {
  extractConflictsWithListing,
  phraseGroundedInListing,
  preferSpecificHeadline,
  stripQuarterlyFromHeadline,
} from "../src/lib/listing-extract-trust";

function main() {
  const metalsListing =
    "An Indian non-ferrous metal recycling company manufacturing primary aluminium alloys, zinc alloy ingots, aluminium billets, and segregated furnace-ready scrap of stainless steel, copper, brass, zinc, lead, and magnesium, serving aerospace, automotive, construction, chemical, electrical, marine oil, and petroleum sectors.";
  const itExtract =
    "Provides information technology services, software development, digital transformation, and IT-enabled solutions.";
  const itBlurb =
    "Provides IT services, software development, digital transformation, and IT-enabled solutions.";
  const itListing =
    "The company provides information technology services, software development, digital transformation, and IT-enabled solutions to enterprise clients in banking and insurance.";
  const metalsSite =
    "The group manufactures recycled aluminium alloys, zinc alloy ingots, aluminium billets, and furnace-ready scrap of stainless steel and copper for automotive and aerospace foundries.";

  assert.equal(extractConflictsWithListing(metalsListing, itExtract), true);
  assert.equal(extractConflictsWithListing(metalsListing, itBlurb), true);
  assert.equal(extractConflictsWithListing(itListing, itExtract), false);
  assert.equal(extractConflictsWithListing(metalsListing, metalsSite), false);
  assert.equal(extractConflictsWithListing(metalsListing, ""), false);

  assert.equal(phraseGroundedInListing(metalsListing, "IT Services"), false);
  assert.equal(phraseGroundedInListing(metalsListing, "aluminium alloys"), true);
  assert.equal(phraseGroundedInListing(itListing, "software development"), true);

  assert.equal(
    stripQuarterlyFromHeadline("Steel Manufacturer with Inconsistent Sales"),
    "Steel Manufacturer",
  );
  const alloyListing =
    "The company manufactures alloy steel, stainless steel and pipes such as seamless tubes and rolled products.";
  assert.equal(
    preferSpecificHeadline({
      headline: "Steel Manufacturer with Inconsistent Sales",
      listing: alloyListing,
      businessModel: "Manufacturer of Alloy & Stainless-Steel products",
      products: "Alloy & Stainless-Steel products, Stainless Steel Pipes & Tubes",
    }),
    "Manufacturer of Alloy & Stainless-Steel products",
  );

  console.log("test-listing-extract-trust: all passed");
}

main();
