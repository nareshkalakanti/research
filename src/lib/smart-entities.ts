import { completeJson } from "./llm-client";
import { loadLlmConfig } from "./llm-config";
import { withStakeDb } from "./nse-holders";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Investor entity model: each tracked investor → every name they file under
 * (funds, family members, investment companies). Lives in data/smart_money.db.
 *
 *   investors          id, label, note, Trendlyne portfolio (optional)
 *   investor_entities  investor → name (exact) or pattern (regex), with status:
 *                      confirmed (counts), suggested (waiting for you), rejected
 *
 * Suggestions come from a small model: candidate names that share a distinctive
 * word with the investor, or keep turning up in the same companies, are scored
 * and then judged by the LLM. Nothing counts until you confirm it.
 */

export type Investor = {
  id: string;
  label: string;
  note: string | null;
  tl_portfolio_id: string | null;
  tl_slug: string | null;
  sort: number;
};

export type EntityStatus = "confirmed" | "suggested" | "rejected";

export type Entity = {
  id: number;
  investor_id: string;
  name: string;
  match_type: "exact" | "pattern";
  kind: string | null;
  status: EntityStatus;
  source: string;
  reason: string | null;
  evidence: number | null;
  /** Companies this name holds 1%+ of in the filings read so far. */
  holds?: number;
};

/** Starting set — the names and patterns worked out by hand. */
const SEED: Array<{
  id: string;
  label: string;
  note?: string;
  tl?: [string, string];
  patterns: Array<[string, string]>;
}> = [
  {
    id: "niveshaay",
    label: "Niveshaay",
    note: "Funds: Value, Hedgehogs, Sambhav",
    patterns: [
      ["NIVESHA+YA?\\b", "fund"],
      ["HEDGEHOGS?\\s+FUND", "fund"],
      ["SAMBHAV\\s+(FUND|AIF|SCHEME|TRUST\\s+FUND)", "fund"],
    ],
  },
  { id: "negen", label: "Negen Capital", patterns: [["\\bNEGEN\\b", "fund"]] },
  {
    id: "lucky",
    label: "Lucky Investment Managers",
    note: "Ashish Kacholia's investment company",
    patterns: [["LUCKY\\s+INVESTMENT\\s+MANAGERS", "company"]],
  },
  {
    id: "kacholia",
    label: "Ashish Kacholia",
    tl: ["53746", "ashish-kacholia-portfolio"],
    patterns: [
      ["ASHISH\\s+(RAMCHANDRA\\s+)?KACHOLIA", "self"],
      ["RASHMI\\s+(ASHISH\\s+)?KACHOLIA", "family"],
      ["BENGAL\\s+FINANCE\\s*(AND|&)\\s*INVESTMENT", "company"],
      ["SURYAVANSHI\\s+COMMOTRADE", "company"],
    ],
  },
  {
    id: "kela",
    label: "Madhusudan Kela",
    tl: ["584325", "madhusudan-kela-portfolio"],
    patterns: [
      ["MADHUSUDAN\\s+(MURLIDHAR\\s+)?KELA", "self"],
      ["MADHURI\\s+(MADHUSUDAN\\s+)?KELA", "family"],
      ["MAHI\\s+MADHUSUDAN\\s+KELA", "family"],
      ["SINGULARITY\\s+(EQUITY|HOLDINGS)", "fund"],
    ],
  },
  {
    id: "dolly",
    label: "Dolly Khanna",
    tl: ["53757", "dolly-khanna-portfolio"],
    patterns: [["DOLLY\\s+KHANNA", "self"]],
  },
];

/** Upper case, "&" → AND, no punctuation, PRIVATE LIMITED → PVT LTD. */
export function nameKey(s: string): string {
  return s
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\bPRIVATE\b/g, "PVT")
    .replace(/\bLIMITED\b/g, "LTD")
    .replace(/\s+/g, " ")
    .trim();
}

