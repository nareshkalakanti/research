/**
 * SOIC CDMO tier map — theme filter + business brief smoke test.
 *
 *   npx tsx scripts/test-cdmo-tier.ts
 *   npx tsx scripts/test-cdmo-tier.ts --brief   # LLM cap/growth/capex (slow)
 */
import { loadAllCompanies } from "../src/lib/db";
import { generateCompanyBrief } from "../src/lib/company-brief";
import { matchThemesForRow, themeSearchCorpus } from "../src/lib/theme-match";
import { themesByIds } from "../src/lib/themes";

const PHARMA_THEMES = themesByIds([
  "gov_pharma_api_cdmo_pli",
  "lotusdew_pharma_structural",
]);

/** SOIC CDMO tier map (Aug 2026 deck). */
const TIERS: { tier: string; names: string[] }[] = [
  {
    tier: "Tier 1 · Pure CRDMO",
    names: ["Divi's", "Laurus", "Anthem", "Sai Life"],
  },
  {
    tier: "Mixed delivery",
    names: [
      "Acutaas",
      "Neuland",
      "Navin Fluorine",
      "Piramal Pharma",
      "Aragen",
    ],
  },
  {
    tier: "Wannabes · CDMO optionality",
    names: [
      "Aarti Pharmalabs",
      "Blue Jet",
      "Alivus",
      "Shilpa Medicare",
      "Granules",
      "Supriya",
      "PI Industries",
    ],
  },
  {
    tier: "Hero or Zero",
    names: ["Syngene", "Cohance", "Hikal", "Dishman"],
  },
  {
    tier: "Little Babies",
    names: ["Ind-Swift", "Morepen", "Shree Ganesh"],
  },
  {
    tier: "Copycats",
    names: ["Windlas", "Innova Captab", "Gland", "OneSource"],
  },
];

function resolveName(query: string) {
  const q = query.toLowerCase();
  const all = loadAllCompanies();
  return all.find(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.ticker.toLowerCase().includes(q.replace(/[^a-z0-9]/g, "")),
  );
}

async function main() {
  const withBrief = process.argv.includes("--brief");
  let inDb = 0;
  let themeHit = 0;
  let briefOk = 0;
  let briefCap = 0;

  console.log("SOIC CDMO tier verification\n");
  console.log(
    "tier | ticker | theme | cap | growth | capex | notes",
  );
  console.log("-".repeat(90));

  for (const { tier, names } of TIERS) {
    for (const name of names) {
      const row = resolveName(name);
      if (!row) {
        console.log(`${tier} | — | — | — | — | — | NOT IN DB (${name})`);
        continue;
      }
      inDb++;

      const m = matchThemesForRow(row, PHARMA_THEMES);
      const themed = m.matched;
      if (themed) themeHit++;

      const corpusLen = themeSearchCorpus(row).length;
      let cap = "—";
      let growth = "—";
      let capex = "—";
      let notes = `corpus ${corpusLen}c`;

      if (withBrief) {
        const r = await generateCompanyBrief(row.ticker, row.market, null);
        if (r.brief) {
          briefOk++;
          cap = r.brief.capabilities ? "✓" : "✗";
          growth = r.brief.growth_triggers ? "✓" : "✗";
          const cx = r.brief.capex.trim();
          capex =
            cx && !/^unclear/i.test(cx) ? "✓" : cx ? "~" : "✗";
          if (r.brief.capabilities) briefCap++;
        } else {
          notes = r.error || "brief failed";
        }
      }

      console.log(
        [
          tier,
          row.ticker,
          themed ? "YES" : "NO",
          cap,
          growth,
          capex,
          notes,
        ].join(" | "),
      );
    }
  }

  const total = TIERS.reduce((n, t) => n + t.names.length, 0);
  console.log("-".repeat(90));
  console.log(
    `In DB: ${inDb}/${total} · Theme match: ${themeHit}/${inDb} · Missing: ${total - inDb}`,
  );
  if (withBrief) {
    console.log(
      `Brief OK: ${briefOk}/${inDb} · Capability filled: ${briefCap}/${briefOk}`,
    );
  } else {
    console.log("Run with --brief to smoke-test LLM cap/growth/capex.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
