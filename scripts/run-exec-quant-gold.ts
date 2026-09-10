/**
 * Run executive quant LLM on a PASS row and compare to test/ExecutiveSummary.json.
 * Usage: npx tsx scripts/run-exec-quant-gold.ts [rowId]
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  compareQuantJson,
  extractQuantFromTexts,
  loadQuantGold,
} from "../src/lib/concall-quant-extract";

function loadEnvLocal() {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function splitCombined(combined: string): { tx: string; ppt: string } {
  const m = /=====\s*PPT\s*\/\s*PRESENTATION\s*=====/i.exec(combined);
  if (!m || m.index == null) {
    return { tx: combined, ppt: "" };
  }
  return {
    tx: combined
      .slice(0, m.index)
      .replace(/=====\s*TRANSCRIPT\s*=====/i, "")
      .trim(),
    ppt: combined.slice(m.index + m[0].length).trim(),
  };
}

async function main() {
  loadEnvLocal();
  const rowId = Number(process.argv[2] || 26);
  const db = new Database(
    path.join(process.cwd(), "data", "concall_screen.db"),
    { readonly: true },
  );
  const row = db
    .prepare(
      `SELECT id, ticker, extract_json FROM concall_screens WHERE id = ?`,
    )
    .get(rowId) as
    | { id: number; ticker: string; extract_json: string }
    | undefined;
  db.close();

  if (!row) {
    console.error("No row", rowId);
    process.exit(1);
  }

  const extract = JSON.parse(row.extract_json) as Record<string, unknown>;
  const docs = asObj(extract.docs) || {};
  const combined = String(docs.combined || "");
  if (combined.length < 80) {
    console.error("No combined text on row", rowId);
    process.exit(1);
  }

  const { tx, ppt } = splitCombined(combined);
  console.log(
    `Row ${row.id} ${row.ticker} · TX ${tx.length} · PPT ${ppt.length} · running executive LLM…`,
  );

  const r = await extractQuantFromTexts({
    kind: "executive",
    transcriptText: tx || "(none)",
    presentationText: ppt || "(none)",
  });

  const outPath = path.join(
    process.cwd(),
    "test",
    `ExecutiveSummary.${row.ticker}.generated.json`,
  );
  fs.writeFileSync(outPath, JSON.stringify(r.json, null, 2));
  console.log("ok:", r.ok, "engine:", r.engine, r.error || "");
  console.log("wrote", outPath);

  const gold = loadQuantGold("executive");
  const c = compareQuantJson(r.json, gold);
  console.log(`\ngold match ${c.matched}/${c.total} (${c.pct}%)`);
  if (c.missing.length) {
    console.log("missing sample:", c.missing.slice(0, 15));
  }
  if (c.extras.length) {
    console.log("extras sample:", c.extras.slice(0, 10));
  }

  const rev = asObj(asObj(r.json.financial_snapshot)?.revenue);
  console.log("\nrevenue keys:", rev ? Object.keys(rev) : "(none)");
  console.log("revenue sample:", rev);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
