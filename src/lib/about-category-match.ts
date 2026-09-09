/**
 * Match corporate-event category keywords against clean company About text.
 * Lexical first; optional LLM ranking of candidates.
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { loadAllCompanies, type CompanyRow } from "./db";
import {
  loadCorporateEventKeywords,
  matchCorporateEventKeywords,
} from "./corporate-event-keywords";
import { completeJson, checkLlmStatus } from "./llm-client";
import { loadLlmConfig } from "./llm-config";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "about_categories.db");

export type AboutCategoryHit = {
  keyword: string;
  family: string;
  score: number;
  method: "lexical" | "llm";
  why: string | null;
};

export type AboutCategoryRow = {
  ticker: string;
  name: string;
  market: string;
  about_source: "clean" | "llm" | "about" | "none";
  about_chars: number;
  matches: AboutCategoryHit[];
  matched_at: string | null;
};

function ensureDb(): Database.Database {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS about_category_matches (
      ticker TEXT PRIMARY KEY,
      market TEXT NOT NULL,
      name TEXT NOT NULL,
      about_source TEXT NOT NULL,
      about_chars INTEGER NOT NULL DEFAULT 0,
      matches_json TEXT NOT NULL DEFAULT '[]',
      matched_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_acm_market ON about_category_matches(market);
    CREATE INDEX IF NOT EXISTS idx_acm_matched ON about_category_matches(matched_at DESC);
  `);
  return db;
}

/** Prefer cleaned scrape, then LLM about, then manual about. */
export function pickCleanAbout(c: {
  scraped_about_clean?: string | null;
  llm_about?: string | null;
  about?: string | null;
}): { text: string; source: AboutCategoryRow["about_source"] } {
  const clean = (c.scraped_about_clean || "").trim();
  if (clean.length >= 80) return { text: clean, source: "clean" };
  const llm = (c.llm_about || "").trim();
  if (llm.length >= 80) return { text: llm, source: "llm" };
  const about = (c.about || "").trim();
  if (about.length >= 40) return { text: about, source: "about" };
  return { text: "", source: "none" };
}

function lexicalHits(text: string, limit = 24): AboutCategoryHit[] {
  const hits = matchCorporateEventKeywords(text, { limit });
  const file = loadCorporateEventKeywords();
  // Also try family keys (shorter umbrella labels)
  const lower = text.toLowerCase();
  const seen = new Set(hits.map((h) => h.keyword.toLowerCase()));
  const familyHits: AboutCategoryHit[] = [];
  for (const fam of Object.keys(file.families || {})) {
    if (fam.length < 4) continue;
    const key = fam.toLowerCase();
    if (seen.has(key)) continue;
    if (!lower.includes(key)) continue;
    seen.add(key);
    familyHits.push({
      keyword: fam,
      family: fam,
      score: Math.min(1, fam.length / 40),
      method: "lexical",
      why: "Family label in about text",
    });
    if (hits.length + familyHits.length >= limit) break;
  }
  const merged = [
    ...hits.map((h) => ({
      keyword: h.keyword,
      family: h.family,
      score: Math.min(1, h.keyword.length / 48),
      method: "lexical" as const,
      why: "Keyword substring in about",
    })),
    ...familyHits,
  ];
  return merged.slice(0, limit);
}

async function llmRankHits(
  ticker: string,
  name: string,
  about: string,
  candidates: AboutCategoryHit[],
): Promise<AboutCategoryHit[] | null> {
  if (!candidates.length) return null;
  const cfg = loadLlmConfig();
  const status = await checkLlmStatus(cfg);
  if (!status.available) return null;

  const list = candidates
    .slice(0, 40)
    .map((c, i) => `${i + 1}. ${c.keyword}`)
    .join("\n");
  const excerpt = about.slice(0, 2800);
  const system = `You tag Indian listed companies from their About text using ONLY the provided category list (Screener-style corporate event / business tags).
Return JSON: {"matches":[{"keyword":"...","why":"short reason","score":0.0-1.0}]}
Rules:
- Pick at most 8 keywords that truly fit the company's business or notable themes in the text.
- keyword MUST be copied exactly from the candidate list.
- Prefer specific business-relevant tags (sector, products, expansion, contracts) over generic noise (Announcement, Update).
- If nothing fits well, return {"matches":[]}.`;
  const user = `Ticker: ${ticker}\nName: ${name}\n\nAbout:\n${excerpt}\n\nCandidates:\n${list}`;
  try {
    const parsed = await completeJson(cfg, system, user, {
      skipStatusCheck: true,
      numPredict: 800,
    });
    const rows = Array.isArray((parsed as { matches?: unknown })?.matches)
      ? ((parsed as { matches: Array<Record<string, unknown>> }).matches)
      : [];
    const byKw = new Map(
      candidates.map((c) => [c.keyword.toLowerCase(), c] as const),
    );
    const out: AboutCategoryHit[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const kw = String(r.keyword || "").trim();
      if (!kw || seen.has(kw.toLowerCase())) continue;
      const base = byKw.get(kw.toLowerCase());
      if (!base) continue;
      seen.add(kw.toLowerCase());
      const score =
        typeof r.score === "number" && Number.isFinite(r.score)
          ? Math.max(0, Math.min(1, r.score))
          : 0.7;
      out.push({
        keyword: base.keyword,
        family: base.family,
        score,
        method: "llm",
        why: String(r.why || "").trim().slice(0, 240) || null,
      });
      if (out.length >= 8) break;
    }
    return out;
  } catch {
    return null;
  }
}

