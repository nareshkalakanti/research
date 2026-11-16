import { loadCtx } from "./nanocap-champs";
import { openSqliteNamed } from "./sqlite-utils";
import { SS_BUCKETS, type SsBucket } from "./special-situations-shared";

/**
 * Special Situations: corporate events that can create mispricing, pulled
 * market-wide from NSE announcements (main board + SME) and sorted into six
 * themes. Synced into metrics.db `special_events`; backfill 60 days, then
 * the latest few days whenever the tab loads (at most hourly).
 */

export { SS_BUCKETS, type SsBucket };

export type SsEvent = {
  id: string;
  symbol: string;
  company: string;
  date: string;
  bucket: SsBucket;
  label: string;
  category: string;
  text: string;
  url: string;
  market: string;
  mcap_cr: number | null;
};

export type SsCompanyRow = {
  symbol: string;
  company: string;
  market: string;
  mcap_cr: number | null;
  latest: SsEvent;
  count: number;
};

export type SsPage = {
  counts: Record<SsBucket, number>;
  rows: Record<SsBucket, SsCompanyRow[]>;
  days: number;
  synced_at: string | null;
  oldest: string | null;
};

const NSE = (process.env.NSE_ORIGIN || "https://www.nseindia.in").replace(/\/+$/, "");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BACKFILL_DAYS = 60;
const SYNC_EVERY_MS = 3_600_000;

// ---- Classification --------------------------------------------------------

type Rule = { bucket: SsBucket; label: string; cat?: RegExp; text?: RegExp; not?: RegExp };

/** First match wins — order matters (liquidation before insolvency, etc.). */
const RULES: Rule[] = [
  // The company itself — not closing a subsidiary (routine housekeeping).
  { bucket: "liquidation", label: "Liquidation", cat: /liquidation|winding/i, not: /subsidiar|step[-\s]down|associate|joint venture/i },
  {
    bucket: "liquidation",
    label: "Liquidation",
    text: /\b(liquidation|liquidator|winding[-\s]up)\b/i,
    not: /no liquidation|subsidiar|step[-\s]down|associate|joint venture/i,
  },

  { bucket: "bankruptcy", label: "Resolution plan", text: /resolution plan.*(approv|sanction)|(approv|sanction).*resolution plan/i },
  { bucket: "bankruptcy", label: "One-time settlement", text: /one[-\s]time settlement|\bOTS\b/i },
  { bucket: "bankruptcy", label: "Insolvency (CIRP)", cat: /insolvency|bankruptcy/i },
  { bucket: "bankruptcy", label: "Insolvency (CIRP)", text: /\b(CIRP|NCLT admit|admitted .*insolvency|corporate insolvency)\b/i },

  { bucket: "spin", label: "Demerger", text: /de-?merger|demerge|spin[-\s]?off/i },
  { bucket: "spin", label: "Business transfer", text: /business transfer agreement|slump sale/i },

  { bucket: "ma", label: "Open offer", cat: /open offer/i },
  { bucket: "ma", label: "Delisting", cat: /delisting/i },
  { bucket: "ma", label: "Delisting", text: /\bdelisting\b/i },
  { bucket: "ma", label: "Merger", cat: /amalgamation|merger/i },
  { bucket: "ma", label: "Merger", cat: /scheme of arrangement/i, text: /amalgamat|merger/i },
  {
    bucket: "ma",
    label: "Takeover (open offer trigger)",
    cat: /takeover/i,
    text: /regulation\s*(3|4|5)\b|open offer/i,
  },
  {
    bucket: "ma",
    label: "Acquisition",
    cat: /acquisition/i,
    not: /wholly[-\s]owned subsidiary|step[-\s]down subsidiary|further investment|subscription to|rights issue of|incorporat/i,
  },

  { bucket: "distress", label: "Default", text: /\bdefault(ed)?\b.*(payment|interest|principal|loan|debenture)|delay in (payment|servicing)/i },
  { bucket: "distress", label: "Auditor resigned", cat: /resignation of statutory auditor/i },
  { bucket: "distress", label: "Results delayed", cat: /delayed|non-submission/i },
  { bucket: "distress", label: "Rating downgrade", cat: /credit rating/i, text: /downgrad|revised.*(negative|lower)|credit watch with negative|issuer not cooperating/i },
  { bucket: "distress", label: "Regulator order", cat: /action\(s\)|orders? passed/i },
  { bucket: "distress", label: "Forensic / fraud", text: /forensic audit|fraud/i },

  { bucket: "catalyst", label: "Order win", cat: /bagging|receiving of orders|awarding of order/i },
  { bucket: "catalyst", label: "Capacity / production", cat: /capacity addition|commencement of commercial production/i },
  { bucket: "catalyst", label: "Buyback", cat: /buy\s?back/i },
  { bucket: "catalyst", label: "Buyback", text: /\bbuy[-\s]?back of (equity )?shares\b/i },
  { bucket: "catalyst", label: "Asset sale", text: /sale of (its )?(stake|undertaking|division|business|land|asset)|divest/i },
  { bucket: "catalyst", label: "Regulatory approval", text: /\b(USFDA|EIR|approval from (the )?(DCGI|USFDA|regulator)|license granted|patent granted)\b/i },
  { bucket: "catalyst", label: "Rating upgrade", cat: /credit rating/i, text: /upgrad/i },
  {
    bucket: "catalyst",
    label: "Management change",
    cat: /change in management/i,
    text: /(managing director|chief executive|\bCEO\b)/i,
    not: /re-?appoint/i,
  },
];

