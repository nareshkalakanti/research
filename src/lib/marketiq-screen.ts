/**
 * MarketIQ — NSE corporate announcements (CAME) feed → extract → score.
 * Extract: pdf-parse, OCR fallback. Sentiment/impact via lexical formula + Mistral.
 *
 * SENTIMENT = Count(positive) - Count(negative) + Category_Adjustment
 *   → Bullish / Neutral / Bearish + Confidence%
 * IMPACT = Category_Base × Sentiment_Multiplier × Detail_Bonus × Specificity_Bonus
 *   → capped at 10 (0–10)
 */
import fs from "fs";
import path from "path";
import { downloadBuybackPdf, isBuybackPdfProxyUrl } from "./buyback-screen";
import {
  listCorporateEventKeywords,
  matchCorporateEventKeywords,
  primaryCorporateEventKeyword,
} from "./corporate-event-keywords";
import { ocrImageWithQianfan } from "./corporate-data-extract";
import { loadAllCompanies } from "./db";
import { checkLlmStatus, completeJson } from "./llm-client";
import { loadLlmConfig } from "./llm-config";
import { discoverNseMarketAnnouncements } from "./nse-investor-discover";
import { clampAnnouncedDays } from "./announced-lookback";
import { rasterizePdfPages } from "./pdf-rasterize";
import { announcementDedupeKey } from "./announcement-dedupe";
import { matchMarketIqFundsInText } from "./marketiq-fund-aliases";
import { marketIqDbFile } from "./iq-dbs";
import { openSqliteNamed } from "./sqlite-utils";
import { attachTickerQuoteStats } from "./ticker-quote-stats";

const DATA_DIR = path.join(process.cwd(), "data");
const LDR_CATEGORIES_PATH = path.join(
  DATA_DIR,
  "ldr_announcement_categories.json",
);
const SCORING_PATH = path.join(DATA_DIR, "marketiq-scoring.json");
const PROMPT_PATH = path.join(
  process.cwd(),
  "prompts",
  "marketiq-announcement.system.txt",
);

export type MarketIqHit = {
  ticker: string;
  company: string | null;
  title: string;
  url: string | null;
  announced_at: string | null;
  period: string | null;
  provider: string;
  index?: string;
  mcap_cr?: number | null;
};

export type MarketIqSentiment = "Bullish" | "Bearish" | "Neutral";

export type MarketIqFundChip = {
  name: string;
  alias: string;
  chip_key: string;
};

export type MarketIqExtract = {
  ticker: string | null;
  company: string | null;
  headline: string;
  summary: string;
  category: string;
  categories: string[];
  sentiment: MarketIqSentiment;
  sentiment_why: string | null;
  /** 0–100 */
  confidence: number;
  impact: number;
  announcement_date: string | null;
  /** Catalog fund names found in extracted text (alias chips). */
  funds_mentioned?: MarketIqFundChip[];
  score_trace: {
    positive_count: number;
    negative_count: number;
    category_adjustment: number;
    raw_sentiment: number;
    category_base: number;
    sentiment_multiplier: number;
    detail_bonus: number;
    specificity_bonus: number;
    positive_hits: string[];
    negative_hits: string[];
  };
};

export type MarketIqScreenResult = {
  ok: boolean;
  extract: MarketIqExtract;
  engine: string;
  text_chars: number;
  /** Full PDF text when available (Extract / Copy). */
  text?: string;
  text_excerpt: string;
  source_url: string | null;
  error?: string;
  id?: number;
};

export type MarketIqHistoryRow = {
  id: number;
  ticker: string | null;
  company: string | null;
  headline: string;
  summary: string;
  category: string;
  sentiment: string;
  sentiment_why: string | null;
  confidence: number | null;
  impact: number;
  announcement_date: string | null;
  source_url: string | null;
  screened_at: string;
  engine: string | null;
  funds_mentioned?: MarketIqFundChip[];
  mcap_cr?: number | null;
};

type ScoringFile = {
  positive_words: string[];
  negative_words: string[];
  default_category_base: number;
  default_category_adjustment: number;
  sentiment_thresholds: { bullish_min: number; bearish_max: number };
  sentiment_multipliers: Record<MarketIqSentiment, number>;
  detail_bonus: {
    base: number;
    amount_hit: number;
    date_hit: number;
    instrument_hit: number;
    max: number;
  };
  specificity_bonus: {
    base: number;
    named_counterparty: number;
    exact_figure: number;
    percent_or_bps: number;
    max: number;
  };
  category_rules: Array<{
    match: string;
    base: number;
    adjustment: number;
  }>;
};

let scoringCache: ScoringFile | null = null;
let promptCache: string | null = null;

function loadScoring(): ScoringFile {
  if (scoringCache) return scoringCache;
  scoringCache = JSON.parse(
    fs.readFileSync(SCORING_PATH, "utf8"),
  ) as ScoringFile;
  return scoringCache;
}

function loadSystemPrompt(): string {
  if (promptCache) return promptCache;
  promptCache = fs.readFileSync(PROMPT_PATH, "utf8");
  return promptCache;
}

function ensureHistorySchema(): void {
  const db = openSqliteNamed(marketIqDbFile(), { wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS announcement_screens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_url TEXT,
        ticker TEXT,
        company TEXT,
        headline TEXT NOT NULL,
        summary TEXT NOT NULL,
        category TEXT NOT NULL,
        categories_json TEXT,
        sentiment TEXT NOT NULL,
        sentiment_why TEXT,
        impact INTEGER NOT NULL,
        announcement_date TEXT,
        extract_json TEXT NOT NULL,
        engine TEXT,
        text_chars INTEGER,
        screened_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_announcement_screened
        ON announcement_screens(screened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_announcement_ticker
        ON announcement_screens(ticker);
    `);
    const cols = db
      .prepare(`PRAGMA table_info(announcement_screens)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "sentiment_confidence")) {
      db.exec(
        `ALTER TABLE announcement_screens ADD COLUMN sentiment_confidence REAL`,
      );
    }
  } finally {
    db.close();
  }
}

/** LDR category catalog (filter UI) — not live announcement rows. */
export function loadLdrAnnouncementCategories(): {
  total: number;
  categories: string[];
  source: string | null;
  updated: string | null;
} {
  if (!fs.existsSync(LDR_CATEGORIES_PATH)) {
    return { total: 0, categories: [], source: null, updated: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(LDR_CATEGORIES_PATH, "utf8")) as {
      total?: number;
      categories?: string[];
      source?: string;
      timestamp?: string;
    };
    const categories = Array.isArray(raw.categories)
      ? raw.categories.map((c) => String(c).trim()).filter(Boolean)
      : [];
    return {
      total: raw.total ?? categories.length,
      categories,
      source: raw.source ?? null,
      updated: raw.timestamp ?? null,
    };
  } catch {
    return { total: 0, categories: [], source: null, updated: null };
  }
}

/**
 * Fetch NSE CAME announcements for the last N days (equities + SME).
 * Optional `q` narrows by title substring (client/API search).
 */
export async function discoverMarketIqAnnounced(
  daysBack = 1,
  opts?: { q?: string | null; fromOffset?: number },
): Promise<{
  ok: true;
  days: number;
  count: number;
  tickers: string[];
  sources: MarketIqHit[];
  note?: string;
}> {
  const days = clampAnnouncedDays(daysBack);
  const q = opts?.q?.trim() || null;
  try {
    const hits = await discoverNseMarketAnnouncements(days, {
      q,
      fromOffset: opts?.fromOffset,
    });
    const sources: MarketIqHit[] = hits.map((h) => ({
      ticker: h.ticker,
      company: h.company,
      title: h.title,
      url: h.url,
      announced_at: h.announced_at,
      period: h.period,
      provider: h.provider,
      index: h.index,
    }));
    const tickers = [...new Set(sources.map((s) => s.ticker))];
    return {
      ok: true,
      days,
      count: sources.length,
      tickers,
      sources,
      note: q
        ? `NSE corporate-announcements · filtered “${q}”`
        : "NSE corporate-announcements (equities + SME)",
    };
  } catch (e) {
    return {
      ok: true,
      days,
      count: 0,
      tickers: [],
      sources: [],
      note: e instanceof Error ? e.message : "NSE fetch failed",
    };
  }
}

