import fs from "fs";
import path from "path";
import { loadHiddenUniverse, loadSmeUniverseCsv } from "../src/lib/hidden-portfolio/universe";

const rows = loadHiddenUniverse({ includeDbSme: true });
const csv = loadSmeUniverseCsv();
const outDir = path.join(process.cwd(), "output");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const lines = [
  `# Hidden Portfolio Universe`,
  ``,
  `Total: **${rows.length}** stocks`,
  `- CSV seed: ${csv.length}`,
  `- From company DB (NSE SME + ₹20–200 Cr mcap): ${rows.length - csv.length}`,
  ``,
  `| # | Symbol | Name | Sector | Market |`,
  `| ---: | --- | --- | --- | --- |`,
];

rows.forEach((r, i) => {
  lines.push(
    `| ${i + 1} | ${r.symbol} | ${(r.name || "").replace(/\|/g, "/")} | ${(r.sector || "—").replace(/\|/g, "/")} | ${r.market || "—"} |`,
  );
});

const md = lines.join("\n");
const outPath = path.join(outDir, "hidden_portfolio_universe.md");
fs.writeFileSync(outPath, md, "utf8");
console.log(`TOTAL=${rows.length}`);
console.log(`CSV=${csv.length}`);
console.log(`DB=${rows.length - csv.length}`);
console.log(`WROTE=${outPath}`);
