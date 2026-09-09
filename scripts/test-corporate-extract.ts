import fs from "fs";
import path from "path";
import { extractCorporateFromPdfUrl } from "../src/lib/corporate-data-extract";

function loadEnv() {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
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
  loadEnv();
  const url =
    process.argv[2] ||
    "https://nsearchives.nseindia.com/corporate/ITC_23072026182127_SE_Director_.pdf";
  console.log("extracting", url);
  const r = await extractCorporateFromPdfUrl(url);
  console.log(
    JSON.stringify(
      {
        ok: r.ok,
        engine: r.engine,
        status: r.status,
        text_chars: r.text_chars,
        error: r.error,
        directors: r.extracted.directors,
        kmp: r.extracted.kmp,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