/** Persist raw announcement rows for later analyse (data-first save). */
export function saveMarketIqHits(hits: MarketIqHit[]): number {
  if (!hits.length) return 0;
  ensureHistorySchema();
  const db = openSqliteNamed(marketIqDbFile(), { wal: true });
  try {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO announcement_screens (
        source_url, ticker, company, headline, summary, category,
        categories_json, sentiment, sentiment_why, impact,
        announcement_date, extract_json, engine, text_chars, screened_at,
        sentiment_confidence
      ) VALUES (
        @source_url, @ticker, @company, @headline, @summary, @category,
        NULL, 'pending', NULL, 0,
        @announcement_date, @extract_json, 'nse-came-fetch', 0, @screened_at,
        NULL
      )
    `);
    let n = 0;
    const tx = db.transaction(() => {
      for (const h of hits) {
        const headline = (h.title || "").trim();
        if (!headline) continue;
        const url = h.url?.trim() || null;
        if (url) {
          const exists = db
            .prepare(
              `SELECT id FROM announcement_screens WHERE source_url = ? LIMIT 1`,
            )
            .get(url) as { id: number } | undefined;
          if (exists) continue;
        }
        stmt.run({
          source_url: url,
          ticker: h.ticker || null,
          company: h.company,
          headline,
          summary: headline,
          category: "Unclassified",
          announcement_date: h.announced_at?.slice(0, 10) || null,
          extract_json: JSON.stringify({
            ticker: h.ticker,
            company: h.company,
            title: h.title,
            url: h.url,
            announced_at: h.announced_at,
            provider: h.provider,
            index: h.index ?? null,
            pending: true,
          }),
          screened_at: now,
        });
        n += 1;
      }
    });
    tx();
    return n;
  } finally {
    db.close();
  }
}

function confidenceFromExtractJson(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { confidence?: unknown };
    const c = Number(j.confidence);
    if (!Number.isFinite(c)) return null;
    // Support legacy 0–1 and new 0–100
    if (c <= 1) return Math.round(c * 100);
    return Math.max(0, Math.min(100, Math.round(c)));
  } catch {
    return null;
  }
}

function fundsFromExtractJson(raw: string | null): MarketIqFundChip[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw) as { funds_mentioned?: unknown };
    if (!Array.isArray(j.funds_mentioned)) return [];
    const out: MarketIqFundChip[] = [];
    const seen = new Set<string>();
    for (const item of j.funds_mentioned) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const alias = String(row.alias || "").trim();
      const chip_key = String(row.chip_key || "").trim().toLowerCase();
      const name = String(row.name || "").trim();
      if (!alias || !chip_key || seen.has(chip_key)) continue;
      seen.add(chip_key);
      out.push({ name: name || alias, alias, chip_key });
    }
    return out;
  } catch {
    return [];
  }
}

export function listMarketIqHistory(
  limit = 40,
  opts?: { q?: string | null },
): MarketIqHistoryRow[] {
  ensureHistorySchema();
  const db = openSqliteNamed(marketIqDbFile(), {
    readonly: true,
    wal: true,
  });
  try {
    const want = Math.min(2000, Math.max(1, limit));
    // Pull a wider window before dedupe so older analysed rows (e.g. earlier today)
    // are not crowded out by a flood of new screens.
    const n = Math.min(5000, Math.max(want * 3, want));
    const q = (opts?.q || "").trim().toLowerCase();
    const rows = (
      q
        ? (db
            .prepare(
              `SELECT id, ticker, company, headline, summary, category, sentiment,
                      sentiment_why, impact, announcement_date, source_url, screened_at,
                      engine, extract_json, sentiment_confidence
               FROM announcement_screens
               WHERE lower(COALESCE(ticker, '')) LIKE ?
                  OR lower(COALESCE(company, '')) LIKE ?
                  OR lower(COALESCE(headline, '')) LIKE ?
                  OR lower(COALESCE(summary, '')) LIKE ?
               ORDER BY screened_at DESC
               LIMIT ?`,
            )
            .all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, n) as Array<
            MarketIqHistoryRow & {
              extract_json?: string;
              sentiment_confidence?: number | null;
            }
          >)
        : (db
            .prepare(
              `SELECT id, ticker, company, headline, summary, category, sentiment,
                      sentiment_why, impact, announcement_date, source_url, screened_at,
                      engine, extract_json, sentiment_confidence
               FROM announcement_screens
               ORDER BY screened_at DESC
               LIMIT ?`,
            )
            .all(n) as Array<
            MarketIqHistoryRow & {
              extract_json?: string;
              sentiment_confidence?: number | null;
            }
          >)
    );
    const mapped = rows.map((r) => {
      const fromCol =
        typeof r.sentiment_confidence === "number" &&
        Number.isFinite(r.sentiment_confidence)
          ? Math.max(0, Math.min(100, Math.round(r.sentiment_confidence)))
          : null;
      const confidence =
        fromCol ?? confidenceFromExtractJson(r.extract_json ?? null);
      const funds_mentioned = fundsFromExtractJson(r.extract_json ?? null);
      return {
        id: r.id,
        ticker: r.ticker,
        company: r.company,
        headline: r.headline,
        summary: r.summary,
        category: r.category,
        sentiment: r.sentiment,
        sentiment_why: r.sentiment_why,
        confidence,
        impact: r.impact,
        announcement_date: r.announcement_date,
        source_url: r.source_url,
        screened_at: r.screened_at,
        engine: r.engine,
        funds_mentioned,
      };
    });

    // One row per issuer + day + title (keep newest / scored over pending).
    const byKey = new Map<string, MarketIqHistoryRow>();
    const rank = (r: MarketIqHistoryRow) => {
      let s = 0;
      const sent = (r.sentiment || "").toLowerCase();
      if (sent && sent !== "pending") s += 30;
      if ((r.impact || 0) > 0) s += 10;
      if (r.engine && r.engine !== "nse-came-fetch") s += 5;
      return s;
    };
    for (const r of mapped) {
      const key = announcementDedupeKey({
        ticker: r.ticker,
        company: r.company,
        title: r.headline,
        day: r.announcement_date || r.screened_at,
      });
      if (!key.replace(/\|/g, "")) continue;
      const prev = byKey.get(key);
      if (!prev || rank(r) > rank(prev) || (rank(r) === rank(prev) && r.id > prev.id)) {
        byKey.set(key, r);
      }
    }
    return attachTickerQuoteStats(
      [...byKey.values()]
        .sort((a, b) => {
          const at = Date.parse(a.screened_at || a.announcement_date || "") || 0;
          const bt = Date.parse(b.screened_at || b.announcement_date || "") || 0;
          return bt - at;
        })
        .slice(0, want),
    );
  } finally {
    db.close();
  }
}

/**
 * Latest analysed MarketIQ row per ticker (skips pending NSE stubs).
 * Direct ticker lookup — not limited to the global history window.
 */
export function listLatestMarketIqByTickers(
  tickers: string[],
): Map<string, MarketIqHistoryRow> {
  const wanted = [
    ...new Set(
      tickers
        .map((t) => t.trim().toUpperCase())
        .filter((t) => t && !/^BSE\d{5,6}$/i.test(t)),
    ),
  ].slice(0, 80);
  const out = new Map<string, MarketIqHistoryRow>();
  if (!wanted.length) return out;

  ensureHistorySchema();
  const db = openSqliteNamed(marketIqDbFile(), {
    readonly: true,
    wal: true,
  });
  try {
    const stmt = db.prepare(
      `SELECT id, ticker, company, headline, summary, category, sentiment,
              sentiment_why, impact, announcement_date, source_url, screened_at,
              engine, extract_json, sentiment_confidence
       FROM announcement_screens
       WHERE UPPER(COALESCE(ticker, '')) = ?
         AND lower(COALESCE(sentiment, 'pending')) != 'pending'
         AND COALESCE(engine, '') != 'nse-came-fetch'
       ORDER BY screened_at DESC, id DESC
       LIMIT 12`,
    );
    for (const ticker of wanted) {
      const rows = stmt.all(ticker) as Array<
        MarketIqHistoryRow & {
          extract_json?: string;
          sentiment_confidence?: number | null;
        }
      >;
      if (!rows.length) continue;
      const ranked = [...rows].sort((a, b) => {
        const score = (r: (typeof rows)[0]) => {
          let s = 0;
          const sum = (r.summary || "").trim();
          // Prefer short scored summaries over raw letter dumps
          if (sum.length > 40 && sum.length < 420) s += 40;
          else if (sum.length >= 420) s -= 20;
          if ((r.impact || 0) >= 5) s += 15;
          if ((r.impact || 0) >= 8) s += 10;
          const hl = (r.headline || "").toLowerCase();
          if (/board meeting|outcome|issue of securities|preferential|fund|order|result/i.test(hl))
            s += 25;
          if (/trading window|certificate|depositor/i.test(hl)) s -= 30;
          if ((r.engine || "").includes("llm")) s += 5;
          return s;
        };
        return score(b) - score(a);
      });
      const r = ranked[0]!;
      const fromCol =
        typeof r.sentiment_confidence === "number" &&
        Number.isFinite(r.sentiment_confidence)
          ? Math.max(0, Math.min(100, Math.round(r.sentiment_confidence)))
          : null;
      out.set(ticker, {
        id: r.id,
        ticker: r.ticker,
        company: r.company,
        headline: r.headline,
        summary: r.summary,
        category: r.category,
        sentiment: r.sentiment,
        sentiment_why: r.sentiment_why,
        confidence:
          fromCol ?? confidenceFromExtractJson(r.extract_json ?? null),
        impact: r.impact,
        announcement_date: r.announcement_date,
        source_url: r.source_url,
        screened_at: r.screened_at,
        engine: r.engine,
        funds_mentioned: fundsFromExtractJson(r.extract_json ?? null),
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/** PDF URLs already analysed (not raw NSE fetch stubs). */
export function listScoredMarketIqUrls(): Set<string> {
  ensureHistorySchema();
  const db = openSqliteNamed(marketIqDbFile(), {
    readonly: true,
    wal: true,
  });
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT source_url AS u
         FROM announcement_screens
         WHERE source_url IS NOT NULL
           AND TRIM(source_url) != ''
           AND lower(COALESCE(sentiment, 'pending')) != 'pending'
           AND COALESCE(engine, '') != 'nse-came-fetch'`,
      )
      .all() as Array<{ u: string }>;
    return new Set(rows.map((r) => r.u.trim()).filter(Boolean));
  } finally {
    db.close();
  }
}

