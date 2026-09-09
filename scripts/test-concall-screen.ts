/**
 * Validate Concall Research extract against Indo Borax Q1 FY27 fixture.
 *
 *   npm run test:concall-screen
 */
import fs from "fs";
import path from "path";
import {
  loadIndoboraxExpected,
  screenConcallPdf,
  validateConcallExtract,
} from "../src/lib/concall-screen";

function loadEnvLocal() {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

async function main() {
  loadEnvLocal();
  const pdfPath = path.join(
    process.cwd(),
    "data",
    "samples",
    "indoborax-q1fy27-transcript.pdf",
  );
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`Missing sample PDF: ${pdfPath}`);
  }
  const buf = fs.readFileSync(pdfPath);
  console.log(
    `Screening ${pdfPath} (${buf.length} bytes) · LLM_PROVIDER=${process.env.LLM_PROVIDER} MODEL=${process.env.LLM_MODEL}…`,
  );
  const result = await screenConcallPdf({
    url: null,
    pdfBuffer: buf,
  });
  console.log({
    ok: result.ok,
    decision: result.decision,
    why: result.why,
    engine: result.engine,
    text_chars: result.text_chars,
    error: result.error,
  });

  const outPath = path.join(
    process.cwd(),
    "data",
    "samples",
    "indoborax-q1fy27-extract.json",
  );
  fs.writeFileSync(outPath, `${JSON.stringify(result.extract, null, 2)}\n`);
  console.log(`Wrote ${outPath}`);

  const expected = loadIndoboraxExpected();
  const v = validateConcallExtract(result.extract, expected);
  console.log(
    `Validation: ${v.matched}/${v.checked} matched · ok=${v.ok}`,
  );
  if (v.mismatches.length) {
    console.log("Mismatches (first 40):");
    for (const m of v.mismatches.slice(0, 40)) console.log(`  - ${m}`);
  }
  if (!result.ok) process.exitCode = 1;
  if (v.checked > 0 && v.matched / v.checked < 0.5) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