export function withEntityDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("smart_money.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS investors (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      note TEXT,
      tl_portfolio_id TEXT,
      tl_slug TEXT,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS investor_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investor_id TEXT NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'exact',
      kind TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT,
      evidence INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE (investor_id, name_key, match_type)
    );`);
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM investors`).get() as { n: number }).n;
    if (!n) seed(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function seed(db: ReturnType<typeof openSqliteNamed>): void {
  const now = new Date().toISOString();
  const insI = db.prepare(
    `INSERT OR IGNORE INTO investors (id, label, note, tl_portfolio_id, tl_slug, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insE = db.prepare(
    `INSERT OR IGNORE INTO investor_entities (investor_id, name, name_key, match_type, kind, status, source, created_at)
     VALUES (?, ?, ?, ?, ?, 'confirmed', 'seed', ?)`,
  );
  db.transaction(() => {
    SEED.forEach((s, i) => {
      insI.run(s.id, s.label, s.note ?? null, s.tl?.[0] ?? null, s.tl?.[1] ?? null, i, now);
      for (const [p, kind] of s.patterns) insE.run(s.id, p, p, "pattern", kind, now);
    });
  })();
}

export function loadInvestors(): Investor[] {
  return withEntityDb(
    (db) => db.prepare(`SELECT id, label, note, tl_portfolio_id, tl_slug, sort FROM investors ORDER BY sort, label`).all() as Investor[],
  );
}

export function loadEntities(): Entity[] {
  return withEntityDb(
    (db) =>
      db
        .prepare(
          `SELECT id, investor_id, name, match_type, kind, status, source, reason, evidence FROM investor_entities
           ORDER BY investor_id, status, name`,
        )
        .all() as Entity[],
  );
}

export type Matcher = (holder: string) => string | null;

/** Holder name → investor id, from confirmed entities only. */
export function buildMatcher(entities: Entity[] = loadEntities()): Matcher {
  const exact = new Map<string, string>();
  const patterns: Array<[RegExp, string]> = [];
  for (const e of entities) {
    if (e.status !== "confirmed") continue;
    if (e.match_type === "pattern") {
      try {
        patterns.push([new RegExp(e.name, "i"), e.investor_id]);
      } catch {
        /* bad pattern: skip */
      }
    } else exact.set(nameKey(e.name), e.investor_id);
  }
  return (holder: string) => {
    const k = nameKey(holder);
    const hit = exact.get(k);
    if (hit) return hit;
    for (const [re, id] of patterns) if (re.test(holder) || re.test(k)) return id;
    return null;
  };
}

// ---- Edits --------------------------------------------------------------------

export function addInvestor(label: string, note?: string | null): Investor {
  const clean = label.trim().replace(/\s+/g, " ");
  if (clean.length < 2) throw new Error("Name is too short");
  const id = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || `inv-${Date.now()}`;
  return withEntityDb((db) => {
    const sort = (db.prepare(`SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM investors`).get() as { s: number }).s;
    db.prepare(
      `INSERT INTO investors (id, label, note, sort, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label`,
    ).run(id, clean, note ?? null, sort, new Date().toISOString());
    // Their own name is the first entity.
    db.prepare(
      `INSERT OR IGNORE INTO investor_entities (investor_id, name, name_key, match_type, kind, status, source, created_at)
       VALUES (?, ?, ?, 'exact', 'self', 'confirmed', 'user', ?)`,
    ).run(id, clean.toUpperCase(), nameKey(clean), new Date().toISOString());
    return db.prepare(`SELECT id, label, note, tl_portfolio_id, tl_slug, sort FROM investors WHERE id = ?`).get(id) as Investor;
  });
}

export function addEntity(investorId: string, name: string, kind?: string | null): void {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.length < 3) throw new Error("Name is too short");
  withEntityDb((db) => {
    db.prepare(
      `INSERT INTO investor_entities (investor_id, name, name_key, match_type, kind, status, source, created_at)
       VALUES (?, ?, ?, 'exact', ?, 'confirmed', 'user', ?)
       ON CONFLICT(investor_id, name_key, match_type) DO UPDATE SET status = 'confirmed', source = 'user'`,
    ).run(investorId, clean, nameKey(clean), kind ?? null, new Date().toISOString());
  });
}

/** Drop the model's unconfirmed verdicts (suggested and rejected) so it can look again. */
export function clearSuggestions(investorId?: string): number {
  return withEntityDb((db) => {
    const sql = `DELETE FROM investor_entities WHERE source = 'llm' AND status != 'confirmed'${investorId ? " AND investor_id = ?" : ""}`;
    return (investorId ? db.prepare(sql).run(investorId) : db.prepare(sql).run()).changes;
  });
}

export function setEntityStatus(id: number, status: EntityStatus | "delete"): void {
  withEntityDb((db) => {
    if (status === "delete") db.prepare(`DELETE FROM investor_entities WHERE id = ?`).run(id);
    else db.prepare(`UPDATE investor_entities SET status = ? WHERE id = ?`).run(status, id);
  });
}

// ---- Suggestions (the model) ------------------------------------------------------

/** Words too common to tie a name to an investor. */
const STOP = new Set(
  `FUND FUNDS LTD PVT LIMITED PRIVATE INVESTMENT INVESTMENTS CAPITAL MANAGERS MANAGEMENT ASSET ASSETS
   TRUST TRUSTEE AND OF THE INDIA INDIAN HOLDINGS HOLDING VALUE GROWTH EQUITY OPPORTUNITIES SCHEME AIF
   LLP COMPANY CO FINANCE FINANCIAL SECURITIES ADVISORS PORTFOLIO PARTNERS SERVICES ENTERPRISES HUF
   KARTA BEING MR MRS MS SHRI SMT A C I II III IV`.split(/\s+/),
);

function tokens(s: string): string[] {
  return nameKey(s)
    .split(" ")
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

type Holding = { symbol: string; holder: string; category: string | null };

/** A word in more holder names than this is too common to identify anyone. */
const MAX_WORD_NAMES = 25;

export type Candidate = {
  name: string;
  holds: number;
  shared: number;
  word: string | null;
  score: number;
  examples: string[];
};

/** Candidate names for one investor, best first (not yet judged). */
export function findCandidates(investorId: string, limit = 15): Candidate[] {
  const entities = loadEntities();
  const match = buildMatcher(entities);
  const mine = entities.filter((e) => e.investor_id === investorId);
  const known = new Set(mine.map((e) => nameKey(e.name)));
  const inv = loadInvestors().find((i) => i.id === investorId);
  // Distinctive words: from the investor's label and confirmed exact names.
  const words = new Set<string>([
    ...tokens(inv?.label ?? ""),
    ...mine.filter((e) => e.status === "confirmed" && e.match_type === "exact").flatMap((e) => tokens(e.name)),
  ]);
  // Words inside patterns (e.g. KACHOLIA, NIVESHAAY) count too.
  for (const e of mine)
    if (e.match_type === "pattern") for (const w of e.name.toUpperCase().match(/[A-Z]{4,}/g) ?? []) if (!STOP.has(w)) words.add(w);

  const rows = withStakeDb(
    (db) =>
      db
        .prepare(
          `SELECT h.symbol AS symbol, h.holder AS holder, h.category AS category FROM holder_stakes h
           JOIN holder_scan s ON s.symbol = h.symbol AND s.quarter = h.quarter`,
        )
        .all() as Holding[],
    true,
  );
  const holdsOf = new Map<string, Set<string>>();
  const display = new Map<string, string>();
  const investorSyms = new Set<string>();
  const promoter = new Set<string>();
  for (const r of rows) {
    const k = nameKey(r.holder);
    // Promoters co-hold their own group's companies — never an investor's entity.
    if (/promoter/i.test(r.category ?? "")) promoter.add(k);
    if (!holdsOf.has(k)) holdsOf.set(k, new Set());
    holdsOf.get(k)!.add(r.symbol);
    if (!display.has(k)) display.set(k, r.holder);
    if (match(r.holder) === investorId) investorSyms.add(r.symbol);
  }
  // Only rare words tie a name to an investor: KACHOLIA yes, ASHISH (hundreds of holders) no.
  const df = new Map<string, number>();
  for (const k of holdsOf.keys()) for (const w of new Set(tokens(k))) df.set(w, (df.get(w) ?? 0) + 1);
  for (const w of [...words]) if ((df.get(w) ?? 0) > MAX_WORD_NAMES) words.delete(w);
  const rejected = new Set(mine.filter((e) => e.status === "rejected").map((e) => nameKey(e.name)));
  const out: Candidate[] = [];
  for (const [k, syms] of holdsOf) {
    if (known.has(k) || rejected.has(k) || promoter.has(k)) continue;
    if (match(display.get(k)!) != null) continue; // already someone's
    // Big institutions sit in hundreds of companies: co-holding means nothing there.
    if (syms.size > 40) continue;
    const word = tokens(k).find((w) => words.has(w)) ?? null;
    const shared = [...syms].filter((s) => investorSyms.has(s));
    const ratio = shared.length / syms.size;
    // Without a shared rare word, it must keep turning up next to the investor.
    if (!word && (shared.length < 3 || ratio < 0.3)) continue;
    const score = (word ? 50 : 0) + Math.min(30, shared.length * 10) + Math.round(ratio * 20);
    out.push({
      name: display.get(k)!,
      holds: syms.size,
      shared: shared.length,
      word,
      score,
      examples: shared.slice(0, 4),
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

type Verdict = { i?: number; name?: string; belongs: "yes" | "no" | "unsure"; kind?: string; reason?: string };

/**
 * Score candidates and ask the LLM which belong to this investor.
 * "yes" / "unsure" → suggested (you confirm), "no" → rejected (not asked again).
 */
export async function suggestEntities(
  investorId: string,
): Promise<{ asked: number; suggested: number; rejected: number; unread?: number; sample?: string }> {
  const inv = loadInvestors().find((i) => i.id === investorId);
  if (!inv) throw new Error("Unknown investor");
  const cands = findCandidates(investorId);
  if (!cands.length) return { asked: 0, suggested: 0, rejected: 0 };
  const known = loadEntities()
    .filter((e) => e.investor_id === investorId && e.status === "confirmed")
    .map((e) => (e.match_type === "pattern" ? `pattern /${e.name}/` : e.name));

  const system =
    "You match shareholder names from Indian stock-exchange shareholding filings to a known investor. " +
    "An investor files under their own name, family members (spouse, children, HUF), their investment companies, " +
    "and their funds (AIFs, PMS). Say yes only when the name clearly belongs to this investor; " +
    "say no for unrelated people who merely share a surname or first name, or for other fund houses; " +
    "say unsure when evidence is mixed. A shared common first name (Ashish, Rashmi, Ramesh…) is NOT evidence; " +
    "a shared rare surname or fund name, or repeatedly holding the same small companies, is. Reply as JSON.";
  const user = JSON.stringify({
    investor: inv.label,
    note: inv.note,
    known_names: known,
    candidates: cands.map((c, i) => ({
      i,
      name: c.name,
      shared_word: c.word,
      companies_held: c.holds,
      companies_also_held_by_investor: c.shared,
      examples: c.examples,
    })),
    reply_format: {
      verdicts: [{ i: "candidate number", name: "candidate name", belongs: "yes|no|unsure", kind: "self|family|company|fund|other", reason: "short" }],
    },
    instruction: "Give exactly one verdict per candidate, using its number i.",
  });
  const json = await completeJson(loadLlmConfig(), system, user, {
    temperature: 0,
    numPredict: 1500,
    jsonSchema: {
      type: "object",
      properties: {
        verdicts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              i: { type: "integer" },
              name: { type: "string" },
              belongs: { type: "string", enum: ["yes", "no", "unsure"] },
              kind: { type: "string" },
              reason: { type: "string" },
            },
            required: ["i", "belongs", "reason"],
          },
        },
      },
      required: ["verdicts"],
    },
  });
  const verdicts = (
    Array.isArray(json.verdicts) ? json.verdicts : Array.isArray(json) ? (json as unknown[]) : []
  ) as Verdict[];
  let unread = 0;
  const byKey = new Map(cands.map((c) => [nameKey(c.name), c]));
  let suggested = 0;
  let rejected = 0;
  const now = new Date().toISOString();
  withEntityDb((db) => {
    const ins = db.prepare(
      `INSERT INTO investor_entities (investor_id, name, name_key, match_type, kind, status, source, reason, evidence, created_at)
       VALUES (?, ?, ?, 'exact', ?, ?, 'llm', ?, ?, ?)
       ON CONFLICT(investor_id, name_key, match_type) DO NOTHING`,
    );
    for (const v of verdicts) {
      const c =
        (typeof v.i === "number" && cands[v.i]) || byKey.get(nameKey(String(v.name ?? ""))) || null;
      if (!c || !["yes", "no", "unsure"].includes(String(v.belongs))) {
        unread++; // invented or garbled
        continue;
      }
      // "Unsure" with nothing in common but a word is not worth your time.
      const status: EntityStatus =
        v.belongs === "no" || (v.belongs === "unsure" && c.shared === 0) ? "rejected" : "suggested";
      const why = `${v.belongs === "unsure" ? "Unsure: " : ""}${String(v.reason ?? "").slice(0, 300)}${
        c.shared ? ` · also in ${c.shared} of the same companies (${c.examples.join(", ")})` : ""
      }`;
      ins.run(investorId, c.name, nameKey(c.name), v.kind || null, status, why, c.shared, now);
      if (status === "rejected") rejected++;
      else suggested++;
    }
  });
  return {
    asked: cands.length,
    suggested,
    rejected,
    unread,
    sample: verdicts.length ? undefined : JSON.stringify(json).slice(0, 400),
  };
}

/** How many companies each confirmed / suggested exact name holds (for the editor). */
export function entityHoldCounts(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    withStakeDb((db) => {
      for (const r of db
        .prepare(
          `SELECT h.holder AS holder, COUNT(DISTINCT h.symbol) AS n FROM holder_stakes h
           JOIN holder_scan s ON s.symbol = h.symbol AND s.quarter = h.quarter GROUP BY h.holder`,
        )
        .all() as Array<{ holder: string; n: number }>) {
        const k = nameKey(r.holder);
        out.set(k, (out.get(k) ?? 0) + r.n);
      }
    }, true);
  } catch {
    /* none yet */
  }
  return out;
}
