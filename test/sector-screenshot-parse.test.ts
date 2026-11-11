import assert from "node:assert/strict";
import {
  parseSectorNameIndustryPairs,
  parseSectorScreenshot,
  preferBatchIndustry,
} from "../src/lib/sector-screenshot-parse";

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
assert.equal(rowJson.names.length, 3);
assert.ok(rowJson.names.some((n) => /United Spirits/i.test(n)));
assert.ok(rowJson.names.some((n) => /United Breweries/i.test(n)));
assert.ok(rowJson.names.some((n) => /Tilaknagar/i.test(n)));

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

const parentVsColumn = parseSectorScreenshot(`
{"industry":"Manufacturing","names":["G S Auto International Ltd","Enincoare Autotech Ltd"]}
{"Name":"G S Auto International Ltd","Industry":"Auto Others"}
{"Name":"Enincoare Autotech Ltd","Industry":"Auto Others"}
{"Name":"Coramandel Technologies Ltd","Industry":"Auto Others"}
`);
assert.equal(parentVsColumn.industry, "Auto Others");
assert.ok(parentVsColumn.names.some((n) => /G S Auto/i.test(n)));

const tsvColumn = parseSectorScreenshot(`
{"industry":"Manufacturing","names":["G S Auto International Ltd"]}
Name\tIndustry
G S Auto International Ltd\tAuto Others
Enincoare Autotech Ltd\tAuto Others
`);
assert.equal(tsvColumn.industry, "Auto Others");

const dumpedInd = parseSectorScreenshot(`
{"industry":"Capital Goods Transformers, Capital Goods Transformers, Capital Goods Transformers, Capital Goods Transformers","names":["CG Power & Industrial Solutions Ltd","Schneider Electric Infrastructure Ltd"]}
`);
assert.equal(dumpedInd.industry, "Capital Goods Transformers");

const dumpedSpace = parseSectorScreenshot(`
{"industry":"Capital Goods Transformers Capital Goods Transformers Capital Goods Transformers","names":["Voltamp Transformers Ltd"]}
`);
assert.equal(dumpedSpace.industry, "Capital Goods Transformers");

assert.equal(preferBatchIndustry("Auto Plastic", "Manufacturing"), "Auto Plastic");
assert.equal(preferBatchIndustry("Manufacturing", "Auto Plastic"), "Auto Plastic");
assert.equal(
  preferBatchIndustry("Capital Goods Switchgear", "Capital Goods Transformers"),
  "Capital Goods Transformers",
);
assert.equal(
  preferBatchIndustry("Capital Goods Transformers", "Capital Goods Switchgear"),
  "Capital Goods Switchgear",
);
assert.equal(
  preferBatchIndustry("Capital Goods Switchgear", ""),
  "Capital Goods Switchgear",
);

const parenTrunc = parseSectorScreenshot(`
{"names":["Foo Motor Agency (Del
`);
assert.ok(parenTrunc.names.some((n) => /Foo Motor Agency/i.test(n)));

const parenRow = parseSectorScreenshot(`
{"Name":"Foo Motor Agency (Delhi) Ltd","Industry":"Auto Others"}
`);
assert.ok(parenRow.names.some((n) => /Foo Motor Agency/i.test(n)));

const jsonMissesTop = parseSectorScreenshot(`
{"industry":"Widgets","names":["Echo Widgets Ltd","Fox Widgets Ltd"]}
1 Alpha Widgets Ltd
2 Bravo Widgets Ltd
3 Echo Widgets Ltd
4 Fox Widgets Ltd
`);
assert.equal(jsonMissesTop.industry, "Widgets");
assert.equal(jsonMissesTop.names.length, 4);
assert.ok(jsonMissesTop.names.some((n) => /Alpha Widgets/i.test(n)));
assert.ok(jsonMissesTop.names.some((n) => /Bravo Widgets/i.test(n)));

