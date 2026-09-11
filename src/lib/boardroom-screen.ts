/**
 * BoardRoomIQ — NSE board / director / AGM filings → governance tag + DIN extract.
 * Live feed: NSE CAME (no LotusDew). Taxonomy: data/ldr_governance_categories.json.
 */
import fs from "fs";
import path from "path";
import { announcementDedupeKey } from "./announcement-dedupe";
import { isOrderWinAnnouncementBlob } from "./bse-investor-discover";
import { extractCorporateFromPdfUrl } from "./corporate-data-extract";
import type { CorporateExtractPayload } from "./corporate-data";
import { boardRoomIqDbFile } from "./iq-dbs";
import { discoverNseMarketAnnouncements } from "./nse-investor-discover";
import { openSqliteNamed } from "./sqlite-utils";

const DATA_DIR = path.join(process.cwd(), "data");
const GOV_CATEGORIES_PATH = path.join(
  DATA_DIR,
  "ldr_governance_categories.json",
);

export type BoardRoomHit = {
  ticker: string;
  company: string | null;
  title: string;
  url: string | null;
  announced_at: string | null;
  period: string | null;
  provider: string;
  /** Lexical tag hint from title (before PDF analyse). */
  category_hint?: string | null;
};

export type BoardRoomDin = {
  name: string;
  din: string | null;
  designation: string | null;
  category: string | null;
};

export type BoardRoomExtract = {
  ticker: string | null;
  company: string | null;
  headline: string;
  proposal: string;
  category: string;
  dins: BoardRoomDin[];
  announcement_date: string | null;
};

export type BoardRoomHistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  headline: string;
  proposal: string;
  category: string;
  dins: BoardRoomDin[];
  announcement_date: string | null;
  engine: string | null;
  status: string;
  screened_at: string;
};

export type BoardRoomScreenResult = {
  ok: boolean;
  extract: BoardRoomExtract;
  engine: string;
  text_chars: number;
  source_url: string | null;
  error?: string;
  id?: number;
  status: string;
};

const BOARD_ROOM_RE =
  /\b(?:director|directors|board(?:\s+of\s+directors)?|board\s+meeting|outcome\s+of\s+(?:the\s+)?board|agm|egm|postal\s+ballot|appointment|re-?appointment|resignation|cessation|retirement|kmp|key\s+managerial|managing\s+director|independent\s+director|whole[\s-]?time\s+director|non[\s-]?executive|change\s+in\s+(?:director|management|kmp)|committee\s+(?:appointment|reconstitution)|din\b|memorandum|articles\s+of\s+association)/i;

const BOARD_ROOM_EXCLUDE_RE =
  /quarterly\s+compliance\s+report|newspaper\s+publication|credit\s+rating|buy\s*back|dividend|record\s+date|financial\s+results|investor\s+presentation|transcript|concall|earnings?\s+call/i;

/** Generic board / AGM / director filing filter (no issuer hardcodes). */
export function isBoardRoomAnnouncementBlob(blob: string): boolean {
  const t = blob.trim();
  if (!t) return false;
  if (isOrderWinAnnouncementBlob(t)) return false;
  if (BOARD_ROOM_EXCLUDE_RE.test(t) && !BOARD_ROOM_RE.test(t)) return false;
  if (
    BOARD_ROOM_EXCLUDE_RE.test(t) &&
    /financial\s+results|transcript|investor\s+presentation|concall/i.test(t)
  ) {
    return false;
  }
  return BOARD_ROOM_RE.test(t);
}

let govCatCache: { categories: string[]; total: number } | null = null;

/** Scraped governance taxonomy (labels only — not a live LDR feed). */
export function loadLdrGovernanceCategories(): {
  categories: string[];
  total: number;
  path: string;
} {
  if (govCatCache) {
    return { ...govCatCache, path: GOV_CATEGORIES_PATH };
  }
  try {
    const raw = JSON.parse(
      fs.readFileSync(GOV_CATEGORIES_PATH, "utf8"),
    ) as { categories?: string[]; total?: number };
    const categories = (raw.categories || [])
      .map((c) => String(c || "").trim())
      .filter(Boolean);
    govCatCache = {
      categories,
      total: raw.total ?? categories.length,
    };
    return { ...govCatCache, path: GOV_CATEGORIES_PATH };
  } catch {
    govCatCache = { categories: [], total: 0 };
    return { ...govCatCache, path: GOV_CATEGORIES_PATH };
  }
}