export async function matchAboutCategoriesForCompany(
  c: CompanyRow,
  opts?: { llm?: boolean; lexicalLimit?: number },
): Promise<AboutCategoryRow> {
  const { text, source } = pickCleanAbout(c);
  const now = new Date().toISOString();
  if (!text) {
    return {
      ticker: c.ticker.toUpperCase(),
      name: c.name || c.ticker,
      market: c.market || "NSE",
      about_source: "none",
      about_chars: 0,
      matches: [],
      matched_at: now,
    };
  }

  let matches = lexicalHits(text, opts?.lexicalLimit ?? 24);
  if (opts?.llm) {
    const ranked = await llmRankHits(
      c.ticker,
      c.name || c.ticker,
      text,
      matches,
    );
    if (ranked?.length) matches = ranked;
  }

  return {
    ticker: c.ticker.toUpperCase(),
    name: c.name || c.ticker,
    market: c.market || "NSE",
    about_source: source,
    about_chars: text.length,
    matches,
    matched_at: now,
  };
}

export function saveAboutCategoryMatch(row: AboutCategoryRow): void {
  const db = ensureDb();
  try {
    db.prepare(
      `
      INSERT INTO about_category_matches (
        ticker, market, name, about_source, about_chars, matches_json, matched_at
      ) VALUES (
        @ticker, @market, @name, @about_source, @about_chars, @matches_json, @matched_at
      )
      ON CONFLICT(ticker) DO UPDATE SET
        market=excluded.market,
        name=excluded.name,
        about_source=excluded.about_source,
        about_chars=excluded.about_chars,
        matches_json=excluded.matches_json,
        matched_at=excluded.matched_at
      `,
    ).run({
      ticker: row.ticker,
      market: row.market,
      name: row.name,
      about_source: row.about_source,
      about_chars: row.about_chars,
      matches_json: JSON.stringify(row.matches),
      matched_at: row.matched_at,
    });
  } finally {
    db.close();
  }
}

export function listAboutCategoryMatches(opts?: {
  market?: string;
  q?: string;
  keyword?: string;
  limit?: number;
  offset?: number;
}): { rows: AboutCategoryRow[]; total: number } {
  const db = ensureDb();
  try {
    const limit = Math.min(500, Math.max(1, opts?.limit ?? 100));
    const offset = Math.max(0, opts?.offset ?? 0);
    const market = (opts?.market || "All").trim();
    const q = (opts?.q || "").trim().toLowerCase();
    const keyword = (opts?.keyword || "").trim().toLowerCase();

    let where = `WHERE 1=1`;
    const params: unknown[] = [];
    if (market && market !== "All") {
      where += ` AND market = ?`;
      params.push(market);
    }
    if (q) {
      where += ` AND (LOWER(ticker) LIKE ? OR LOWER(name) LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`);
    }
    if (keyword) {
      where += ` AND LOWER(matches_json) LIKE ?`;
      params.push(`%${keyword}%`);
    }

    const total = (
      db.prepare(`SELECT COUNT(*) AS c FROM about_category_matches ${where}`).get(
        ...params,
      ) as { c: number }
    ).c;

    const raw = db
      .prepare(
        `SELECT ticker, market, name, about_source, about_chars, matches_json, matched_at
         FROM about_category_matches ${where}
         ORDER BY matched_at DESC, ticker
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<{
      ticker: string;
      market: string;
      name: string;
      about_source: AboutCategoryRow["about_source"];
      about_chars: number;
      matches_json: string;
      matched_at: string | null;
    }>;

    const rows = raw.map((r) => {
      let matches: AboutCategoryHit[] = [];
      try {
        matches = JSON.parse(r.matches_json || "[]") as AboutCategoryHit[];
      } catch {
        matches = [];
      }
      return {
        ticker: r.ticker,
        market: r.market,
        name: r.name,
        about_source: r.about_source,
        about_chars: r.about_chars,
        matches,
        matched_at: r.matched_at,
      };
    });

    return { rows, total };
  } finally {
    db.close();
  }
}

export function aboutCategoryStats(): {
  tickers: number;
  with_matches: number;
  keywords_in_json: number;
  families_in_json: number;
} {
  const file = loadCorporateEventKeywords();
  const db = ensureDb();
  try {
    const tickers = (
      db.prepare(`SELECT COUNT(*) AS c FROM about_category_matches`).get() as {
        c: number;
      }
    ).c;
    const with_matches = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM about_category_matches
           WHERE matches_json != '[]' AND length(matches_json) > 2`,
        )
        .get() as { c: number }
    ).c;
    return {
      tickers,
      with_matches,
      keywords_in_json: file.keywords.length,
      families_in_json: Object.keys(file.families || {}).length,
    };
  } finally {
    db.close();
  }
}

export function companiesWithCleanAbout(opts?: {
  market?: string;
  limit?: number;
}): CompanyRow[] {
  const market = (opts?.market || "All").trim();
  let rows = loadAllCompanies().filter((c) => {
    const { text } = pickCleanAbout(c);
    return text.length >= 80;
  });
  if (market && market !== "All") {
    rows = rows.filter(
      (c) => (c.market || "").toUpperCase() === market.toUpperCase(),
    );
  }
  if (opts?.limit && opts.limit > 0) rows = rows.slice(0, opts.limit);
  return rows;
}
