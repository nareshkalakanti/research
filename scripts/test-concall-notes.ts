/**
 * Generate StockScans-style Transcript Notes from Indo Borax extract + transcript.
 *
 *   npm run test:concall-notes
 */
import fs from "fs";
import path from "path";
import {
  generateConcallTranscriptNotes,
  loadIndoboraxExpected,
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
  const extractPath = path.join(
    process.cwd(),
    "data",
    "samples",
    "indoborax-q1fy27-extract.json",
  );
  const txtPath = path.join(
    process.cwd(),
    "data",
    "samples",
    "indoborax-q1fy27-transcript.txt",
  );
  const extract = fs.existsSync(extractPath)
    ? (JSON.parse(fs.readFileSync(extractPath, "utf8")) as Record<
        string,
        unknown
      >)
    : loadIndoboraxExpected();
  // Enrich card if missing (sample extract may be partial)
  const expected = loadIndoboraxExpected();
  const merged = {
    ...expected,
    ...extract,
    metadata: {
      ...(expected.metadata as object),
      ...(extract.metadata as object),
    },
    card: {
      ...(expected.card as object),
      ...(extract.card as object),
      industry: "Chemicals - Inorganic",
      sector: "Materials",
      highlights: [
        {
          text: "Kronox Lab Sciences acquisition completed",
          polarity: "neutral",
        },
        { text: "Q2 EBITDA margin reset, ~810bps", polarity: "negative" },
        { text: "FY29 revenue target 3–4x scale", polarity: "positive" },
      ],
    },
  };
  const transcript = fs.existsSync(txtPath)
    ? fs.readFileSync(txtPath, "utf8")
    : "";
  if (!transcript) throw new Error(`Missing ${txtPath}`);

  console.log(
    `Generating notes · extract keys=${Object.keys(merged).join(",")} · transcript=${transcript.length} chars · model=${process.env.LLM_MODEL}`,
  );
  const result = await generateConcallTranscriptNotes({
    extract: merged,
    transcriptText: transcript,
  });
  if (!result.ok || !result.notes) {
    console.error("FAIL", result.error);
    process.exit(1);
  }

  const outDir = path.join(process.cwd(), "data", "samples");
  const mdPath = path.join(outDir, "indoborax-q1fy27-notes.generated.md");
  const jsonPath = path.join(outDir, "indoborax-q1fy27-notes.generated.json");
  fs.writeFileSync(mdPath, result.markdown);
  fs.writeFileSync(jsonPath, JSON.stringify(result.notes, null, 2));
  console.log(`\nengine=${result.engine}${result.error ? ` · note: ${result.error}` : ""}`);
  console.log("\n===== GENERATED NOTES (markdown) =====\n");
  console.log(result.markdown);
  console.log("\n===== wrote =====");
  console.log(mdPath);
  console.log(jsonPath);
  console.log(
    `\nTakeaways: ${result.notes.key_takeaways.length} · Sections: ${result.notes.sections.length} · Guidance rows: ${result.notes.guidance_commitments.length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