/** Pending stub rows (saved announced, not yet analysed). */
export function listMarketIqPendingHits(): MarketIqHit[] {
  ensureHistorySchema();
  const scored = listScoredMarketIqUrls();
  const db = openSqliteNamed(marketIqDbFile(), {
    readonly: true,
    wal: true,
  });
  try {
    const rows = db
      .prepare(
        `SELECT id, source_url, ticker, company, headline, announcement_date,
                extract_json, engine, sentiment
         FROM announcement_screens
         WHERE source_url IS NOT NULL AND TRIM(source_url) != ''
         ORDER BY id DESC
         LIMIT 8000`,
      )
      .all() as Array<{
      id: number;
      source_url: string;
      ticker: string | null;
      company: string | null;
      headline: string | null;
      announcement_date: string | null;
      extract_json: string | null;
      engine: string | null;
      sentiment: string | null;
    }>;
    const out: MarketIqHit[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const hit = pendingHitFromRow(r, scored, seen);
      if (hit) out.push(hit);
    }
    return out;
  } finally {
    db.close();
  }
}

/** Pending NSE stubs for one ticker (watchlist Get data). */
export function listMarketIqPendingForTicker(
  ticker: string,
  limit = 8,
): Array<MarketIqHit & { historyId: number }> {
  const want = ticker.trim().toUpperCase();
  if (!want) return [];
  ensureHistorySchema();
  const scored = listScoredMarketIqUrls();
  const db = openSqliteNamed(marketIqDbFile(), {
    readonly: true,
    wal: true,
  });
  try {
    const rows = db
      .prepare(
        `SELECT id, source_url, ticker, company, headline, announcement_date,
                extract_json, engine, sentiment
         FROM announcement_screens
         WHERE UPPER(COALESCE(ticker, '')) = ?
           AND source_url IS NOT NULL AND TRIM(source_url) != ''
         ORDER BY screened_at DESC, id DESC
         LIMIT ?`,
      )
      .all(want, Math.min(40, Math.max(1, limit * 3))) as Array<{
      id: number;
      source_url: string;
      ticker: string | null;
      company: string | null;
      headline: string | null;
      announcement_date: string | null;
      extract_json: string | null;
      engine: string | null;
      sentiment: string | null;
    }>;
    const out: Array<MarketIqHit & { historyId: number }> = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const hit = pendingHitFromRow(r, scored, seen);
      if (!hit) continue;
      out.push({ ...hit, historyId: r.id });
      if (out.length >= limit) break;
    }
    return out;
  } finally {
    db.close();
  }
}

function pendingHitFromRow(
  r: {
    id?: number;
    source_url: string;
    ticker: string | null;
    company: string | null;
    headline: string | null;
    announcement_date: string | null;
    extract_json: string | null;
    engine: string | null;
    sentiment: string | null;
  },
  scored: Set<string>,
  seen: Set<string>,
): MarketIqHit | null {
  const url = r.source_url.trim();
  if (!url || seen.has(url) || scored.has(url)) return null;
  const eng = (r.engine || "").trim();
  const sent = (r.sentiment || "pending").toLowerCase();
  let pending =
    sent === "pending" || eng === "nse-came-fetch" || eng === "exchange-fetch";
  let title = (r.headline || "").trim() || "Announcement";
  let announced_at: string | null = r.announcement_date;
  let period: string | null = null;
  let provider = "db";
  let index: string | undefined;
  try {
    const j = r.extract_json ? JSON.parse(r.extract_json) : null;
    if (j && j.pending === true) pending = true;
    if (j && typeof j.title === "string" && j.title.trim()) title = j.title.trim();
    if (j && typeof j.announced_at === "string") announced_at = j.announced_at;
    if (j && typeof j.period === "string") period = j.period;
    if (j && typeof j.provider === "string") provider = j.provider;
    if (j && typeof j.index === "string") index = j.index;
  } catch {
    /* ignore */
  }
  if (!pending) return null;
  seen.add(url);
  return {
    ticker: (r.ticker || "").toUpperCase() || "UNKNOWN",
    company: r.company,
    title,
    url,
    announced_at,
    period,
    provider,
    index,
  };
}

/**
 * Analyse a batch of announcements (pending-first).
 * Call repeatedly until remaining === 0.
 */
export async function scanMarketIqAnnouncements(opts: {
  days?: number;
  q?: string | null;
  limit?: number;
  pendingOnly?: boolean;
  sources?: MarketIqHit[] | null;
  /** Prefer speed: pdf-parse only (default true for scan). */
  skipOcr?: boolean;
}): Promise<{
  ok: true;
  days: number;
  total_candidates: number;
  attempted: number;
  analysed: number;
  failed: number;
  skipped: number;
  remaining: number;
  results: MarketIqScreenResult[];
  note?: string;
}> {
  const days = clampAnnouncedDays(opts.days ?? 1);
  const limit = Math.min(15, Math.max(1, opts.limit ?? 3));
  const pendingOnly = opts.pendingOnly !== false;
  const skipOcr = opts.skipOcr !== false;

  let sources: MarketIqHit[] = Array.isArray(opts.sources)
    ? opts.sources
    : [];
  if (!sources.length) {
    const found = await discoverMarketIqAnnounced(days, { q: opts.q });
    sources = found.sources;
  }

  const scored = listScoredMarketIqUrls();
  let skipped = 0;
  if (pendingOnly) {
    const pending: MarketIqHit[] = [];
    for (const s of sources) {
      const u = s.url?.trim();
      if (u && scored.has(u)) {
        skipped += 1;
        continue;
      }
      pending.push(s);
    }
    sources = pending;
  }

  const total_candidates = sources.length;
  const batch = sources.slice(0, limit);
  const results: MarketIqScreenResult[] = [];
  let analysed = 0;
  let failed = 0;

  for (const s of batch) {
    const r = await analyseMarketIqAnnouncement({
      url: s.url,
      tickerHint: s.ticker,
      companyHint: s.company,
      titleHint: s.title,
      announcedAt: s.announced_at,
      allowHeadlineOnly: true,
      skipOcr,
    });
    results.push(r);
    if (r.ok) analysed += 1;
    else failed += 1;
  }

  return {
    ok: true,
    days,
    total_candidates,
    attempted: batch.length,
    analysed,
    failed,
    skipped,
    remaining: Math.max(0, total_candidates - batch.length),
    results,
    note: skipOcr
      ? "Scan uses pdf-parse (OCR skipped for speed)"
      : undefined,
  };
}

