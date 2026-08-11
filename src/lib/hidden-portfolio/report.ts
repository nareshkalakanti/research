/**
 * Markdown report writer for Hidden Portfolio Radar.
 */
import fs from "fs";
import path from "path";
import type { HiddenCandidate } from "./config";

const OUT_DIR = path.join(process.cwd(), "output");
const REPORT_PATH = path.join(OUT_DIR, "hidden_portfolio_report.md");

export function writeHiddenPortfolioReport(opts: {
  runDate: string;
  universeCount: number;
  filteredCount: number;
  candidates: HiddenCandidate[];
  topN?: number;
}): string {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const top = opts.candidates
    .slice()
    .sort((a, b) => b.alpha_score - a.alpha_score)
    .slice(0, opts.topN ?? 25);

  const lines: string[] = [
    `# Hidden Portfolio Radar`,
    ``,
    `Run date: ${opts.runDate}`,
    `Universe: ${opts.universeCount}`,
    `Passed fundamentals filter: ${opts.filteredCount}`,
    `Top candidates: ${top.length}`,
    ``,
    `## Top candidates`,
    ``,
    `| Symbol | Name | Price | Mcap (₹ Cr) | Alpha | Moat | Growth | Smart $ | Headline |`,
    `| --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |`,
  ];

  for (const c of top) {
    const headline = (c.top_headline || "—").replace(/\|/g, "/");
    const link = c.top_link ? `[link](${c.top_link})` : "";
    lines.push(
      `| ${c.symbol} | ${c.name.replace(/\|/g, "/")} | ${c.price ?? "—"} | ${c.mcap_cr ?? "—"} | ${c.alpha_score} | ${c.moat_keywords.join("; ") || "—"} | ${c.growth_keywords.join("; ") || "—"} | ${c.smart_money_flag ? "Y" : "—"} | ${headline} ${link} |`,
    );
  }

  lines.push(``, `## Detail`, ``);
  for (const c of top) {
    lines.push(`### ${c.symbol} — ${c.name}`);
    lines.push(`- Alpha score: **${c.alpha_score}**`);
    lines.push(`- Price: ${c.price ?? "—"} · Mcap: ${c.mcap_cr ?? "—"} Cr`);
    lines.push(`- Moat: ${c.moat_keywords.join(", ") || "—"}`);
    lines.push(`- Growth: ${c.growth_keywords.join(", ") || "—"}`);
    lines.push(
      `- Smart money: ${c.smart_money_flag ? c.smart_money_keywords.join(", ") : "no"}`,
    );
    if (c.top_headline) {
      lines.push(
        `- Top news: ${c.top_link ? `[${c.top_headline}](${c.top_link})` : c.top_headline}`,
      );
    }
    lines.push(``);
  }

  const md = lines.join("\n");
  fs.writeFileSync(REPORT_PATH, md, "utf8");
  return REPORT_PATH;
}
