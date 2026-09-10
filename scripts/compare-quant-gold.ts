/**
 * Compare saved/generated quant JSON to test/ gold fixtures (no LLM).
 * Usage: npx tsx scripts/compare-quant-gold.ts [executive|highlights|both] [rowId]
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  compareQuantJson,
  loadQuantGold,
} from "../src/lib/concall-quant-extract";

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

const kindArg = (process.argv[2] || "both").toLowerCase();
const rowId = Number(process.argv[3] || 0);

const kinds =
  kindArg === "executive"
    ? (["executive"] as const)
    : kindArg === "highlights"
      ? (["highlights"] as const)
      : (["executive", "highlights"] as const);

function loadRowQuant(id: number): Record<string, unknown> | null {
  const db = new Database(
    path.join(process.cwd(), "data", "concall_screen.db"),
    { readonly: true },
  );
  const row = db
    .prepare(`SELECT extract_json FROM concall_screens WHERE id = ?`)
    .get(id) as { extract_json: string } | undefined;
  db.close();
  if (!row) return null;
  const extract = JSON.parse(row.extract_json) as Record<string, unknown>;
  return asObj(extract.quant);
}

for (const kind of kinds) {
  const gold = loadQuantGold(kind);
  let got: Record<string, unknown> | null = null;
  if (rowId > 0) {
    const quant = loadRowQuant(rowId);
    const key =
      kind === "executive" ? "executive_summary" : "highlight_sentiment";
    got = asObj(quant?.[key] ?? null);
    if (!got) {
      console.log(kind, "NO saved JSON on row", rowId);
      continue;
    }
  } else {
    // Self-compare gold (sanity)
    got = gold;
  }
  const c = compareQuantJson(got, gold);
  console.log(
    `\n=== ${kind} ${rowId > 0 ? `row ${rowId}` : "gold↔gold"} ===`,
  );
  console.log(`match ${c.matched}/${c.total} (${c.pct}%)`);
  if (c.missing.length) console.log("missing sample:", c.missing.slice(0, 8));
}