/**
 * Lexical match of title+text against scraped governance tags.
 * Prefers longer / more specific tags on ties; action-word aware.
 */
export function classifyGovernanceTag(
  title: string,
  text = "",
): { category: string; score: number } {
  const hay = `${title}\n${text}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cats = loadLdrGovernanceCategories().categories;
  let best = { category: "Unclassified", score: 0 };
  for (const cat of cats) {
    const full = cat
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!full) continue;
    const tokens = full.split(" ").filter((t) => t.length > 2);
    if (!tokens.length) continue;
    const hits = tokens.filter((t) => {
      const re = new RegExp(`(?:^|\\s)${t}(?:\\s|$)`);
      return re.test(hay);
    }).length;
    let score = hits / tokens.length;
    if (hay.includes(full)) score += 0.55;
    score += Math.min(0.15, tokens.length * 0.02);

    // Action / polarity guards (generic, not issuer-specific)
    const hayResign = /\bresign|\bcessation|\bretir/.test(hay);
    const catResign = /\bresign|\bcessation|\bretir|\bremoval/.test(full);
    const hayReappoint = /\bre appoint|\breappoint/.test(hay);
    const catReappoint = /\bre appoint|\breappoint/.test(full);
    const hayAppoint =
      /\bappoint/.test(hay) && !hayReappoint && !hayResign;
    const catAppoint =
      /\bappoint/.test(full) && !catReappoint && !catResign;
    if (hayResign && catAppoint) score -= 0.55;
    if (hayResign && catReappoint) score -= 0.45;
    if (hayResign && catResign) score += 0.35;
    if (hayReappoint && catReappoint) score += 0.35;
    if (hayReappoint && catAppoint && !catReappoint) score -= 0.25;
    if (hayAppoint && catResign) score -= 0.45;

    const hayNonInd = /\bnon independent\b/.test(hay);
    const catInd =
      /\bindependent\b/.test(full) && !/\bnon independent\b/.test(full);
    if (hayNonInd && catInd) score -= 0.45;

    const hayNonExec = /\bnon executive\b/.test(hay);
    const catExec =
      /\bexecutive\b/.test(full) && !/\bnon executive\b/.test(full);
    if (hayNonExec && catExec) score -= 0.45;

    // Taxonomy has Removal / Retirement, not Resignation
    if (hayResign && /\bremoval\b/.test(full)) score += 0.4;
    if (hayResign && /\bretirement\b/.test(full) && !/\bretir/.test(hay)) {
      score -= 0.2;
    }

    if (
      score > best.score ||
      (Math.abs(score - best.score) < 0.02 &&
        cat.length > best.category.length)
    ) {
      best = { category: cat, score };
    }
  }
  return best.score >= 0.55
    ? best
    : { category: "Unclassified", score: best.score };
}

function emptyExtract(partial?: Partial<BoardRoomExtract>): BoardRoomExtract {
  return {
    ticker: null,
    company: null,
    headline: "",
    proposal: "",
    category: "Unclassified",
    dins: [],
    announcement_date: null,
    ...partial,
  };
}

function ensureSchema(): void {
  const db = openSqliteNamed(boardRoomIqDbFile(), { wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS boardroom_screens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_url TEXT,
        ticker TEXT,
        company TEXT,
        headline TEXT NOT NULL,
        proposal TEXT,
        category TEXT NOT NULL DEFAULT 'Unclassified',
        dins_json TEXT,
        announcement_date TEXT,
        extract_json TEXT,
        engine TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        screened_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_boardroom_screens_at
        ON boardroom_screens(screened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_boardroom_screens_url
        ON boardroom_screens(source_url);
    `);
  } finally {
    db.close();
  }
}

function parseDins(raw: string | null | undefined): BoardRoomDin[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((d) => {
        const o = d as Record<string, unknown>;
        return {
          name: String(o.name || "").trim() || "—",
          din: o.din != null ? String(o.din).trim() : null,
          designation:
            o.designation != null ? String(o.designation).trim() : null,
          category: o.category != null ? String(o.category).trim() : null,
        };
      })
      .filter((d) => d.name !== "—" || d.din);
  } catch {
    return [];
  }
}

