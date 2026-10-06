import assert from "node:assert/strict";
import { parseSectorScreenshot } from "../src/lib/sector-screenshot-parse";

const json = parseSectorScreenshot(`
{"industry":"Advertisement","names":["Signpost India Ltd","Mobavenue AI Tech Ltd","Affle 3i Ltd"]}
`);
assert.equal(json.industry, "Advertisement");
assert.deepEqual(json.names, [
  "Signpost India Ltd",
  "Mobavenue AI Tech Ltd",
  "Affle 3i Ltd",
]);

const fenced = parseSectorScreenshot(`
\`\`\`json
{ "industry": "Advertisement", "names": [ "Signpost India Ltd", "Mobavenue AI Tech Ltd", "Affie 3i Ltd" ] }
\`\`\`
\`\`\`json
{ "industry": "Advertisement", "names": [ "Signpost India Ltd" ] }
\`\`\`
`);
assert.equal(fenced.industry, "Advertisement");
assert.equal(fenced.names.length, 3);

const tsv = parseSectorScreenshot(`
Default Performance Technical Valuation Holdings
Showing 3 results
Name\tMarket Capitalization\tIndustry\tClose Price
1 Signpost India Ltd\t₹ 1,394 Cr\tAdvertisement\t₹ 260.85
2 Mobavenue AI Tech Ltd\t₹ 2,351 Cr\tAdvertisement\t₹ 304.15
3 Affle 3i Ltd\t₹ 20,345 Cr\tAdvertisement\t₹ 1,443.80
`);
assert.equal(tsv.industry, "Advertisement");
assert.equal(tsv.names.length, 3);
assert.ok(tsv.names.some((n) => /Signpost/i.test(n)));
assert.ok(tsv.names.some((n) => /Mobavenue/i.test(n)));
assert.ok(tsv.names.some((n) => /Affle/i.test(n)));

const html = parseSectorScreenshot(`
<table>
<tr><th>Name</th><th>Market Capitalization</th><th>Industry</th><th>Close Price</th></tr>
<tr><td>Foo Widgets Ltd</td><td>10 Cr</td><td>Capital Goods</td><td>12.5</td></tr>
<tr><td>Bar Widgets Ltd</td><td>20 Cr</td><td>Capital Goods</td><td>9</td></tr>
</table>
`);
assert.equal(html.industry, "Capital Goods");
assert.deepEqual(html.names, ["Foo Widgets Ltd", "Bar Widgets Ltd"]);

const headerOnly = parseSectorScreenshot(`
{"industry":"Industry","names":["Foo Widgets Ltd"]}
Name\tIndustry
Foo Widgets Ltd\tCapital Goods
`);
assert.equal(headerOnly.industry, "Capital Goods");
assert.ok(headerOnly.names.some((n) => /Foo Widgets/i.test(n)));

const rowJson = parseSectorScreenshot(`
\`\`\`json
{ "Name": "United Spirits Ltd", "Market Capitalization": "99,574 Cr", "Industry": "Alcoholic Beverages", "Close Price": "1,369.00" }
\`\`\`
\`\`\`json
{ "Name": "United Breweries Ltd", "Industry": "Alcoholic Beverages", "Close Price": "1,183.30" }
\`\`\`
\`\`\`json
{ "Name": "Tilaknagar Industries Ltd", "Industry": "Alcoholic Beverages", "Close Price": "1,18
`);
assert.equal(rowJson.industry, "Alcoholic Beverages");
assert.equal(rowJson.names.length, 2);
assert.ok(rowJson.names.some((n) => /United Spirits/i.test(n)));
assert.ok(rowJson.names.some((n) => /United Breweries/i.test(n)));

const ampName = parseSectorScreenshot(`
{"Name":"Foo Investment &amp; Consultancy Ltd.","Industry":"Other Financial Services"}
`);
assert.equal(ampName.industry, "Other Financial Services");
assert.ok(ampName.names.some((n) => /Foo Investment/i.test(n) && /Consultancy/i.test(n)));

const issuerAsIndustry = parseSectorScreenshot(`
{"industry":"Baheti Recycling Industries Ltd","names":["Msafe Equipments Ltd","Euro Panel Products Ltd","Amco India Lt
`);
assert.ok(issuerAsIndustry.names.some((n) => /Baheti Recycling/i.test(n)));
assert.ok(issuerAsIndustry.names.some((n) => /Msafe Equipments/i.test(n)));
assert.ok(issuerAsIndustry.names.some((n) => /Euro Panel/i.test(n)));
assert.equal(issuerAsIndustry.industry, null);

const ellipsisInd = parseSectorScreenshot(`
Name\tIndustry
Foo Sheets Ltd\tAluminium Sheets and Coils and Wires...
Bar Sheets Ltd\tAluminium Sheets and Coils and Wires...
`);
assert.equal(ellipsisInd.industry, "Aluminium Sheets and Coils and Wires");
assert.ok(ellipsisInd.names.some((n) => /Foo Sheets/i.test(n)));

const prefixed = parseSectorScreenshot(`Industry: Aluminium Sheets and Coils and Wires`);
assert.equal(prefixed.industry, "Aluminium Sheets and Coils and Wires");

console.log("ok");
