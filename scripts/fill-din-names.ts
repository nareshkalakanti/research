/**
 * Fill placeholder DIN-only director names from MCA directories
 * (RegisterKaro when reachable, otherwise Tofler) and add listed seats.
 *
 *   npx tsx scripts/fill-din-names.ts --file path/to/dins.txt
 */
import fs from "fs";
import path from "path";
import {
  lookupDinOnMcaDirectories,
  matchRegistryCompaniesToListings,
} from "../src/lib/din-mca-lookup";
import { applyDinRegistryFill } from "../src/lib/governance-write";
import { invalidateGovernanceMapCache } from "../src/lib/governance-map";
import { isPlaceholderDirectorName } from "../src/lib/gov-director-name";
import { normDin } from "../src/lib/nse-governance";
import { getGovernanceWriteDb } from "../src/lib/governance-write";

function readDins(filePath: string): string[] {
  const text = fs.readFileSync(filePath, "utf8");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const din = normDin(line);
    if (!din || din.length !== 8) continue;
    if (seen.has(din)) continue;
    seen.add(din);
    out.push(din);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.findIndex((a) => a === "--file");
  const fileArg = fileIdx >= 0 ? args[fileIdx + 1] : "";
  const defaultFile = path.join(
    process.env.HOME || "",
    ".cursor/projects/Users-nareshkalakanti-Development-ai-com-research/attachments/5e52f92b-5636-4542-bf69-821097cb2e6f/dins.txt",
  );
  const filePath = fileArg || defaultFile;
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`DIN file not found: ${filePath || "(none)"}`);
  }

  const dins = readDins(filePath);
  const db = getGovernanceWriteDb();
  const stats = { ok: 0, skip: 0, fail: 0, names: 0, seats: 0 };

  for (let i = 0; i < dins.length; i += 1) {
    const din = dins[i]!;
    const existing = db
      .prepare(`SELECT name FROM directors WHERE din = ? OR person_id = ?`)
      .get(din, din) as { name?: string } | undefined;
    process.stdout.write(`[${i + 1}/${dins.length}] ${din} `);
    const hit = await lookupDinOnMcaDirectories(din);
    if (!hit) {
      stats.fail += 1;
      console.log("no registry page");
      await sleep(400);
      continue;
    }
    const { matched, unmatched } = matchRegistryCompaniesToListings(hit.companies);
    const alreadyNamed =
      existing?.name && !isPlaceholderDirectorName(existing.name);
    const result = applyDinRegistryFill({
      din: hit.din,
      name: hit.name,
      source: hit.source,
      seats: matched,
    });
    stats.ok += 1;
    if (result.name_updated) stats.names += 1;
    stats.seats += result.seats_written;
    if (alreadyNamed && !result.name_updated) stats.skip += 1;
    console.log(
      `${hit.name} · ${hit.source} · listed seats ${result.seats_written}` +
        (unmatched.length ? ` · unlisted ${unmatched.length}` : ""),
    );
    await sleep(350);
  }

  invalidateGovernanceMapCache();
  console.log(
    `Done · resolved ${stats.ok}/${dins.length} · names written ${stats.names} · listed seats ${stats.seats} · failed ${stats.fail}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
