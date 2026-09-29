/**
 * Screenshot gold vs local PEAD / quarter caches.
 *   npx tsx scripts/test-scan-pead-gold.ts
 */
import { runPeadHhhGold } from "../src/lib/scan-pead-gold";

const r = runPeadHhhGold();
for (const c of r.checks) {
  console.log(`${c.ok ? "ok" : "FAIL"} ${c.id} · ${c.detail}`);
}
console.log(
  `\nPEAD gold ${r.matched}/${r.total}${r.source ? ` · ${r.source}` : ""}`,
);
if (!r.ok) process.exit(1);
