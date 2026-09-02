import { createNseBuybackSession } from "./nse-buybacks";
import { isFinancialEarnAnnouncement } from "./strategy/concall-drift-earn";
import { withWebsiteFetch } from "./scrape-pool";

const CORP_ANN_URL = "https://www.nseindia.com/api/corporate-announcements";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

export type NseCorpEventKind = "earn" | "concall";

export type NseCorpEvent = {
  ticker: string;
  seq_id: string | null;
  kind: NseCorpEventKind;
  title: string;
  announced_at: string;
  subject: string | null;
  url: string | null;
};

type NseAnnRow = Record<string, unknown>;
type NseJar = Awaited<ReturnType<typeof createNseBuybackSession>>;

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function nseAnnIndex(market: string | null | undefined): Array<"sme" | "equities"> {
  const mk = (market || "").trim().toUpperCase();
  if (mk === "NSE SME") return ["sme", "equities"];
  return ["equities", "sme"];
}

export function parseNseDateTime(raw: unknown): string | null {
  const text = safeStr(raw);
  if (!text) return null;
  const m = text.match(
    /^(\d{2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (m) {
    const months: Record<string, number> = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const mon = months[m[2]!.toLowerCase()];
    if (mon == null) return null;
    const d = new Date(
      Number(m[3]),
      mon,
      Number(m[1]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0),
    );
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  const n = text.match(
    /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (n) {
    const d = new Date(
      Number(n[3]),
      Number(n[2]) - 1,
      Number(n[1]),
      Number(n[4] || 0),
      Number(n[5] || 0),
      Number(n[6] || 0),
    );
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isNoise(desc: string, attachmentText: string): boolean {
  const blob = `${desc} ${attachmentText}`.toLowerCase();
  return (
    /newspaper publication|postal ballot|agm notice|dividend|record date|clarification.*delay|reasons for delayed|non-submission of financial/i.test(
      blob,
    ) && !/financial result|outcome of board|investor presentation|transcript|concall|conference call|earnings call/i.test(blob)
  );
}

function classifyEvent(row: NseAnnRow): NseCorpEventKind | null {
  const desc = safeStr(row.desc);
  const attachmentText = safeStr(row.attchmntText);
  const file = safeStr(row.attchmntFile).toLowerCase();
  const blobText = `${desc} ${attachmentText} ${file}`;
  if (isNoise(desc, attachmentText)) return null;

  if (
    /transcript|earning_call|earnings_call|concall|conference.?call|earnings?\s+call|investor meet|analyst meet/i.test(
      blobText,
    )
  ) {
    return "concall";
  }
  if (isFinancialEarnAnnouncement(desc, attachmentText, file)) {
    return "earn";
  }
  return null;
}

async function fetchNseAnnouncements(
  symbol: string,
  index: "sme" | "equities",
  from: Date,
  to: Date,
  jar: NseJar,
): Promise<NseAnnRow[]> {
  const dd = (d: Date) =>
    `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;

  const u = new URL(CORP_ANN_URL);
  u.searchParams.set("index", index);
  if (symbol.trim()) u.searchParams.set("symbol", symbol.trim().toUpperCase());
  u.searchParams.set("from_date", dd(from));
  u.searchParams.set("to_date", dd(to));

  const res = await withWebsiteFetch(u.toString(), () =>
    fetch(u.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json",
        Referer: NSE_ANN_REF,
        Cookie: jar.cookie,
      },
      signal: AbortSignal.timeout(25_000),
    }),
  );
  if (!res.ok) return [];
  const rows = (await res.json()) as unknown;
  return Array.isArray(rows) ? (rows as NseAnnRow[]) : [];
}

function parseCorpRows(rows: NseAnnRow[], fallbackTicker?: string): NseCorpEvent[] {
  const out: NseCorpEvent[] = [];
  for (const row of rows) {
    const kind = classifyEvent(row);
    if (!kind) continue;
    const ticker = (safeStr(row.symbol) || fallbackTicker || "").toUpperCase();
    if (!ticker) continue;
    const announced_at =
      parseNseDateTime(row.an_dt) ||
      parseNseDateTime(row.sort_date) ||
      parseNseDateTime(row.dt);
    if (!announced_at) continue;
    const desc = safeStr(row.desc);
    const attachmentText = safeStr(row.attchmntText);
    out.push({
      ticker,
      seq_id: safeStr(row.seq_id) || null,
      kind,
      title:
        kind === "earn"
          ? "Financial results"
          : /transcript/i.test(`${desc} ${attachmentText}`)
            ? "Concall transcript"
            : "Concall / investor meet",
      announced_at,
      subject: desc || attachmentText || null,
      url: safeStr(row.attchmntFile).startsWith("http")
        ? safeStr(row.attchmntFile)
        : null,
    });
  }
  out.sort(
    (a, b) => Date.parse(b.announced_at) - Date.parse(a.announced_at),
  );
  return out;
}

/** Fetch NSE earnings + concall announcements for the last `daysBack` days. */
export async function fetchNseCorpEvents(
  ticker: string,
  market: string | null | undefined,
  daysBack = 120,
  sharedJar?: NseJar,
): Promise<NseCorpEvent[]> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return [];

  const to = new Date();
  const recentFrom = new Date(to);
  recentFrom.setDate(recentFrom.getDate() - Math.min(21, daysBack));
  const from = new Date(to);
  from.setDate(from.getDate() - daysBack);

  const jar = sharedJar ?? (await createNseBuybackSession());
  const rows: NseAnnRow[] = [];
  const seenSeq = new Set<string>();
  for (const index of nseAnnIndex(market)) {
    try {
      const windows =
        daysBack > 21
          ? await Promise.all([
              fetchNseAnnouncements(symbol, index, recentFrom, to, jar),
              fetchNseAnnouncements(symbol, index, from, recentFrom, jar),
            ])
          : [await fetchNseAnnouncements(symbol, index, from, to, jar)];
      for (const row of windows.flat()) {
        const seq = safeStr(row.seq_id);
        if (seq && seenSeq.has(seq)) continue;
        if (seq) seenSeq.add(seq);
        rows.push(row);
      }
      if (rows.length > 0) break;
    } catch {
      /* try next index */
    }
  }

  return parseCorpRows(rows, symbol);
}

function dayWindow(offset: number): { from: Date; to: Date } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - offset);
  const to = new Date(from);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/**
 * All NSE earn / concall filings in the last `daysBack` days (no per-ticker crawl).
 * Day windows avoid the bulk announcements cap dropping today's names.
 */
export async function fetchNseAnnouncedCorpEvents(
  daysBack = 7,
  sharedJar?: NseJar,
): Promise<NseCorpEvent[]> {
  const days = Math.min(14, Math.max(1, daysBack));
  const jar = sharedJar ?? (await createNseBuybackSession());
  const rows: NseAnnRow[] = [];
  const seenSeq = new Set<string>();

  for (let offset = 0; offset < days; offset += 1) {
    const { from, to } = dayWindow(offset);
    const windows = await Promise.all(
      (["equities", "sme"] as const).map((index) =>
        fetchNseAnnouncements("", index, from, to, jar).catch(
          () => [] as NseAnnRow[],
        ),
      ),
    );
    for (const row of windows.flat()) {
      const seq = safeStr(row.seq_id) || `${safeStr(row.symbol)}:${safeStr(row.an_dt)}`;
      if (seq && seenSeq.has(seq)) continue;
      if (seq) seenSeq.add(seq);
      rows.push(row);
    }
  }

  if (!rows.length) {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - Math.max(1, days));
    const windows = await Promise.all(
      (["equities", "sme"] as const).map((index) =>
        fetchNseAnnouncements("", index, from, now, jar).catch(
          () => [] as NseAnnRow[],
        ),
      ),
    );
    for (const row of windows.flat()) {
      const seq = safeStr(row.seq_id) || `${safeStr(row.symbol)}:${safeStr(row.an_dt)}`;
      if (seq && seenSeq.has(seq)) continue;
      if (seq) seenSeq.add(seq);
      rows.push(row);
    }
  }

  return parseCorpRows(rows);
}

/** Unique tickers that filed results or a concall in the announcement window. */
export function announcedEarnTickers(events: NseCorpEvent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of events) {
    const t = e.ticker.toUpperCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
