/**
 * Deep-compare investor presentation extract vs KRN gold JSON.
 *
 *   npx tsx scripts/compare-investor-gold.ts
 */
import fs from "fs";
import path from "path";
import {
  enrichInvestorPresentationLexical,
  loadKrnInvestorExpected,
  validateInvestorPresentationExtract,
} from "../src/lib/investor-presentation-extract";

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function numEq(a: unknown, e: unknown): boolean {
  if (typeof a === "number" && typeof e === "number") return Math.abs(a - e) < 0.051;
  return JSON.stringify(a) === JSON.stringify(e);
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdf = require("pdf-parse/lib/pdf-parse.js");
  const buf = fs.readFileSync(
    path.join(process.cwd(), "data/samples/krn-q1fy27-investor-presentation.pdf"),
  );
  const text = ((await pdf(buf)).text || "")
    .replace(/[ \t\u00a0]+/g, " ")
    .trim();
  const actual = enrichInvestorPresentationLexical(text, {});
  const expected = loadKrnInvestorExpected();

  const core = validateInvestorPresentationExtract(actual, expected);
  console.log(`Core fixture: ${core.matched}/${core.checked} · ok=${core.ok}`);

  const checks: Array<[string, unknown, unknown]> = [];
  const push = (p: string, a: unknown, e: unknown) => checks.push([p, a, e]);
  const softArrays = new Set([
    "export_countries",
    "end_use_industries",
    "core_segments",
    "top_public_shareholders",
    "board_of_directors",
    "key_managerial_personnel",
    "watch_points",
    "recent_corporate_actions",
  ]);

  const deep = (a: unknown, e: unknown, p: string) => {
    if (e === undefined) return;
    if (
      typeof e === "number" ||
      typeof e === "boolean" ||
      typeof e === "string" ||
      e === null
    ) {
      push(p, a, e);
      return;
    }
    if (Array.isArray(e)) {
      const leaf = softArrays.has(p.split(".").pop() || "");
      if (leaf) {
        if (!Array.isArray(a)) {
          push(`${p}.subset`, 0, e.length);
          return;
        }
        let hit = 0;
        for (const item of e) {
          const s = typeof item === "string" ? item : JSON.stringify(item);
          const ok = a.some((x) => {
            const t = typeof x === "string" ? x : JSON.stringify(x);
            const n = (z: string) =>
              z
                .toLowerCase()
                .replace(/&/g, " and ")
                .replace(/[^a-z0-9]+/g, " ");
            return (
              n(t).includes(n(s).slice(0, 20)) || n(s).includes(n(t).slice(0, 20))
            );
          });
          if (ok) hit += 1;
        }
        push(`${p}.subset`, hit, e.length);
        return;
      }
      for (let i = 0; i < e.length; i++) deep((a as unknown[])?.[i], e[i], `${p}[${i}]`);
      return;
    }
    if (typeof e === "object" && e) {
      for (const k of Object.keys(e as object)) {
        deep(
          asObj(a)?.[k] ?? (a as Record<string, unknown> | null)?.[k],
          (e as Record<string, unknown>)[k],
          p ? `${p}.${k}` : k,
        );
      }
    }
  };
  deep(actual, expected, "");

  let matched = 0;
  let checked = 0;
  const bad: string[] = [];
  for (const [p, a, e] of checks) {
    checked += 1;
    if (p.endsWith(".subset") && typeof a === "number" && typeof e === "number") {
      if (a >= Math.min(e, Math.ceil(e * 0.7))) {
        matched += 1;
        continue;
      }
      bad.push(`${p}: ${a}/${e}`);
      continue;
    }
    if (numEq(a, e)) {
      matched += 1;
      continue;
    }
    if (typeof a === "string" && typeof e === "string") {
      const n = (s: string) =>
        s
          .toLowerCase()
          .replace(/&/g, " and ")
          .replace(/ltd|limited/g, "")
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
      if (n(a) === n(e) || n(a).includes(n(e)) || n(e).includes(n(a))) {
        matched += 1;
        continue;
      }
    }
    if ((a == null || a === undefined) && e === 0) {
      matched += 1;
      continue;
    }
    bad.push(`${p}: got ${JSON.stringify(a)} expected ${JSON.stringify(e)}`);
  }

  console.log(`Expanded vs gold: ${matched}/${checked} · ok=${bad.length === 0}`);
  if (bad.length) {
    console.log("Mismatches:");
    for (const m of bad.slice(0, 40)) console.log(`  - ${m}`);
  }

  const out = path.join(
    process.cwd(),
    "data/samples/krn-q1fy27-investor-presentation-extract.json",
  );
  fs.writeFileSync(out, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`Wrote ${out}`);
  if (bad.length || !core.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
