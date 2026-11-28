/**
 * StockScans company-page parser — Industry + Sector from peer payloads.
 */
import assert from "node:assert/strict";
import { normalizeSsLabel, parseCompanyPage } from "../src/lib/stockscans";

/** Escaped RSC-style blob (as StockScans embeds in the page). */
const SAMPLE = String.raw`self.__next_f.push([1,"{\"companyId\":\"NSE:TCS\",\"Name\":\"Tata Consultancy Services Ltd\",\"Industry\":\"IT Services\",\"Sector\":\"IT Software\",\"Market Capitalization\":1}{\"companyId\":\"NSE:INFY\",\"Name\":\"Infosys Ltd\",\"Sector\":\"IT Software\",\"Industry\":\"IT Services\",\"Fundamentals Type\":\"O\"}"])`;

const rows = parseCompanyPage(SAMPLE, "NSE:TCS");
assert.equal(rows.length, 2);

const tcs = rows.find((r) => r.company_id === "NSE:TCS");
assert.ok(tcs);
assert.equal(tcs!.industry, "IT Services");
assert.equal(tcs!.sector, "IT Software");
assert.equal(tcs!.name, "Tata Consultancy Services Ltd");

/** Sector before Industry still parses. */
const infy = rows.find((r) => r.company_id === "NSE:INFY");
assert.ok(infy);
assert.equal(infy!.sector, "IT Software");
assert.equal(infy!.industry, "IT Services");

/** "Foo & Bar" (and unicode &) normalize to "Foo and Bar". */
assert.equal(normalizeSsLabel("Aerospace & Defence"), "Aerospace and Defence");
const amp = parseCompanyPage(
  '{"companyId":"NSE:TONBO","Name":"Tonbo","Industry":"Electronics - Others","Sector":"Aerospace \\u0026 Defence"}',
  "NSE:TONBO",
);
assert.equal(amp[0]!.sector, "Aerospace and Defence");

/** Header fallback when peers missing — industry only. */
const bare = parseCompanyPage(
  `<html><title>Example Co share price</title><span class="industryText">Trading</span></html>`,
  "NSE:EXAMPLE",
);
assert.equal(bare.length, 1);
assert.equal(bare[0]!.industry, "Trading");
assert.equal(bare[0]!.sector, null);

console.log("stockscans-parse.test.ts: ok");