function dinsFromCorporate(payload: CorporateExtractPayload): BoardRoomDin[] {
  const out: BoardRoomDin[] = [];
  for (const d of payload.directors || []) {
    out.push({
      name: String(d.name || "").trim() || "—",
      din: d.din != null ? String(d.din).trim() : null,
      designation:
        d.designation != null ? String(d.designation).trim() : null,
      category: d.category != null ? String(d.category).trim() : null,
    });
  }
  for (const k of payload.kmp || []) {
    const name = String(k.name || "").trim();
    if (!name) continue;
    out.push({
      name,
      din: k.din != null ? String(k.din).trim() : null,
      designation: k.role != null ? String(k.role).trim() : null,
      category: "KMP",
    });
  }
  return out;
}

function proposalFromText(title: string, text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // Prefer a RESOLVED THAT / ITEM NO block snippet
  const m =
    flat.match(
      /(?:ITEM\s*NO\.?\s*\d+[^\n]{0,40}|RESOLVED\s+THAT)(.{40,320})/i,
    ) ||
    flat.match(
      /(?:appoint(?:ment)?|re-?appoint(?:ment)?|resign(?:ation)?|cessation).{20,280}/i,
    );
  if (m) {
    const snip = (m[0] || "").replace(/\s+/g, " ").trim();
    return snip.slice(0, 420);
  }
  if (title.trim()) return title.trim().slice(0, 420);
  return flat.slice(0, 280);
}