const scripQuote = parseSectorScreenshot(`
Stock Price Quote
Foo Biotech	524001	Not listed on NSE. Makes culture media.
Bar Bio Tech	511002	Listed on BSE, not NSE.
Baz Ganesh Bio-Tech (India)	539003	Not listed on NSE.
`);
assert.ok(scripQuote.names.some((n) => /Foo Biotech/i.test(n)));
assert.ok(scripQuote.names.some((n) => /Bar Bio Tech/i.test(n)));
assert.ok(scripQuote.names.some((n) => /Baz Ganesh Bio-Tech/i.test(n)));
assert.ok(scripQuote.names.includes("524001"));
assert.ok(scripQuote.names.includes("511002"));
assert.ok(scripQuote.names.includes("539003"));
assert.ok(!scripQuote.names.some((n) => /Stock Price Quote/i.test(n)));

const numberedMapTrunc = parseSectorScreenshot(`
\`\`\`json
{ "1": "Alpha Cable Ltd", "2": "Bravo Industries Ltd", "3": "Charlie Kabel Ltd", "4": "Delta Power Ltd", "5": "Echo Cables Ltd", "6": "Foxtrot Infra Ltd", "7": "Golf Cables Ltd", "8": "Hotel Power Ltd", "9": "India Cables Ltd", "10": "System
`);
assert.ok(numberedMapTrunc.names.length >= 9);
assert.ok(numberedMapTrunc.names.some((n) => /Alpha Cable/i.test(n)));
assert.ok(numberedMapTrunc.names.some((n) => /India Cables/i.test(n)));
assert.ok(!numberedMapTrunc.names.some((n) => /^System$/i.test(n)));

const mixedPairs = parseSectorNameIndustryPairs(`
Name\tMarket Capitalization\tIndustry\tClose Price
1 Reliance Industries Ltd\t₹ 15,76,405 Cr\tRefineries\t₹ 1,164.90
2 Jio Platforms Ltd\t₹ 13,18,089 Cr\tTelecom Services\t₹ 1,431.30
3 Bharti Airtel Ltd\t₹ 12,31,907 Cr\tTelecom Services\t₹ 1,973.70
4 HDFC Bank Ltd\t₹ 10,68,834 Cr\tPrivate Banks\t₹ 692.80
5 State Bank of India\t₹ 8,87,861 Cr\tPSU Banks\t₹ 961.85
6 Bajaj Finance Ltd\t₹ 5,84,679 Cr\tConglomerate Backed NBFC\t₹ 939.10
7 Larsen & Toubro Ltd\t₹ 5,32,713 Cr\tInfra Construction and Contracting\t₹ 3,871.70
`);
assert.equal(mixedPairs.length, 7);
assert.equal(
  mixedPairs.find((p) => /Reliance/i.test(p.name))?.industry,
  "Refineries",
);
assert.equal(
  mixedPairs.find((p) => /Jio Platforms/i.test(p.name))?.industry,
  "Telecom Services",
);
assert.equal(
  mixedPairs.find((p) => /HDFC Bank/i.test(p.name))?.industry,
  "Private Banks",
);
assert.equal(
  mixedPairs.find((p) => /State Bank of India/i.test(p.name))?.industry,
  "PSU Banks",
);
assert.equal(
  mixedPairs.find((p) => /Bajaj Finance/i.test(p.name))?.industry,
  "Conglomerate Backed NBFC",
);
assert.equal(
  mixedPairs.find((p) => /Larsen/i.test(p.name))?.industry,
  "Infra Construction and Contracting",
);
const industries = new Set(mixedPairs.map((p) => p.industry).filter(Boolean));
assert.ok(industries.size >= 5);

const collapsedInfra = parseSectorScreenshot(`
1 Engineers India Ltd 17,481.48 Infrastructure - Engineering & Construction 311.20
2 Ircon International Ltd 16,084.56 Infrastructure - Engineering & Construction 138.38
3 ISGEC Heavy Engineering Ltd 7,269.36 Infrastructure - Engineering & Construction 1,068.00
4 BGR Energy Systems Ltd 2,369.46 Infrastructure - Engineering & Construction 213.10
5 EMS Ltd 2,247.52 Infrastructure - Engineering & Construction 404.00
`);
assert.equal(
  collapsedInfra.industry,
  "Infrastructure - Engineering & Construction",
);
assert.ok(collapsedInfra.names.length >= 5);
assert.ok(collapsedInfra.names.some((n) => /Engineers India/i.test(n)));
assert.ok(collapsedInfra.names.some((n) => /Ircon/i.test(n)));

console.log("ok");
