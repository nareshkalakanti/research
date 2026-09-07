/**
 * Import cleaned scrape summaries into company_about
 * (scraped_about_clean, products, end_markets, group_name, recent_moves, …).
 *
 * Usage:
 *   npx tsx scripts/import-cleaned-summaries.ts [path/to/cleaned-summaries-all.csv]
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { ensureCompanyAboutRow } from "../src/lib/company-about-write";
import { invalidateCompanyCache } from "../src/lib/db";
import {
  ensureScrapeCleanSchema,
  resetScrapeCleanSchemaCache,
} from "../src/lib/scrape-clean-schema";

const DATA_DIR = path.join(process.cwd(), "data");
const ABOUT_PATH = path.join(DATA_DIR, "company_about.db");

const DEFAULT_CANDIDATES = [
  path.join(DATA_DIR, "imports", "cleaned-summaries-all.csv"),
  path.join(
    process.env.HOME || "",
    ".cursor/projects/Users-nareshkalakanti-Development-ai-com-research/attachments/1bd260b2-08bf-4a6d-b327-abdf54018fa8/cleaned-summaries-all.csv",
  ),
];

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

function cell(row: Record<string, string>, key: string): string {
  return (row[key] ?? "").trim();
}

function parseSectorFromScreenNote(note: string): string | null {
  const m = note.match(/^\s*Sector:\s*(.+)$/im);
  if (!m) return null;
  const s = m[1]!.trim().replace(/\s+/g, " ");
  if (!s || s === "—" || /^n\/?a$/i.test(s) || s.length < 2) return null;
  return s.slice(0, 120);
}

function pickCleanText(screenNote: string, businessModel: string): string | null {
  const note = screenNote.trim();
  const model = businessModel.trim();
  if (note.length >= 80) return note;
  if (model.length >= 40) return model;
  if (note.length >= 40) return note;
  return null;
}

function confRank(c: string): number {
  const v = c.trim().toLowerCase();
  if (v === "high") return 3;
  if (v === "medium") return 2;
  if (v === "low") return 1;
  return 0;
}

function preferText(
  existing: string | null | undefined,
  incoming: string | null,
): string | null {
  const cur = (existing ?? "").trim();
  const next = (incoming ?? "").trim();
  if (!next) return cur || null;
  if (!cur) return next;
  return next.length >= cur.length ? next : cur;
}

function resolveCsvPath(): string {
  const arg = process.argv[2]?.trim();
  if (arg) {
    const p = path.resolve(arg);
    if (!fs.existsSync(p)) throw new Error(`CSV not found: ${p}`);
    return p;
  }
  for (const p of DEFAULT_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `No CSV found. Pass a path or place cleaned-summaries-all.csv under data/imports/`,
  );
}

type Existing = {
  scraped_about_clean: string | null;
  products: string | null;
  end_markets: string | null;
  company_sector: string | null;
  group_name: string | null;
  recent_moves: string | null;
  business_model: string | null;
};

function main() {
  const csvPath = resolveCsvPath();
  if (!fs.existsSync(ABOUT_PATH)) {
    throw new Error(`Missing ${ABOUT_PATH}`);
  }

  resetScrapeCleanSchemaCache();
  ensureScrapeCleanSchema();

  const raw = fs.readFileSync(csvPath, "utf8");
  const table = parseCsv(raw);
  if (table.length < 2) throw new Error("CSV empty");
  const headers = table[0]!.map((h) => h.trim());
  const objects = table.slice(1).map((cells) => {
    const o: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      o[headers[i]!] = cells[i] ?? "";
    }
    return o;
  });

  // Ensure about rows exist (opens/closes its own DB).
  let created = 0;
  {
    const probe = new Database(ABOUT_PATH, { readonly: true });
    const exists = probe.prepare(
      `SELECT 1 AS ok FROM company_about WHERE ticker = ?`,
    );
    const missing: string[] = [];
    for (const row of objects) {
      const ticker = cell(row, "ticker").toUpperCase();
      if (!ticker || ticker === "TICKER") continue;
      if (!exists.get(ticker)) missing.push(ticker);
    }
    probe.close();
    for (const t of missing) {
      if (ensureCompanyAboutRow(t)) created += 1;
    }
  }

  const db = new Database(ABOUT_PATH);
  db.pragma("busy_timeout = 8000");
  db.pragma("journal_mode = WAL");

  const selectExisting = db.prepare(
    `SELECT scraped_about_clean, products, end_markets, company_sector,
            group_name, recent_moves, business_model
     FROM company_about WHERE ticker = ?`,
  );
  const updateStmt = db.prepare(
    `UPDATE company_about SET
       scraped_about_clean = @scraped_about_clean,
       has_scraped_about_clean = @has_scraped_about_clean,
       scraped_clean_at = @scraped_clean_at,
       products = @products,
       end_markets = @end_markets,
       company_sector = @company_sector,
       group_name = @group_name,
       recent_moves = @recent_moves,
       business_model = @business_model,
       fetched_at = @fetched_at
     WHERE ticker = @ticker`,
  );

  const now = new Date().toISOString();
  let updated = 0;
  let skipped = 0;
  let cleanWrites = 0;
  let groups = 0;
  let moves = 0;

  const apply = db.transaction(() => {
    for (const row of objects) {
      const ticker = cell(row, "ticker").toUpperCase();
      if (!ticker || ticker === "TICKER") {
        skipped += 1;
        continue;
      }

      const existing = selectExisting.get(ticker) as Existing | undefined;
      if (!existing) {
        skipped += 1;
        continue;
      }

      const confidence = cell(row, "confidence");
      const rank = confRank(confidence);
      const screenNote = cell(row, "screen_note");
      const businessModel = cell(row, "business_model");
      const products = cell(row, "products");
      const endMarkets = cell(row, "end_markets");
      const groupName = cell(row, "group_name");
      const recentMoves = cell(row, "recent_moves");
      const sectorFromNote = parseSectorFromScreenNote(screenNote);
      const cleanCandidate =
        rank >= 1 ? pickCleanText(screenNote, businessModel) : null;

      const nextProducts = preferText(existing.products, products || null);
      const nextEnd = preferText(existing.end_markets, endMarkets || null);
      const nextGroup =
        groupName || (existing.group_name ?? "").trim() || null;
      const nextMoves =
        recentMoves || (existing.recent_moves ?? "").trim() || null;
      const nextModel =
        businessModel || (existing.business_model ?? "").trim() || null;
      // Do not clobber NSE listing sector path — only fill empty company_sector.
      const nextSector =
        (existing.company_sector ?? "").trim() ||
        sectorFromNote ||
        null;

      let nextClean = (existing.scraped_about_clean ?? "").trim() || null;
      let wroteClean = false;
      if (cleanCandidate) {
        if (!nextClean) {
          nextClean = cleanCandidate;
          wroteClean = true;
        } else if (
          rank >= 2 &&
          cleanCandidate.length >= Math.min(nextClean.length, 120)
        ) {
          nextClean = cleanCandidate;
          wroteClean = true;
        } else if (rank >= 3 && cleanCandidate.length > nextClean.length + 40) {
          nextClean = cleanCandidate;
          wroteClean = true;
        }
      }
      if (wroteClean) cleanWrites += 1;
      if (nextGroup) groups += 1;
      if (nextMoves) moves += 1;

      updateStmt.run({
        ticker,
        scraped_about_clean: nextClean,
        has_scraped_about_clean: nextClean && nextClean.length >= 80 ? 1 : 0,
        scraped_clean_at: nextClean ? now : null,
        products: nextProducts,
        end_markets: nextEnd,
        company_sector: nextSector,
        group_name: nextGroup,
        recent_moves: nextMoves,
        business_model: nextModel,
        fetched_at: now,
      });
      updated += 1;
    }
  });
  apply();
  db.close();

  invalidateCompanyCache();

  console.log(
    JSON.stringify(
      {
        csv: csvPath,
        rows: objects.length,
        created_rows: created,
        updated,
        clean_writes: cleanWrites,
        with_group_name: groups,
        with_recent_moves: moves,
        skipped,
      },
      null,
      2,
    ),
  );
}

main();
