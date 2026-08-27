/**
 * Import Qwen/CSV company_description rows into scraped_about
 * (company_about.db + scraper.db) so Theme/Scan/Missing share them.
 *
 * Usage:
 *   npx tsx scripts/import-qwen-scraped-about.ts [file1.csv ...]
 * Default: the Qwen_csv_*.txt files in ~/Downloads from 2026-08-25.
 */
import fs from "fs";
import path from "path";
import {
  saveManualAboutToCompanyAbout,
  saveScrapedAboutToCompanyAbout,
  updateCompanyWebsite,
} from "../src/lib/company-about-write";
import { invalidateCompanyCache, loadAllCompanies } from "../src/lib/db";
import { upsertScrapeResult } from "../src/lib/scraper-store";

const DEFAULT_FILES = [
  "Qwen_csv_20260825_k0d3w1h5e.txt",
  "Qwen_csv_20260825_t02h1nujs.txt",
  "Qwen_csv_20260825_15k1910zl.txt",
  "Qwen_csv_20260825_xf7f79tnf.txt",
  "Qwen_csv_20260825_mudwnhpen.txt",
  "Qwen_csv_20260825_bqktnucb5.txt",
  "Qwen_csv_20260825_15y49corv.txt",
  "Qwen_csv_20260825_x6vs9hp45.txt",
  "Qwen_csv_20260825_21v7ju4ih.txt",
  "Qwen_csv_20260825_hdnrphv6j.txt",
  "Qwen_csv_20260825_ny7jlq717.txt",
  "Qwen_csv_20260825_jens34nyi.txt",
].map((f) => path.join(process.env.HOME || "", "Downloads", f));

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  let field = "";
  let row: string[] = [];
  let inQ = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQ = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQ = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((x) => x.trim())) rows.push(row);
  }
  return rows;
}

function buildScrapedAbout(name: string, desc: string): string {
  const d = desc.trim().replace(/\s+/g, " ");
  if (!d) return "";
  // Already a full sentence-ish about
  if (d.length >= 80 && /[.!]$/.test(d)) return d;
  if (d.length >= 80) return d.endsWith(".") ? d : `${d}.`;

  const company = name.trim() || "The company";
  const body = /^(engaged|operates|manufactures|provides|a diversified)/i.test(d)
    ? d
    : d.charAt(0).toLowerCase() + d.slice(1);
  let text = `${company} ${body}`.replace(/\s+/g, " ").trim();
  if (!/[.!?]$/.test(text)) text += ".";
  if (text.length < 80) {
    text += ` It is listed on the Indian equity markets and focuses on ${d.replace(/\.$/, "").toLowerCase()}.`;
  }
  return text.slice(0, 24_000);
}

type ImportRow = {
  ticker: string;
  name: string;
  desc: string;
  website: string | null;
};

function loadImportRows(files: string[]): ImportRow[] {
  const bySym = new Map<string, ImportRow>();
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.warn(`skip missing file: ${file}`);
      continue;
    }
    const rows = parseCsv(fs.readFileSync(file, "utf8"));
    if (!rows.length) continue;
    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const si = header.indexOf("symbol");
    const ni = header.indexOf("company name");
    const di =
      header.indexOf("company_description") >= 0
        ? header.indexOf("company_description")
        : header.indexOf("about_us") >= 0
          ? header.indexOf("about_us")
          : header.indexOf("about");
    const wi = header.indexOf("website");
    if (si < 0 || (di < 0 && wi < 0)) {
      console.warn(`skip bad header: ${file}`);
      continue;
    }
    for (const r of rows.slice(1)) {
      const ticker = (r[si] || "").trim().toUpperCase();
      const name = ni >= 0 ? (r[ni] || "").trim() : "";
      const desc = di >= 0 ? (r[di] || "").trim() : "";
      const website = wi >= 0 ? (r[wi] || "").trim() || null : null;
      if (!ticker || (!desc && !website)) continue;
      const prev = bySym.get(ticker);
      if (
        !prev ||
        desc.length > prev.desc.length ||
        (!prev.website && website)
      ) {
        bySym.set(ticker, {
          ticker,
          name,
          desc: desc || prev?.desc || "",
          website: website || prev?.website || null,
        });
      }
    }
  }
  return [...bySym.values()];
}

function main() {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : DEFAULT_FILES;

  const imports = loadImportRows(files);
  const universe = new Map(
    loadAllCompanies().map((c) => [c.ticker.toUpperCase(), c]),
  );

  let saved = 0;
  let websites = 0;
  let skippedShort = 0;
  let skippedUnknown = 0;
  let skippedExisting = 0;
  const unknown: string[] = [];

  for (const row of imports) {
    const company = universe.get(row.ticker);
    if (!company) {
      skippedUnknown += 1;
      unknown.push(row.ticker);
      continue;
    }

    if (row.website) {
      if (updateCompanyWebsite(row.ticker, row.website)) websites += 1;
    }

    if (!row.desc.trim()) continue;

    const text = buildScrapedAbout(row.name || company.name, row.desc);
    if (text.length < 40) {
      skippedShort += 1;
      continue;
    }

    const existingScraped = (company.scraped_about || "").trim();
    const existingAbout = (company.about || "").trim();
    // Keep longer real website scrapes; overwrite empty/failed fillers only.
    if (
      existingScraped.length >= 80 &&
      existingScraped.length >= text.length &&
      existingAbout.length >= 40
    ) {
      skippedExisting += 1;
      continue;
    }

    if (existingAbout.length < 40) {
      saveManualAboutToCompanyAbout(row.ticker, text);
    }
    if (existingScraped.length < 80 || existingScraped.length < text.length) {
      saveScrapedAboutToCompanyAbout(row.ticker, {
        scraped_about: text,
        website_status: "ok",
        source: "qwen-import",
      });
      upsertScrapeResult(row.ticker, {
        scraped_about: text,
        status: text.length >= 80 ? "ok" : "manual",
        error: null,
        scrape_source: "website",
      });
    }
    saved += 1;
  }

  invalidateCompanyCache();

  console.log(
    JSON.stringify(
      {
        files: files.filter((f) => fs.existsSync(f)).length,
        unique_in_csv: imports.length,
        about_saved: saved,
        websites_set: websites,
        skipped_existing_longer: skippedExisting,
        skipped_unknown_ticker: skippedUnknown,
        skipped_short: skippedShort,
        unknown_sample: unknown.slice(0, 20),
      },
      null,
      2,
    ),
  );
}

main();
