/**
 * Unit tests for MarketIQ fund-name contains matching + highlight segments.
 * Run: npm run test:marketiq-funds
 */
import assert from "assert";
import {
  highlightMarketIqFundSegments,
  listMarketIqFundAliasCatalog,
  matchMarketIqFundsInText,
  normalizeFundMatchText,
} from "../src/lib/marketiq-fund-aliases";

function main() {
  const catalog = listMarketIqFundAliasCatalog();
  assert.ok(catalog.length >= 20, `expected ≥20 catalog funds, got ${catalog.length}`);

  const sample = `
    Annexure – Institutional Investors
    1. Green Lantern Capital Growth Fund
    2. Buoyant Opportunities PMS
    3. Negen Capital PMS
    4. Niveshaay Hedgehogs Fund
    5. Niveshaay Sambhav Fund
    6. Alchemy High Growth PMS
    7. White Oak India Pioneers Equity Portfolio
    8. Lucky Wealth Management
    Some noise: mutual fund industry overview.
  `;

  const hits = matchMarketIqFundsInText(sample);
  const keys = hits.map((h) => h.chip_key).sort();
  assert.deepStrictEqual(
    keys,
    [
      "alchemy",
      "buoyant",
      "greenlantern",
      "lucky",
      "negen",
      "niveshaay",
      "whiteoak",
    ],
    `unexpected keys: ${keys.join(",")}`,
  );

  const niveshaay = hits.find((h) => h.chip_key === "niveshaay");
  assert.equal(niveshaay?.alias, "Niveshaay");
  assert.equal(
    hits.filter((h) => h.chip_key === "niveshaay").length,
    1,
    "two Niveshaay products → one chip",
  );

  // Punctuation / case tolerant
  const messy = matchMarketIqFundsInText(
    "GREEN-LANTERN  CAPITAL   GROWTH  FUND attended the meet.",
  );
  assert.equal(messy[0]?.chip_key, "greenlantern");

  // Extra haystacks (annexure lines)
  const viaExtra = matchMarketIqFundsInText("Schedule of investor meet", [
    "Stallion India Focus",
    "MoneyGrow Small Midcap Strategy",
  ]);
  assert.deepStrictEqual(
    viaExtra.map((h) => h.chip_key).sort(),
    ["moneygrow", "stallion"],
  );

  // No false positive on short unrelated text
  assert.deepStrictEqual(matchMarketIqFundsInText("No funds here."), []);

  // Advisory / plant-visit conductor (full legal name in announcement body)
  const neo = matchMarketIqFundsInText(
    "The visit will be conducted by NeoAtlas Capital Advisory LLP. No UPSI.",
  );
  assert.equal(neo[0]?.chip_key, "neoatlas");
  assert.equal(neo[0]?.alias, "NeoAtlas");
  const neoAliasOnly = matchMarketIqFundsInText(
    "Organised with NeoAtlas for the plant visit.",
  );
  assert.equal(neoAliasOnly[0]?.chip_key, "neoatlas");

  // NSE annexure uses "Lucky Investments" (not Wealth Management)
  const luckyFiling = matchMarketIqFundsInText(
    "7\nLucky Investments\n8\nMastergrowth 369 Asset Managers",
  );
  assert.equal(luckyFiling[0]?.chip_key, "lucky");

  const segs = highlightMarketIqFundSegments(sample, hits);
  const marked = segs.filter((s) => s.hit).map((s) => s.text);
  assert.ok(
    marked.some((t) => /green lantern capital growth fund/i.test(t)),
    "should highlight Green Lantern full name",
  );
  assert.ok(
    segs.some((s) => !s.hit && /Annexure/i.test(s.text)),
    "non-hit segments preserved",
  );

  assert.equal(
    normalizeFundMatchText("Foo & Bar—Baz"),
    "foo and bar baz",
  );

  console.log(
    `ok · ${hits.length} funds matched · ${catalog.length} catalog entries`,
  );
}

main();
