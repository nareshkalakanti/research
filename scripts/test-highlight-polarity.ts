import assert from "node:assert/strict";
import { polarityFromHighlightText } from "../src/lib/highlight-polarity";
import { enforceSlotSemantics } from "../src/lib/highlight-slot-enforce";

assert.equal(
  polarityFromHighlightText("Capacity Addition", "negative"),
  "positive",
);
assert.equal(
  polarityFromHighlightText("Supply Chain Complexity", "negative"),
  "negative",
);
assert.equal(
  polarityFromHighlightText("Strong Pallet Market Opportunity", "positive"),
  "positive",
);
assert.equal(
  polarityFromHighlightText("Capacity delay to FY28", "positive"),
  "negative",
);
assert.equal(
  polarityFromHighlightText("Margin Compression", "positive"),
  "negative",
);

const slotted = enforceSlotSemantics({
  highlights: [
    {
      headline: "Supply Chain Complexity",
      sentiment: "NEGATIVE",
      score: 4,
    },
    {
      headline: "Capacity Addition",
      sentiment: "NEGATIVE",
      score: 4,
    },
    {
      headline: "Strong Pallet Market Opportunity",
      sentiment: "POSITIVE",
      score: 8,
    },
  ],
});
const cap = slotted.highlights.find((h) => /capacity/i.test(h.headline));
assert.ok(cap);
assert.notEqual(cap!.sentiment, "NEGATIVE");
console.log("ok");