export async function discoverBoardRoomAnnounced(
  daysBack = 1,
  opts?: { q?: string | null },
): Promise<{
  ok: true;
  days: number;
  count: number;
  tickers: string[];
  sources: BoardRoomHit[];
  note?: string;
}> {
  const days = Math.min(7, Math.max(1, daysBack));
  const raw = await discoverNseMarketAnnouncements(days, { q: opts?.q });
  const seen = new Set<string>();
  const sources: BoardRoomHit[] = [];
  for (const h of raw) {
    const blob = `${h.title}`;
    if (!isBoardRoomAnnouncementBlob(blob)) continue;
    const key = announcementDedupeKey({
      ticker: h.ticker,
      company: h.company,
      title: h.title,
      day: h.announced_at,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    const hint = classifyGovernanceTag(h.title).category;
    sources.push({
      ticker: h.ticker,
      company: h.company,
      title: h.title,
      url: h.url,
      announced_at: h.announced_at,
      period: h.period,
      provider: h.provider,
      category_hint: hint === "Unclassified" ? null : hint,
    });
  }
  sources.sort((a, b) => {
    const at = a.announced_at ? Date.parse(a.announced_at) : 0;
    const bt = b.announced_at ? Date.parse(b.announced_at) : 0;
    return bt - at;
  });
  return {
    ok: true,
    days,
    count: sources.length,
    tickers: [
      ...new Set(sources.map((s) => s.ticker).filter(Boolean)),
    ].sort(),
    sources,
    note: sources.length
      ? undefined
      : `No board / director / AGM PDFs in the last ${days} day(s)`,
  };
}

export function saveBoardRoomHits(hits: BoardRoomHit[]): number {
  ensureSchema();
  const db = openSqliteNamed(boardRoomIqDbFile(), { wal: true });
  try {
    const at = new Date().toISOString();
    const ins = db.prepare(`
      INSERT INTO boardroom_screens (
        source_url, ticker, company, headline, proposal, category,
        dins_json, announcement_date, extract_json, engine, status, screened_at
      ) VALUES (
        @source_url, @ticker, @company, @headline, @proposal, @category,
        @dins_json, @announcement_date, @extract_json, @engine, @status, @screened_at
      )
    `);
    let n = 0;
    const tx = db.transaction(() => {
      for (const h of hits) {
        const url = h.url?.trim() || null;
        if (url) {
          const exists = db
            .prepare(
              `SELECT id FROM boardroom_screens WHERE source_url = ? LIMIT 1`,
            )
            .get(url) as { id: number } | undefined;
          if (exists) continue;
        }
        const cat =
          h.category_hint ||
          classifyGovernanceTag(h.title).category ||
          "Unclassified";
        ins.run({
          source_url: url,
          ticker: h.ticker,
          company: h.company,
          headline: h.title || "Board filing",
          proposal: h.title || "",
          category: cat,
          dins_json: "[]",
          announcement_date: h.announced_at
            ? h.announced_at.slice(0, 10)
            : null,
          extract_json: JSON.stringify({ pending: true }),
          engine: "nse-came-fetch",
          status: "pending",
          screened_at: at,
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

export function listBoardRoomHistory(limit = 40): BoardRoomHistoryRow[] {
  ensureSchema();
  const db = openSqliteNamed(boardRoomIqDbFile(), {
    readonly: true,
    wal: true,
  });
  try {
    const rows = db
      .prepare(
        `SELECT id, source_url, ticker, company, headline, proposal, category,
                dins_json, announcement_date, engine, status, screened_at
         FROM boardroom_screens
         ORDER BY screened_at DESC
         LIMIT ?`,
      )
      .all(Math.min(400, Math.max(1, limit * 3))) as Array<{
      id: number;
      source_url: string | null;
      ticker: string | null;
      company: string | null;
      headline: string;
      proposal: string | null;
      category: string;
      dins_json: string | null;
      announcement_date: string | null;
      engine: string | null;
      status: string;
      screened_at: string;
    }>;

    const byKey = new Map<string, BoardRoomHistoryRow>();
    const rank = (r: BoardRoomHistoryRow) => {
      let s = 0;
      if (r.status !== "pending") s += 30;
      if (r.dins.some((d) => d.din)) s += 20;
      if (r.category && r.category !== "Unclassified") s += 5;
      return s;
    };
    for (const r of rows) {
      const mapped: BoardRoomHistoryRow = {
        id: r.id,
        source_url: r.source_url,
        ticker: r.ticker,
        company: r.company,
        headline: r.headline,
        proposal: r.proposal || r.headline,
        category: r.category || "Unclassified",
        dins: parseDins(r.dins_json),
        announcement_date: r.announcement_date,
        engine: r.engine,
        status: r.status || "pending",
        screened_at: r.screened_at,
      };
      const key = announcementDedupeKey({
        ticker: mapped.ticker,
        company: mapped.company,
        title: mapped.headline,
        day: mapped.announcement_date || mapped.screened_at,
      });
      const prev = byKey.get(key);
      if (
        !prev ||
        rank(mapped) > rank(prev) ||
        (rank(mapped) === rank(prev) && mapped.id > prev.id)
      ) {
        byKey.set(key, mapped);
      }
    }
    return [...byKey.values()]
      .sort((a, b) => {
        const at = Date.parse(a.screened_at || a.announcement_date || "") || 0;
        const bt = Date.parse(b.screened_at || b.announcement_date || "") || 0;
        return bt - at;
      })
      .slice(0, limit);
  } finally {
    db.close();
  }
}

/** Every PDF URL already screened (any non-pending status) — Scan skips these. */
export function listScreenedBoardRoomUrls(): Set<string> {
  ensureSchema();
  const db = openSqliteNamed(boardRoomIqDbFile(), {
    readonly: true,
    wal: true,
  });
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT source_url AS u
         FROM boardroom_screens
         WHERE source_url IS NOT NULL
           AND TRIM(source_url) != ''
           AND lower(COALESCE(status, 'pending')) != 'pending'`,
      )
      .all() as Array<{ u: string }>;
    return new Set(rows.map((r) => r.u.trim()).filter(Boolean));
  } finally {
    db.close();
  }
}

function saveAnalysed(opts: {
  source_url: string | null;
  extract: BoardRoomExtract;
  engine: string;
  status: string;
  corporate?: CorporateExtractPayload | null;
  replaceId?: number | null;
}): number {
  ensureSchema();
  const db = openSqliteNamed(boardRoomIqDbFile(), { wal: true });
  try {
    const at = new Date().toISOString();
    const dinsJson = JSON.stringify(opts.extract.dins);
    const extractJson = JSON.stringify({
      ...opts.extract,
      corporate: opts.corporate || null,
    });

    if (opts.replaceId != null) {
      db.prepare(
        `UPDATE boardroom_screens SET
          source_url=?, ticker=?, company=?, headline=?, proposal=?, category=?,
          dins_json=?, announcement_date=?, extract_json=?, engine=?, status=?, screened_at=?
         WHERE id=?`,
      ).run(
        opts.source_url,
        opts.extract.ticker,
        opts.extract.company,
        opts.extract.headline,
        opts.extract.proposal,
        opts.extract.category,
        dinsJson,
        opts.extract.announcement_date,
        extractJson,
        opts.engine,
        opts.status,
        at,
        opts.replaceId,
      );
      return opts.replaceId;
    }

    if (opts.source_url) {
      db.prepare(`DELETE FROM boardroom_screens WHERE source_url = ?`).run(
        opts.source_url,
      );
    }

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
           FROM boardroom_screens
           WHERE UPPER(COALESCE(ticker, '')) = UPPER(COALESCE(?, ''))
           ORDER BY id DESC LIMIT 40`,
        )
        .all(opts.extract.ticker || "") as Array<{
        id: number;
        ticker: string | null;
        company: string | null;
        headline: string;
        announcement_date: string | null;
        screened_at: string;
      }>;
      const del = db.prepare(`DELETE FROM boardroom_screens WHERE id = ?`);
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
        `INSERT INTO boardroom_screens (
          source_url, ticker, company, headline, proposal, category,
          dins_json, announcement_date, extract_json, engine, status, screened_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        opts.source_url,
        opts.extract.ticker,
        opts.extract.company,
        opts.extract.headline,
        opts.extract.proposal,
        opts.extract.category,
        dinsJson,
        opts.extract.announcement_date,
        extractJson,
        opts.engine,
        opts.status,
        at,
      );
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

export async function analyseBoardRoomAnnouncement(opts: {
  url?: string | null;
  ticker?: string | null;
  company?: string | null;
  title?: string | null;
  announced_at?: string | null;
  historyId?: number | null;
}): Promise<BoardRoomScreenResult> {
  const url = opts.url?.trim() || null;
  const title = (opts.title || "").trim() || "Board filing";
  if (!url) {
    return {
      ok: false,
      extract: emptyExtract({
        ticker: opts.ticker || null,
        company: opts.company || null,
        headline: title,
        proposal: title,
      }),
      engine: "none",
      text_chars: 0,
      source_url: null,
      status: "no_url",
      error: "Provide a PDF URL",
    };
  }

  // Already analysed & saved — do not re-run PDF extract
  if (opts.historyId == null && listScreenedBoardRoomUrls().has(url)) {
    ensureSchema();
    const db = openSqliteNamed(boardRoomIqDbFile(), {
      readonly: true,
      wal: true,
    });
    try {
      const row = db
        .prepare(
          `SELECT id, ticker, company, headline, proposal, category, dins_json,
                  announcement_date, engine, status
           FROM boardroom_screens
           WHERE source_url = ?
             AND lower(COALESCE(status, 'pending')) != 'pending'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(url) as
        | {
            id: number;
            ticker: string | null;
            company: string | null;
            headline: string;
            proposal: string | null;
            category: string;
            dins_json: string | null;
            announcement_date: string | null;
            engine: string | null;
            status: string;
          }
        | undefined;
      if (row) {
        return {
          ok: true,
          extract: emptyExtract({
            ticker: row.ticker,
            company: row.company,
            headline: row.headline,
            proposal: row.proposal || row.headline,
            category: row.category,
            dins: parseDins(row.dins_json),
            announcement_date: row.announcement_date,
          }),
          engine: row.engine || "cache",
          text_chars: 0,
          source_url: url,
          status: row.status || "ok",
          id: row.id,
        };
      }
    } finally {
      db.close();
    }
  }

  const corp = await extractCorporateFromPdfUrl(url);
  const dins = corp.ok ? dinsFromCorporate(corp.extracted) : [];
  // Corporate extract doesn't always return full text — use title + DIN names for tag
  const tagHay = [
    title,
    ...dins.map((d) => `${d.name} ${d.designation || ""} ${d.category || ""}`),
  ].join("\n");
  const tagged = classifyGovernanceTag(title, tagHay);
  const company = opts.company || null;
  const extract = emptyExtract({
    ticker: opts.ticker || null,
    company,
    headline: title,
    proposal: proposalFromText(title, tagHay),
    category: tagged.category,
    dins,
    announcement_date: opts.announced_at
      ? opts.announced_at.slice(0, 10)
      : null,
  });

  // Enrich proposal when we have director lines
  if (dins.length) {
    const people = dins
      .map((d) => {
        const din = d.din ? ` (DIN ${d.din})` : "";
        const role = d.designation ? `, ${d.designation}` : "";
        return `${d.name}${din}${role}`;
      })
      .slice(0, 6)
      .join("; ");
    extract.proposal = `${tagged.category}: ${people}`.slice(0, 420);
  }

  const status =
    !corp.ok
      ? corp.status || "extract_failed"
      : dins.some((d) => d.din)
        ? "ok"
        : dins.length
          ? "names_no_din"
          : "empty_extract";

  const id = saveAnalysed({
    source_url: url,
    extract,
    engine: corp.engine || "pdf",
    status,
    corporate: corp.extracted,
    replaceId: opts.historyId ?? null,
  });

  return {
    ok: corp.ok || dins.length > 0,
    extract,
    engine: corp.engine || "pdf",
    text_chars: corp.text_chars || 0,
    source_url: url,
    status,
    id,
    error: corp.ok ? undefined : corp.error,
  };
}

export async function scanBoardRoomAnnouncements(opts: {
  days?: number;
  q?: string | null;
  limit?: number;
  pendingOnly?: boolean;
  sources?: BoardRoomHit[] | null;
}): Promise<{
  ok: true;
  days: number;
  total_candidates: number;
  attempted: number;
  analysed: number;
  failed: number;
  skipped: number;
  remaining: number;
  results: BoardRoomScreenResult[];
  history: BoardRoomHistoryRow[];
  attempted_urls: string[];
  note?: string;
}> {
  const days = Math.min(7, Math.max(1, opts.days ?? 1));
  const limit = Math.min(12, Math.max(1, opts.limit ?? 3));
  const screened = listScreenedBoardRoomUrls();

  let sources = opts.sources?.length
    ? opts.sources
    : (await discoverBoardRoomAnnounced(days, { q: opts.q })).sources;

  let skipped = 0;
  if (opts.pendingOnly !== false) {
    const before = sources.length;
    sources = sources.filter((s) => {
      const u = s.url?.trim();
      if (!u) return true;
      if (screened.has(u)) {
        skipped += 1;
        return false;
      }
      return true;
    });
    if (skipped === 0 && before) skipped = before - sources.length;
  }

  const batch = sources.slice(0, limit);
  const results: BoardRoomScreenResult[] = [];
  let analysed = 0;
  let failed = 0;

  for (const s of batch) {
    try {
      const r = await analyseBoardRoomAnnouncement({
        url: s.url,
        ticker: s.ticker,
        company: s.company,
        title: s.title,
        announced_at: s.announced_at,
      });
      results.push(r);
      // Completed screen (saved) counts as analysed; hard fail only when nothing useful saved
      if (r.id != null || r.ok || r.status === "empty_extract" || r.status === "names_no_din") {
        analysed += 1;
      } else {
        failed += 1;
      }
    } catch (e) {
      failed += 1;
      results.push({
        ok: false,
        extract: {
          ticker: s.ticker,
          company: s.company,
          headline: s.title,
          proposal: s.title,
          category: "Unclassified",
          dins: [],
          announcement_date: s.announced_at
            ? s.announced_at.slice(0, 10)
            : null,
        },
        engine: "none",
        text_chars: 0,
        source_url: s.url,
        status: "scan_error",
        error: e instanceof Error ? e.message : "Analyse threw",
      });
    }
  }

  return {
    ok: true,
    days,
    total_candidates: sources.length + skipped,
    attempted: batch.length,
    analysed,
    failed,
    skipped,
    remaining: Math.max(0, sources.length - batch.length),
    results,
    history: listBoardRoomHistory(200),
    attempted_urls: batch.map((s) => s.url?.trim() || "").filter(Boolean),
    note: `Taxonomy ${loadLdrGovernanceCategories().total} governance tags · skips ${screened.size} analysed PDF(s)`,
  };
}