export function isMarketIqPdfProxyUrl(url: string): boolean {
  return isBuybackPdfProxyUrl(url);
}

export async function downloadMarketIqPdf(
  url: string,
): Promise<Buffer | null> {
  return downloadBuybackPdf(url);
}

function marketIqAnalyzeModel(
  cfg: ReturnType<typeof loadLlmConfig>,
): string {
  return (
    process.env.LLM_MODEL_MARKETIQ?.trim() ||
    process.env.LLM_MODEL_HIGHLIGHTS?.trim() ||
    cfg.taskModels.highlightsAndShortSummaries ||
    cfg.llmModel
  );
}

function marketIqOcrMaxPages(): number {
  const n = Number(
    process.env.MARKETIQ_OCR_MAX_PAGES ||
      process.env.ORDERBOOK_OCR_MAX_PAGES ||
      process.env.CONCALL_OCR_MAX_PAGES,
  );
  if (Number.isFinite(n) && n > 0) return Math.min(40, Math.floor(n));
  return 12;
}

async function extractPdfText(buf: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    b: Buffer,
  ) => Promise<{ text?: string }>;
  const parsed = await pdfParse(buf);
  return (parsed.text || "").trim();
}

async function ocrPdf(buf: Buffer): Promise<string> {
  if (!(process.env.QIANFAN_OCR_BASE_URL || "").trim()) return "";
  const pages = await rasterizePdfPages(buf, {
    maxPages: marketIqOcrMaxPages(),
    dpi: 144,
  });
  const chunks: string[] = [];
  for (const page of pages) {
    const t = await ocrImageWithQianfan(
      page.dataUrl,
      "Transcribe this Indian exchange corporate announcement / press release. Preserve company name, ticker, amounts, dates, and key decisions. Plain text only.",
    );
    if (t.trim()) chunks.push(`--- page ${page.page} ---\n${t.trim()}`);
  }
  return chunks.join("\n\n").trim();
}

function dateFromNseArchiveUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/_(\d{2})(\d{2})(\d{4})\d{6}_/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function emptyExtract(): MarketIqExtract {
  const scoring = loadScoring();
  return {
    ticker: null,
    company: null,
    headline: "Corporate announcement",
    summary: "",
    category: "Unclassified",
    categories: [],
    sentiment: "Neutral",
    sentiment_why: null,
    confidence: 0,
    impact: 0,
    announcement_date: null,
    score_trace: {
      positive_count: 0,
      negative_count: 0,
      category_adjustment: scoring.default_category_adjustment,
      raw_sentiment: 0,
      category_base: scoring.default_category_base,
      sentiment_multiplier: scoring.sentiment_multipliers.Neutral,
      detail_bonus: scoring.detail_bonus.base,
      specificity_bonus: scoring.specificity_bonus.base,
      positive_hits: [],
      negative_hits: [],
    },
  };
}

function resolveCompanyMeta(
  ticker: string | null,
  company: string | null,
): { ticker: string | null; company: string | null } {
  let t = ticker?.trim().toUpperCase() || null;
  let c = company?.trim() || null;
  if (!t && !c) return { ticker: null, company: null };
  try {
    const rows = loadAllCompanies();
    if (t) {
      const hit = rows.find((r) => r.ticker.toUpperCase() === t);
      if (hit) return { ticker: hit.ticker, company: c || hit.name };
    }
    if (c) {
      const lower = c.toLowerCase();
      const hit = rows.find(
        (r) =>
          r.name.toLowerCase() === lower ||
          r.name.toLowerCase().includes(lower) ||
          lower.includes(r.name.toLowerCase().slice(0, 12)),
      );
      if (hit) return { ticker: hit.ticker, company: hit.name };
    }
  } catch {
    /* db optional */
  }
  return { ticker: t, company: c };
}

function lexicalHeadline(text: string): string {
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 12 && !/private and confidential/i.test(l));
  const subject = lines.find((l) =>
    /subject\s*:|intimation|press\s+release|announces|raises|allot/i.test(l),
  );
  const pick = subject || lines[0] || "Corporate announcement";
  return pick.slice(0, 220);
}

function lexicalSummary(text: string): string {
  const blob = text.replace(/\s+/g, " ").trim();
  if (blob.length < 80) return blob;
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 80);
  const body =
    paras.find(
      (p) =>
        !/private and confidential|disclaimer|forward[- ]looking/i.test(p),
    ) ||
    paras[0] ||
    blob;
  return body.slice(0, 700);
}

