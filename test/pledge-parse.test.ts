/**
 *   npx tsx test/pledge-parse.test.ts
 * Screener reports pledge as a % of the promoters' own shares.
 */
import assert from "node:assert/strict";
import { parsePledgeFromHtml } from "../src/lib/screener-shareholding";

// Annapurna Swadisht (Screener "Cons" list).
assert.equal(parsePledgeFromHtml("<ul><li>Company has a low return on equity of 10.4% over last 3 years.</li><li>Promoters have pledged 87.4% of their holding.</li></ul>"), 87.4);
// Singular wording.
assert.equal(parsePledgeFromHtml("<li>Promoter has pledged 12.8% of their holding.</li>"), 12.8);
// A change line: the new figure counts, not the old one.
assert.equal(parsePledgeFromHtml("<li>Promoters have reduced pledge from 30.5% to 10.2% in the last quarter.</li>"), 10.2);
// Unrelated percentages before the word "pledged" are not picked up.
assert.equal(parsePledgeFromHtml("<li>ROE 10.4%.</li><li>Nothing pledged by promoters.</li>"), null);
// Explicit none.
assert.equal(parsePledgeFromHtml("<p>Pledged: 0</p>"), 0);
// Nothing about pledge.
assert.equal(parsePledgeFromHtml("<p>Sales growth 12%</p>"), null);
console.log("pledge-parse ok");