export function classifyAnnouncement(category: string, text: string): { bucket: SsBucket; label: string } | null {
  for (const r of RULES) {
    // A rule matches when every condition it has holds.
    if (r.cat && !r.cat.test(category)) continue;
    if (r.text && !r.text.test(text)) continue;
    if (r.not && r.not.test(`${category} ${text}`)) continue;
    return { bucket: r.bucket, label: r.label };
  }
  return null;
}

// ---- Sync ---------------------------------------------------------------------

function withDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 8000");
    db.exec(`CREATE TABLE IF NOT EXISTS special_events (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      company TEXT,
      date TEXT NOT NULL,
      bucket TEXT NOT NULL,
      label TEXT NOT NULL,
      category TEXT,
      text TEXT,
      url TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_special_events_date ON special_events(date DESC);
    CREATE TABLE IF NOT EXISTS special_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    return fn(db);
  } finally {
    db.close();
  }
}

const ddmmyyyy = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;

type Ann = { symbol?: string; sm_name?: string; desc?: string; attchmntText?: string; attchmntFile?: string; sort_date?: string; seq_id?: string };

async function fetchWindow(index: "equities" | "sme", from: Date, to: Date): Promise<Ann[]> {
  const url = `${NSE}/api/corporate-announcements?index=${index}&from_date=${ddmmyyyy(from)}&to_date=${ddmmyyyy(to)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: `${NSE}/companies-listing/corporate-filings-announcements` },
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`NSE ${res.status}`);
  const j = (await res.json()) as unknown;
  return Array.isArray(j) ? (j as Ann[]) : [];
}

function store(rows: Ann[]): number {
  const keep: Array<[string, string, string, string, SsBucket, string, string, string, string]> = [];
  for (const r of rows) {
    const category = String(r.desc || "").trim();
    const text = String(r.attchmntText || "").replace(/\s+/g, " ").trim();
    const c = classifyAnnouncement(category, text);
    if (!c || !r.symbol || !r.sort_date) continue;
    const id = String(r.seq_id || r.attchmntFile || `${r.symbol}-${r.sort_date}-${category}`);
    keep.push([
      id,
      r.symbol.toUpperCase(),
      String(r.sm_name || r.symbol),
      r.sort_date.slice(0, 10),
      c.bucket,
      c.label,
      category,
      text.length > 400 ? `${text.slice(0, 397)}…` : text,
      String(r.attchmntFile || ""),
    ]);
  }
  if (!keep.length) return 0;
  return withDb((db) => {
    const ins = db.prepare(
      `INSERT OR REPLACE INTO special_events (id, symbol, company, date, bucket, label, category, text, url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = db.transaction(() => {
      for (const k of keep) ins.run(...k);
    });
    tx();
    return keep.length;
  });
}

function meta(key: string): string | null {
  return withDb(
    (db) => (db.prepare(`SELECT value FROM special_meta WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null,
  );
}
function setMeta(key: string, value: string) {
  withDb((db) =>
    db
      .prepare(`INSERT INTO special_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value),
  );
}

let syncing: Promise<{ added: number }> | null = null;

/** Pull announcements since the last sync (60-day backfill the first time). */
export function syncSpecialEvents(force = false): Promise<{ added: number }> {
  if (syncing) return syncing;
  const last = meta("synced_at");
  if (!force && last && Date.now() - Date.parse(last) < SYNC_EVERY_MS) return Promise.resolve({ added: 0 });
  syncing = (async () => {
    const lastDay = meta("synced_through");
    const start = lastDay
      ? new Date(Date.parse(`${lastDay}T00:00:00Z`) - 2 * 86_400_000)
      : new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
    const end = new Date();
    let added = 0;
    for (let from = start; from <= end; from = new Date(from.getTime() + 5 * 86_400_000)) {
      const to = new Date(Math.min(from.getTime() + 4 * 86_400_000, end.getTime()));
      for (const index of ["equities", "sme"] as const) {
        try {
          added += store(await fetchWindow(index, from, to));
        } catch {
          /* skip window; next sync overlaps by 2 days */
        }
      }
    }
    setMeta("synced_at", new Date().toISOString());
    setMeta("synced_through", end.toISOString().slice(0, 10));
    if (!meta("oldest")) setMeta("oldest", start.toISOString().slice(0, 10));
    return { added };
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

export function isSpecialSyncing(): boolean {
  return !!syncing;
}

// ---- Page ---------------------------------------------------------------------

export function buildSpecialPage(days = 60): SsPage {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const events = withDb(
    (db) =>
      db
        .prepare(
          `SELECT id, symbol, company, date, bucket, label, category, text, url FROM special_events
           WHERE date >= ? ORDER BY date DESC`,
        )
        .all(since) as Array<Omit<SsEvent, "market" | "mcap_cr">>,
  );
  const ctx = loadCtx();
  const rows = Object.fromEntries(SS_BUCKETS.map((b) => [b.id, [] as SsCompanyRow[]])) as Record<SsBucket, SsCompanyRow[]>;
  const byKey = new Map<string, SsCompanyRow>();
  for (const e of events) {
    const key = `${e.bucket}:${e.symbol}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.count += 1;
      continue;
    }
    const ev: SsEvent = {
      ...e,
      market: ctx.cos.get(e.symbol)?.market ?? "",
      mcap_cr: ctx.mcap.get(e.symbol) ?? null,
    };
    const row: SsCompanyRow = {
      symbol: e.symbol,
      company: ctx.cos.get(e.symbol)?.name ?? e.company,
      market: ev.market,
      mcap_cr: ev.mcap_cr,
      latest: ev,
      count: 1,
    };
    byKey.set(key, row);
    rows[e.bucket].push(row);
  }
  const counts = Object.fromEntries(SS_BUCKETS.map((b) => [b.id, rows[b.id].length])) as Record<SsBucket, number>;
  return { counts, rows, days, synced_at: meta("synced_at"), oldest: meta("oldest") };
}