function countLexiconHits(
  text: string,
  words: string[],
): { count: number; hits: string[] } {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  let count = 0;
  for (const w of words) {
    const needle = w.toLowerCase().trim();
    if (needle.length < 3) continue;
    const re = new RegExp(
      `\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "gi",
    );
    const m = lower.match(re);
    if (m?.length) {
      count += m.length;
      hits.push(needle);
    }
  }
  return { count, hits: [...new Set(hits)].slice(0, 24) };
}

function categoryPriors(category: string): {
  base: number;
  adjustment: number;
} {
  const scoring = loadScoring();
  const cat = category.toLowerCase();
  let best: { match: string; base: number; adjustment: number } | null = null;
  for (const rule of scoring.category_rules) {
    const m = rule.match.toLowerCase();
    if (!cat.includes(m) && !m.includes(cat)) continue;
    if (!best || rule.match.length > best.match.length) {
      best = rule;
    }
  }
  return {
    base: best?.base ?? scoring.default_category_base,
    adjustment: best?.adjustment ?? scoring.default_category_adjustment,
  };
}

function detailBonus(text: string, signals: string[]): number {
  const scoring = loadScoring();
  const blob = `${text}\n${signals.join("\n")}`.toLowerCase();
  let b = scoring.detail_bonus.base;
  if (/₹|rs\.?\s*\d|crore|lakh|\binr\b|\busd\b|\beur\b/.test(blob)) {
    b += scoring.detail_bonus.amount_hit;
  }
  if (
    /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b|\b20\d{2}-\d{2}-\d{2}\b|\bfy\s*20\d{2}\b/.test(
      blob,
    )
  ) {
    b += scoring.detail_bonus.date_hit;
  }
  if (
    /qip|warrant|debenture|bond|equity|preferential|rights issue|fpo|ipo|gdr|adr/.test(
      blob,
    )
  ) {
    b += scoring.detail_bonus.instrument_hit;
  }
  return Math.min(scoring.detail_bonus.max, Math.round(b * 100) / 100);
}

function specificityBonus(text: string, signals: string[]): number {
  const scoring = loadScoring();
  const blob = `${text}\n${signals.join("\n")}`;
  let b = scoring.specificity_bonus.base;
  if (
    /\b(ltd|limited|pvt|private|inc|corp|bank|authority|ministry)\b/i.test(
      blob,
    ) &&
    /[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4}/.test(blob)
  ) {
    b += scoring.specificity_bonus.named_counterparty;
  }
  if (/₹\s*[\d,.]+|\b[\d,.]+\s*crore\b|\brs\.?\s*[\d,.]+/i.test(blob)) {
    b += scoring.specificity_bonus.exact_figure;
  }
  if (/\b\d+(\.\d+)?\s*%|\b\d+\s*bps\b|\bbasis points?\b/i.test(blob)) {
    b += scoring.specificity_bonus.percent_or_bps;
  }
  return Math.min(scoring.specificity_bonus.max, Math.round(b * 100) / 100);
}

function normalizeSentiment(
  raw: number,
): { sentiment: MarketIqSentiment; confidence: number } {
  const scoring = loadScoring();
  const { bullish_min, bearish_max } = scoring.sentiment_thresholds;
  let sentiment: MarketIqSentiment = "Neutral";
  if (raw >= bullish_min) sentiment = "Bullish";
  else if (raw <= bearish_max) sentiment = "Bearish";

  const magnitude = Math.min(10, Math.abs(raw));
  const near =
    sentiment === "Neutral"
      ? Math.max(0, 1 - Math.abs(raw) / Math.max(1, bullish_min))
      : magnitude / 10;
  const confidence = Math.max(
    35,
    Math.min(98, Math.round(45 + near * 50 + Math.min(3, magnitude) * 3)),
  );
  return { sentiment, confidence };
}

function applyScoreFormula(opts: {
  text: string;
  /** Lexicon sentiment on headline/summary — not full transcript body. */
  sentimentText?: string;
  category: string;
  extraPositive?: string[];
  extraNegative?: string[];
  detailSignals?: string[];
  specificitySignals?: string[];
}): Pick<
  MarketIqExtract,
  "sentiment" | "confidence" | "impact" | "score_trace"
> {
  const scoring = loadScoring();
  const sentimentBlob = (opts.sentimentText || opts.text).slice(0, 1800);
  const posLex = countLexiconHits(sentimentBlob, scoring.positive_words);
  const negLex = countLexiconHits(sentimentBlob, scoring.negative_words);
  const extraPos = (opts.extraPositive || [])
    .map((w) => w.toLowerCase().trim())
    .filter(Boolean);
  const extraNeg = (opts.extraNegative || [])
    .map((w) => w.toLowerCase().trim())
    .filter(Boolean);

  const positive_hits = [...new Set([...posLex.hits, ...extraPos])].slice(
    0,
    24,
  );
  const negative_hits = [...new Set([...negLex.hits, ...extraNeg])].slice(
    0,
    24,
  );
  const positive_count = Math.max(posLex.count, positive_hits.length);
  const negative_count = Math.max(negLex.count, negative_hits.length);

  const { base, adjustment } = categoryPriors(opts.category);
  const raw_sentiment = positive_count - negative_count + adjustment;
  const { sentiment, confidence } = normalizeSentiment(raw_sentiment);
  const sentiment_multiplier = scoring.sentiment_multipliers[sentiment] ?? 1;
  const detail_bonus = detailBonus(opts.text, opts.detailSignals || []);
  const specificity_bonus = specificityBonus(
    opts.text,
    opts.specificitySignals || [],
  );

  const impactRaw =
    base * sentiment_multiplier * detail_bonus * specificity_bonus;
  const impact = Math.max(0, Math.min(10, Math.round(impactRaw)));

  return {
    sentiment,
    confidence,
    impact,
    score_trace: {
      positive_count,
      negative_count,
      category_adjustment: adjustment,
      raw_sentiment,
      category_base: base,
      sentiment_multiplier,
      detail_bonus,
      specificity_bonus,
      positive_hits,
      negative_hits,
    },
  };
}

function categoryFromScoringText(text: string): string | null {
  const scoring = loadScoring();
  const lower = text.toLowerCase();
  let best: { match: string; base: number; len: number } | null = null;
  for (const rule of scoring.category_rules) {
    const m = rule.match.toLowerCase().trim();
    if (m.length < 3) continue;
    // Word-boundary match — avoids random "fraud"/"order" hits inside long PDFs.
    const re = new RegExp(
      `\\b${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`,
      "i",
    );
    if (!re.test(lower)) continue;
    if (
      !best ||
      rule.base > best.base ||
      (rule.base === best.base && rule.match.length > best.len)
    ) {
      best = { match: rule.match, base: rule.base, len: rule.match.length };
    }
  }
  return best?.match ?? null;
}

/** Severe labels must appear in title/lead — not only deep in a transcript body. */
function isSevereCategoryLabel(category: string): boolean {
  return /fraud|default|insolvency|bankruptcy|investigation|suspension|delisting/i.test(
    category,
  );
}

function isRoutineDisclosureTitle(title: string): boolean {
  return /transcript|earnings?\s+call|con\.?\s*call|concall|investor\s+meet|analysts?\/|institutional\s+investor\s+meet|financial\s+results|board\s+meeting|agm|egm|investor\s+presentation/i.test(
    title,
  );
}

/**
 * NSE often labels capital raises as "Outcome of Board Meeting".
 * Keep transcript/results titles sticky; allow substance categories to override
 * bare board/AGM/EGM procedural wrappers.
 */
function isProceduralMeetingTitle(title: string): boolean {
  if (
    /transcript|earnings?\s+call|con\.?\s*call|concall|investor\s+meet|financial\s+results|investor\s+presentation/i.test(
      title,
    )
  ) {
    return false;
  }
  return /board\s+meeting|\bagm\b|\begm\b/i.test(title);
}

function isProceduralMeetingCategory(category: string): boolean {
  const c = category.trim().toLowerCase();
  if (!c) return false;
  // Exact / leading procedural label without a substance suffix.
  if (/^(board meeting|agm|egm)(\s*update)?$/i.test(c)) return true;
  if (/^(board meeting|agm|egm)\s*\/\s*(update|resolution|resolutions)$/i.test(c))
    return true;
  return false;
}

/** Strip SEBI LODR boilerplate that false-triggers "Listing" / "Disclosure" tags. */
function stripRegBoilerplate(text: string): string {
  return text
    .replace(
      /\bSEBI\s*\([^)]*Listing Obligations[^)]*\)\s*Regulations,?\s*\d{0,4}/gi,
      " ",
    )
    .replace(
      /\bListing Obligations and Disclosure Requirements\b/gi,
      " ",
    )
    .replace(/\bDisclosure under Regulation\s+\d+\b/gi, " ")
    .replace(/\bRegulation\s+\d+\s+of\s+the\s+SEBI\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when category tokens actually appear in the filing (blocks invented LLM labels). */
function categoryHasTextEvidence(category: string, blob: string): boolean {
  const cat = category.trim().toLowerCase();
  if (!cat) return false;
  const lower = stripRegBoilerplate(blob).toLowerCase();
  if (lower.includes(cat)) return true;
  const stop =
    /^(and|with|from|under|board|meeting|general|corporate|update|announcement|the|for|of)$/;
  const tokens = cat
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !stop.test(t));
  if (!tokens.length) return false;
  let hits = 0;
  for (const t of tokens) {
    if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)) {
      hits += 1;
    }
  }
  // Multi-token labels (Capital Raise): require most tokens present as whole words.
  const need = tokens.length <= 1 ? 1 : Math.ceil(tokens.length * 0.6);
  return hits >= need;
}

function pickHighestBaseCategory(cats: string[]): string {
  let best = cats[0] || "Unclassified";
  let bestBase = categoryPriors(best).base;
  for (const c of cats.slice(1)) {
    const b = categoryPriors(c).base;
    if (
      b > bestBase + 0.05 ||
      (Math.abs(b - bestBase) <= 0.05 && c.length > best.length)
    ) {
      best = c;
      bestBase = b;
    }
  }
  return best;
}

/** Prefer a concrete LDR/keyword label over a short scoring stub (e.g. Preferential). */
function refineCategoryLabel(category: string, blob: string): string {
  const cat = category.trim();
  if (!cat) return cat;
  const lower = blob.toLowerCase();
  const ldr = loadLdrAnnouncementCategories().categories;
  const keywords = listCorporateEventKeywords();

  const preferLonger = (pool: string[]): string | null => {
    let best: string | null = null;
    for (const c of pool) {
      const cl = c.toLowerCase();
      if (!cl.includes(cat.toLowerCase()) && !cat.toLowerCase().includes(cl)) {
        continue;
      }
      // Every significant token of the candidate should appear in the filing blob.
      const tokens = cl
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4 && !/^(and|with|from|under|board|meeting)$/.test(t));
      if (!tokens.length) continue;
      if (!tokens.every((t) => lower.includes(t))) continue;
      if (
        !best ||
        categoryPriors(c).base > categoryPriors(best).base ||
        (categoryPriors(c).base === categoryPriors(best).base &&
          c.length > best.length)
      ) {
        best = c;
      }
    }
    return best;
  };

  const refined =
    preferLonger(keywords) ||
    preferLonger(ldr) ||
    (/^preferential$/i.test(cat) &&
    /\ballotment\b/i.test(lower) &&
    /\bpreferential\b/i.test(lower)
      ? "Preferential Allotment"
      : null) ||
    (/^preferential$/i.test(cat) && /\bpreferential\s+issue\b/i.test(lower)
      ? "Preferential Issue"
      : null) ||
    (/^allotment$/i.test(cat) && /\bshare\b/i.test(lower)
      ? "Share Allotment"
      : null) ||
    (/^debt$/i.test(cat) && /\brepay(?:s|ed|ment|ments)?\b/i.test(lower)
      ? "Debt Repayment"
      : null) ||
    (/^repay(?:ment|s|ed)?$/i.test(cat) && /\bdebt\b/i.test(lower)
      ? "Debt Repayment"
      : null) ||
    (/^intimation$/i.test(cat) && /\bsettlement\b/i.test(lower)
      ? "Settlement"
      : null);

  return refined || cat;
}

export function resolveMarketIqCategory(
  preferred: string | null | undefined,
  text: string,
  titleHint?: string | null,
): { category: string; categories: string[] } {
  return resolveCategory(preferred, text, titleHint);
}

function resolveCategory(
  preferred: string | null | undefined,
  text: string,
  titleHint?: string | null,
): { category: string; categories: string[] } {
  const keywords = listCorporateEventKeywords();
  const keywordSet = new Set(keywords.map((k) => k.toLowerCase()));
  const ldr = loadLdrAnnouncementCategories().categories;
  const ldrSet = new Set(ldr.map((k) => k.toLowerCase()));

  const canonicalize = (raw: string): string => {
    const canonKw = keywords.find((k) => k.toLowerCase() === raw.toLowerCase());
    if (canonKw) return canonKw;
    const canonLdr = ldr.find((k) => k.toLowerCase() === raw.toLowerCase());
    if (canonLdr) return canonLdr;
    return raw;
  };

  const titleRaw = (titleHint || text.split("\n")[0] || "").trim();
  const title = stripRegBoilerplate(titleRaw) || titleRaw;
  // Lead = exchange title + early filing letter only (not deep transcript Q&A).
  const leadRaw = text.slice(0, 900);
  const lead = stripRegBoilerplate(leadRaw) || leadRaw;
  const evidenceBlob = `${titleRaw}\n${leadRaw}`;

  let fromLlm = (preferred || "").trim();
  if (fromLlm) {
    fromLlm = canonicalize(fromLlm);
    if (
      !keywordSet.has(fromLlm.toLowerCase()) &&
      !ldrSet.has(fromLlm.toLowerCase())
    ) {
      const scoring = loadScoring();
      const stub = fromLlm.toLowerCase();
      const matchedRule = scoring.category_rules.some((r) => {
        const m = r.match.toLowerCase();
        return stub.includes(m) || m.includes(stub);
      });
      if (!matchedRule || fromLlm.length < 2) fromLlm = "";
    }
    // Drop invented LLM labels (e.g. Capital Raise on a debt-repayment filing).
    if (fromLlm && !categoryHasTextEvidence(fromLlm, evidenceBlob)) {
      fromLlm = "";
    }
  }

  const fromTitleText =
    primaryCorporateEventKeyword(title) ||
    matchCorporateEventKeywords(title, { limit: 1 })[0]?.keyword ||
    categoryFromScoringText(title) ||
    "";
  const fromLeadRules =
    categoryFromScoringText(`${title}\n${lead}`) ||
    primaryCorporateEventKeyword(`${title}\n${lead}`) ||
    "";
  const bodySlice = stripRegBoilerplate(text.slice(0, 6000)) || text.slice(0, 6000);
  const fromBodyText =
    primaryCorporateEventKeyword(bodySlice) ||
    matchCorporateEventKeywords(bodySlice, { limit: 1 })[0]?.keyword ||
    "";
  const fromBodyRules = categoryFromScoringText(bodySlice);

  // Drop severe body-only labels when title is routine / already classified non-severe.
  let bodyCat = fromBodyRules || fromBodyText || "";
  const titleSevere =
    isSevereCategoryLabel(title) || isSevereCategoryLabel(fromTitleText);
  if (
    bodyCat &&
    isSevereCategoryLabel(bodyCat) &&
    !titleSevere &&
    (isRoutineDisclosureTitle(title) || Boolean(fromTitleText))
  ) {
    bodyCat = "";
  }
  // Lead-only severe hit also dropped for routine titles (e.g. risk boilerplate).
  let leadCat = fromLeadRules;
  if (
    leadCat &&
    isSevereCategoryLabel(leadCat) &&
    isRoutineDisclosureTitle(title) &&
    !isSevereCategoryLabel(title) &&
    !isSevereCategoryLabel(fromTitleText)
  ) {
    leadCat = "";
  }
  if (
    fromLlm &&
    isSevereCategoryLabel(fromLlm) &&
    isRoutineDisclosureTitle(title) &&
    !isSevereCategoryLabel(title)
  ) {
    fromLlm = "";
  }

  const candidates = [
    fromTitleText,
    leadCat,
    fromLlm,
    bodyCat,
  ].filter(Boolean) as string[];

  let category: string;
  // Routine exchange titles: keep the title tag (don't let body/LLM "Earnings" steal it)
  // — except procedural Board Meeting / AGM / EGM wrappers around capital raises etc.
  if (fromTitleText && isRoutineDisclosureTitle(title)) {
    const procedural =
      isProceduralMeetingTitle(title) ||
      isProceduralMeetingCategory(fromTitleText);
    if (procedural) {
      const substance = pickHighestBaseCategory(candidates);
      const titleBase = categoryPriors(fromTitleText).base;
      const substanceBase = categoryPriors(substance).base;
      category =
        substanceBase >= titleBase + 1.5 ? substance : fromTitleText;
    } else {
      category = fromTitleText;
    }
  } else {
    let categoryPick = candidates[0] || "Unclassified";
    let bestBase = categoryPriors(categoryPick).base;
    const titleSide = new Set(
      [fromTitleText, leadCat].filter(Boolean).map((c) => c.toLowerCase()),
    );
    for (const c of candidates.slice(1)) {
      const b = categoryPriors(c).base;
      const isTitleSide = titleSide.has(c.toLowerCase());
      const margin = isTitleSide ? 0.1 : 1.1;
      if (b > bestBase + margin) {
        categoryPick = c;
        bestBase = b;
      }
    }
    category = categoryPick;
  }
  // If title itself scores a non-severe category, keep it over a severe body label.
  if (
    fromTitleText &&
    !isSevereCategoryLabel(fromTitleText) &&
    isSevereCategoryLabel(category)
  ) {
    category = fromTitleText;
  } else if (
    leadCat &&
    !isSevereCategoryLabel(leadCat) &&
    isSevereCategoryLabel(category) &&
    !isSevereCategoryLabel(title)
  ) {
    category = leadCat;
  }

  category = refineCategoryLabel(category, `${title}\n${lead}`);

  const hits = matchCorporateEventKeywords(`${title}\n${lead}`, { limit: 6 }).filter(
    (h) =>
      !(
        isSevereCategoryLabel(h.keyword) &&
        isRoutineDisclosureTitle(titleRaw) &&
        !isSevereCategoryLabel(titleRaw)
      ),
  );
  const categories = hits.map((h) => h.keyword);
  if (leadCat && !categories.includes(leadCat)) {
    categories.unshift(leadCat);
  }
  if (category && !categories.includes(category)) categories.unshift(category);
  return { category, categories: categories.slice(0, 6) };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, 24);
}

/** Drop LLM placeholders / tokens that are not actually in the filing text. */
function sanitizeLexiconExtras(words: string[], text: string): string[] {
  const lower = text.toLowerCase();
  const noise =
    /^(none|n\.?a\.?|n\/a|nil|null|na|unknown|not\s*applicable|-|—|\.|…)$/i;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of words) {
    const w = raw.toLowerCase().trim();
    if (w.length < 3 || noise.test(w) || seen.has(w)) continue;
    if (!lower.includes(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out.slice(0, 24);
}

function mergeLlmExtract(
  lexical: MarketIqExtract,
  raw: Record<string, unknown>,
  text: string,
  sourceUrl: string | null,
  opts?: { titleHint?: string | null },
): MarketIqExtract {
  const headline =
    String(raw.headline ?? "").trim() || lexical.headline || lexicalHeadline(text);
  const summary =
    String(raw.summary ?? "").trim() || lexical.summary || lexicalSummary(text);
  // NSE subject is often "Outcome of Board Meeting" while the filing/LLM headline
  // carries the real event (preferential allotment, etc.) — use both.
  const categoryTitle = [opts?.titleHint, headline, lexical.headline]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .filter((s, i, arr) => arr.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i)
    .join("\n");
  const { category, categories } = resolveCategory(
    raw.category != null ? String(raw.category) : lexical.category,
    `${headline}\n${summary}\n${text.slice(0, 6000)}`,
    categoryTitle,
  );

  const sentimentText = `${headline}\n${summary}`;
  const scored = applyScoreFormula({
    text: `${headline}\n${summary}\n${text}`,
    sentimentText,
    category,
    extraPositive: sanitizeLexiconExtras(
      asStringArray(raw.positive_words_found),
      sentimentText,
    ),
    extraNegative: sanitizeLexiconExtras(
      asStringArray(raw.negative_words_found),
      sentimentText,
    ),
    detailSignals: asStringArray(raw.detail_signals),
    specificitySignals: asStringArray(raw.specificity_signals),
  });

  const meta = resolveCompanyMeta(
    raw.ticker != null ? String(raw.ticker) : lexical.ticker,
    raw.company != null ? String(raw.company) : lexical.company,
  );

  let announcement_date =
    (raw.announcement_date != null
      ? String(raw.announcement_date).slice(0, 10)
      : null) ||
    lexical.announcement_date ||
    dateFromNseArchiveUrl(sourceUrl);
  if (announcement_date && !/^\d{4}-\d{2}-\d{2}$/.test(announcement_date)) {
    const t = Date.parse(announcement_date);
    announcement_date = Number.isNaN(t)
      ? dateFromNseArchiveUrl(sourceUrl)
      : new Date(t).toISOString().slice(0, 10);
  }

  return {
    ticker: meta.ticker,
    company: meta.company,
    headline: headline.slice(0, 280),
    summary: summary.slice(0, 1200),
    category,
    categories,
    sentiment: scored.sentiment,
    sentiment_why:
      raw.sentiment_why != null
        ? String(raw.sentiment_why).trim().slice(0, 400) || null
        : lexical.sentiment_why,
    confidence: scored.confidence,
    impact: scored.impact,
    announcement_date,
    score_trace: scored.score_trace,
  };
}

function lexicalExtract(
  text: string,
  sourceUrl: string | null,
  hints?: { ticker?: string | null; company?: string | null; title?: string | null },
): MarketIqExtract {
  const headline =
    hints?.title?.trim() || lexicalHeadline(text) || "Corporate announcement";
  const summary = lexicalSummary(text) || headline;
  const { category, categories } = resolveCategory(
    null,
    `${headline}\n${summary}\n${text.slice(0, 6000)}`,
    headline,
  );
  const scored = applyScoreFormula({
    text: `${headline}\n${summary}\n${text}`,
    sentimentText: `${headline}\n${summary}`,
    category,
  });
  const meta = resolveCompanyMeta(
    hints?.ticker ?? null,
    hints?.company ?? null,
  );
  return {
    ticker: meta.ticker,
    company: meta.company,
    headline: headline.slice(0, 280),
    summary: summary.slice(0, 1200),
    category,
    categories,
    sentiment: scored.sentiment,
    sentiment_why: null,
    confidence: scored.confidence,
    impact: scored.impact,
    announcement_date:
      dateFromNseArchiveUrl(sourceUrl) ||
      null,
    score_trace: scored.score_trace,
  };
}

function saveAnalysed(opts: {
  source_url: string | null;
  extract: MarketIqExtract;
  engine: string;
  text_chars: number;
  replaceId?: number | null;
}): number {
  ensureHistorySchema();
  const db = openSqliteNamed(marketIqDbFile(), { wal: true });
  try {
    const screened_at = new Date().toISOString();
    if (opts.replaceId != null) {
      db.prepare(
        `UPDATE announcement_screens SET
          source_url=@source_url, ticker=@ticker, company=@company,
          headline=@headline, summary=@summary, category=@category,
          categories_json=@categories_json, sentiment=@sentiment,
          sentiment_why=@sentiment_why, impact=@impact,
          announcement_date=@announcement_date, extract_json=@extract_json,
          engine=@engine, text_chars=@text_chars, screened_at=@screened_at,
          sentiment_confidence=@sentiment_confidence
         WHERE id=@id`,
      ).run({
        id: opts.replaceId,
        source_url: opts.source_url,
        ticker: opts.extract.ticker,
        company: opts.extract.company,
        headline: opts.extract.headline,
        summary: opts.extract.summary,
        category: opts.extract.category,
        categories_json: JSON.stringify(opts.extract.categories),
        sentiment: opts.extract.sentiment,
        sentiment_why: opts.extract.sentiment_why,
        impact: opts.extract.impact,
        announcement_date: opts.extract.announcement_date,
        extract_json: JSON.stringify(opts.extract),
        engine: opts.engine,
        text_chars: opts.text_chars,
        screened_at,
        sentiment_confidence: opts.extract.confidence,
      });
      return opts.replaceId;
    }

    if (opts.source_url) {
      db.prepare(
        `DELETE FROM announcement_screens WHERE source_url = ?`,
      ).run(opts.source_url);
    }

    // Drop older duplicates of the same issuer + day + title (different PDF URLs).
    const identity = announcementDedupeKey({
      ticker: opts.extract.ticker,
      company: opts.extract.company,
      title: opts.extract.headline,
      day: opts.extract.announcement_date,
    });
    if (identity.replace(/\|/g, "")) {
      const siblings = db
        .prepare(
          `SELECT id, ticker, company, headline, announcement_date, screened_at
           FROM announcement_screens
           WHERE UPPER(COALESCE(ticker, '')) = UPPER(COALESCE(?, ''))
           ORDER BY id DESC
           LIMIT 40`,
        )
        .all(opts.extract.ticker || "") as Array<{
        id: number;
        ticker: string | null;
        company: string | null;
        headline: string;
        announcement_date: string | null;
        screened_at: string;
      }>;
      const del = db.prepare(`DELETE FROM announcement_screens WHERE id = ?`);
      for (const s of siblings) {
        const k = announcementDedupeKey({
          ticker: s.ticker,
          company: s.company,
          title: s.headline,
          day: s.announcement_date || s.screened_at,
        });
        if (k === identity) del.run(s.id);
      }
    }

    const info = db
      .prepare(
        `INSERT INTO announcement_screens (
          source_url, ticker, company, headline, summary, category, categories_json,
          sentiment, sentiment_why, impact, announcement_date, extract_json, engine,
          text_chars, screened_at, sentiment_confidence
        ) VALUES (
          @source_url, @ticker, @company, @headline, @summary, @category, @categories_json,
          @sentiment, @sentiment_why, @impact, @announcement_date, @extract_json, @engine,
          @text_chars, @screened_at, @sentiment_confidence
        )`,
      )
      .run({
        source_url: opts.source_url,
        ticker: opts.extract.ticker,
        company: opts.extract.company,
        headline: opts.extract.headline,
        summary: opts.extract.summary,
        category: opts.extract.category,
        categories_json: JSON.stringify(opts.extract.categories),
        sentiment: opts.extract.sentiment,
        sentiment_why: opts.extract.sentiment_why,
        impact: opts.extract.impact,
        announcement_date: opts.extract.announcement_date,
        extract_json: JSON.stringify(opts.extract),
        engine: opts.engine,
        text_chars: opts.text_chars,
        screened_at,
        sentiment_confidence: opts.extract.confidence,
      });
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

/**
 * PDF text only (pdf-parse / OCR) — no LLM, no DB write.
 */
export async function extractMarketIqPdf(opts: {
  url?: string | null;
  buffer?: Buffer | null;
  /** Skip vision OCR (lab Extract should stay fast). */
  skipOcr?: boolean;
}): Promise<{
  ok: boolean;
  engine: string;
  text: string;
  text_chars: number;
  text_excerpt: string;
  source_url: string | null;
  error?: string;
}> {
  const source_url = (opts.url || "").trim() || null;
  let buf = opts.buffer || null;
  let engine = "none";

  if (!buf && source_url) {
    buf = await downloadMarketIqPdf(source_url);
    engine = "download";
  }
  if (!buf) {
    return {
      ok: false,
      engine,
      text: "",
      text_chars: 0,
      text_excerpt: "",
      source_url,
      error: "Could not load PDF — check URL or upload",
    };
  }

  let text = "";
  // Always try pdf-parse first (seconds). OCR only if text is thin —
  // OCR-first was making Extract take 1–2+ minutes on every upload.
  try {
    const parsed = await extractPdfText(buf);
    if (parsed.length >= 40) {
      text = parsed;
      engine =
        engine === "download" || engine === "none"
          ? "pdf-parse"
          : "upload+pdf-parse";
    }
  } catch {
    /* keep empty → OCR fallback */
  }

  const ocrAllowed = (() => {
    const off = (process.env.MARKETIQ_OCR || "").trim().toLowerCase();
    if (["0", "false", "off", "no"].includes(off)) return false;
    return !!(process.env.QIANFAN_OCR_BASE_URL || "").trim();
  })();

  if (text.length < 120 && ocrAllowed && !opts.skipOcr) {
    try {
      const ocr = await ocrPdf(buf);
      if (ocr.length > text.length && ocr.length >= 40) {
        text = ocr;
        engine =
          engine === "pdf-parse" || engine === "upload+pdf-parse"
            ? `${engine}+vision-ocr`
            : engine === "download"
              ? "vision-ocr"
              : "upload+vision-ocr";
      }
    } catch {
      /* keep pdf-parse text if any */
    }
  }

  if (text.length < 40) {
    return {
      ok: false,
      engine,
      text,
      text_chars: text.length,
      text_excerpt: text.slice(0, 400),
      source_url,
      error:
        "Little text from PDF — try OCR (QIANFAN_OCR_BASE_URL) or another file",
    };
  }

  return {
    ok: true,
    engine,
    text,
    text_chars: text.length,
    /** Full extracted body (UI “Extract” / Copy). */
    text_excerpt: text,
    source_url,
  };
}

/**
 * Extract PDF (pdf-parse → OCR) + score sentiment/impact (formula + Mistral).
 */
export async function analyseMarketIqAnnouncement(opts: {
  url?: string | null;
  buffer?: Buffer | null;
  tickerHint?: string | null;
  companyHint?: string | null;
  titleHint?: string | null;
  announcedAt?: string | null;
  historyId?: number | null;
  /** Analyse headline-only when PDF unavailable. */
  allowHeadlineOnly?: boolean;
  skipOcr?: boolean;
}): Promise<MarketIqScreenResult> {
  const source_url = (opts.url || "").trim() || null;
  let engine = "none";
  let text = "";

  const extracted = await extractMarketIqPdf({
    url: opts.url,
    buffer: opts.buffer,
    skipOcr: opts.skipOcr === true,
  });
  engine = extracted.engine;
  text = extracted.text;

  const headlineFallback =
    opts.titleHint?.trim() ||
    (text.length >= 40 ? lexicalHeadline(text) : "");

  if (text.length < 40) {
    if (!opts.allowHeadlineOnly || !headlineFallback) {
      return {
        ok: false,
        extract: emptyExtract(),
        engine,
        text_chars: text.length,
        text_excerpt: text.slice(0, 400),
        source_url,
        error: extracted.error || "Could not load PDF — check URL or upload",
      };
    }
    text = headlineFallback;
    engine = engine === "none" ? "headline-only" : `${engine}+headline`;
  }

  let extract = lexicalExtract(text, source_url, {
    ticker: opts.tickerHint,
    company: opts.companyHint,
    title: opts.titleHint,
  });
  if (opts.announcedAt?.slice(0, 10)) {
    extract.announcement_date = opts.announcedAt.slice(0, 10);
  }

  const cfg = loadLlmConfig();
  const model = marketIqAnalyzeModel(cfg);
  const status = await checkLlmStatus({ ...cfg, llmModel: model });
  if (status.available) {
    try {
      const titleHint = (opts.titleHint || "").trim();
      const scoringHint =
        categoryFromScoringText(`${titleHint}\n${text.slice(0, 1200)}`) || "";
      const fromText = matchCorporateEventKeywords(
        `${titleHint}\n${text.slice(0, 4000)}`,
        { limit: 40 },
      ).map((h) => h.keyword);
      const ldrAll = loadLdrAnnouncementCategories().categories;
      const fromLdrRelated = ldrAll
        .filter((c) => {
          const cl = c.toLowerCase();
          return (
            (scoringHint && cl.includes(scoringHint.toLowerCase())) ||
            /\b(preferential|allotment|qip|rights issue|fund rais|share issue|warrant)\b/i.test(
              c,
            )
          );
        })
        .slice(0, 40);
      const allowed = [
        ...fromText,
        ...(scoringHint ? [scoringHint] : []),
        ...fromLdrRelated,
        ...ldrAll.slice(0, 40),
      ];
      const uniqueAllowed = [...new Set(allowed)].slice(0, 80);
      const parsed = (await completeJson(
        { ...cfg, llmModel: model },
        loadSystemPrompt(),
        [
          `ALLOWED_CATEGORIES:\n${uniqueAllowed.join("\n")}`,
          `Source URL: ${source_url || "(upload)"}`,
          `Ticker hint: ${opts.tickerHint || "(none)"}`,
          `Company hint: ${opts.companyHint || "(none)"}`,
          `Filing text (truncated):\n${text.slice(0, 16_000)}`,
        ].join("\n\n"),
        { model, skipStatusCheck: true, numPredict: 1200 },
      )) as Record<string, unknown>;
      extract = mergeLlmExtract(extract, parsed, text, source_url, {
        titleHint: opts.titleHint,
      });
      if (opts.tickerHint?.trim()) {
        extract.ticker = opts.tickerHint.trim().toUpperCase();
      }
      if (opts.companyHint?.trim()) {
        extract.company = opts.companyHint.trim();
      }
      const meta = resolveCompanyMeta(extract.ticker, extract.company);
      extract.ticker = meta.ticker;
      extract.company = meta.company;
      if (opts.announcedAt?.slice(0, 10) && !extract.announcement_date) {
        extract.announcement_date = opts.announcedAt.slice(0, 10);
      }
      engine = `${engine}+llm`;
    } catch {
      /* keep lexical formula scores */
    }
  }

  extract.funds_mentioned = matchMarketIqFundsInText(text, [
    extract.headline,
    extract.summary,
    opts.titleHint || "",
  ]);

  const id = saveAnalysed({
    source_url,
    extract,
    engine,
    text_chars: text.length,
    replaceId: opts.historyId ?? null,
  });

  return {
    ok: true,
    extract,
    engine,
    text_chars: text.length,
    text,
    text_excerpt: text,
    source_url,
    id,
  };
}

/** Analyse one live/history hit (convenience). */
export async function analyseMarketIqHit(
  hit: MarketIqHit & { historyId?: number | null },
): Promise<MarketIqScreenResult> {
  return analyseMarketIqAnnouncement({
    url: hit.url,
    tickerHint: hit.ticker,
    companyHint: hit.company,
    titleHint: hit.title,
    announcedAt: hit.announced_at,
    historyId: hit.historyId ?? null,
    allowHeadlineOnly: true,
  });
}
