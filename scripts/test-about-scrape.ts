/**
 * About scrape extraction tests (no network).
 * Run: npm run test:about-scrape
 */
import assert from "node:assert/strict";
import * as cheerio from "cheerio";

// Inline minimal extract logic mirrors about-scrape-text scoring
function extractParagraphs(html: string): string {
  const $ = cheerio.load(html);
  $("script, nav, footer").remove();
  const paras: string[] = [];
  $("main p, article p").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t.length >= 40) paras.push(t);
  });
  return paras.join("\n\n");
}

function main() {
  const html = `<!doctype html><html><body>
    <nav>Home About Contact</nav>
    <main>
      <h1>About Us</h1>
      <p>Acme Widgets Limited manufactures precision castings and machined components for automotive and industrial OEM customers across India and Europe.</p>
      <p>The company operates three plants in Gujarat with a combined capacity of 12,000 tonnes per annum.</p>
    </main>
  </body></html>`;
  const text = extractParagraphs(html);
  assert.ok(text.includes("Acme Widgets Limited"));
  assert.ok(text.includes("12,000 tonnes"));
  assert.ok(!text.includes("Home About Contact"));

  console.log("test-about-scrape: all passed");
}

main();
