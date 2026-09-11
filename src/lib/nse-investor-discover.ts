/**
 * NSE corporate announcements — concall transcripts, PPTs, financial results.
 * Official exchange source (no Screener).
 */
import { createNseBuybackSession } from "./nse-buybacks";
import { parseNseDateTime } from "./nse-corp-events";
import { isOrderWinAnnouncementBlob, isOrderWinMarketHit } from "./bse-investor-discover";
import type { DiscoveredMaterialSource, InvestorMaterialKind } from "./investor-material-types";

const CORP_ANN_URL = "https://www.nseindia.com/api/corporate-announcements";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

const ANNOUNCEMENT_KIND: Array<{ re: RegExp; kind: InvestorMaterialKind; title: string }> = [
  {
    re: /transcript|con\.?\s*call|concall|conference\s+call|earnings?\s+call|investor\s+meet|analyst\s+meet/i,
    kind: "concall",
    title: "Concall transcript",
  },
  {
    re: /investor\s+presentation|earnings\s+presentation|analyst\s+presentation/i,
    kind: "ppt",
    title: "Investor presentation",
  },
  {
    re: /outcome\s+of\s+board\s+meeting|financial\s+result|audited\s+financial|unaudited\s+financial/i,
    kind: "other",
    title: "Financial results",
  },
  {
    re: /annual\s+report|board\s+report/i,
    kind: "other",
    title: "Annual / board report",
  },
];

type NseAnnRow = Record<string, unknown>;

function sourceId(url: string): string {
  return url.trim().toLowerCase();
}

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function formatPeriod(raw: unknown): string | null {
  const iso = parseNseDateTime(raw);
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-IN", { month: "short", year: "numeric" });
}

function periodSortKey(period: string | null): number {
  if (!period) return 0;
  const m = period.match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return 0;
  const months: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  return Number(m[2]) * 12 + (months[m[1]!.toLowerCase()] ?? 0);
}

function nseAnnIndex(market: string | null | undefined): Array<"sme" | "equities"> {
  const mk = (market || "").trim().toUpperCase();
  if (mk === "NSE SME") return ["sme", "equities"];
  return ["equities", "sme"];
}

function isNoise(desc: string, attachmentText: string): boolean {
  const blob = `${desc} ${attachmentText}`.toLowerCase();
  return (
    /newspaper publication|postal ballot|agm notice|dividend|record date|clarification.*delay|reasons for delayed|non-submission of financial/i.test(
      blob,
    ) && !/financial result|outcome of board|investor presentation|transcript|conference call|concall/i.test(blob)
  );
}

function classifyRow(row: NseAnnRow): {
  kind: InvestorMaterialKind;
  title: string;
} | null {
  const desc = safeStr(row.desc);
  const attachmentText = safeStr(row.attchmntText);
  const file = safeStr(row.attchmntFile).toLowerCase();
  const blob = `${desc} ${attachmentText} ${file}`;
  if (isNoise(desc, attachmentText)) return null;

  if (/transcript|earning_call|earnings_call|concall|conference.?call|earnings.?call/i.test(file)) {
    return { kind: "concall", title: "Concall transcript" };
  }
  if (/presentation|_ip_|investor_presentation/i.test(file)) {
    return { kind: "ppt", title: "Investor presentation" };
  }

  const match = ANNOUNCEMENT_KIND.find((k) => k.re.test(blob));
  if (!match) return null;
  return { kind: match.kind, title: match.title };
}

async function fetchNseAnnouncements(
  symbol: string,
  index: "sme" | "equities",
  from: Date,
  to: Date,
  jar: { cookie: string },
): Promise<NseAnnRow[]> {
  const dd = (d: Date) =>
    `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;

  const u = new URL(CORP_ANN_URL);
  u.searchParams.set("index", index);
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("from_date", dd(from));
  u.searchParams.set("to_date", dd(to));

  const res = await fetch(u.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json",
      Referer: NSE_ANN_REF,
      Cookie: jar.cookie,
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as unknown;
  return Array.isArray(rows) ? (rows as NseAnnRow[]) : [];
}

async function fetchNseAnnouncementWindows(
  symbol: string,
  index: "sme" | "equities",
  jar: { cookie: string },
): Promise<NseAnnRow[]> {
  const now = new Date();
  const recentFrom = new Date(now);
  recentFrom.setDate(recentFrom.getDate() - 180);
  const oldFrom = new Date(now);
  oldFrom.setFullYear(oldFrom.getFullYear() - 3);

  const recent = await fetchNseAnnouncements(symbol, index, recentFrom, now, jar);
  const older = await fetchNseAnnouncements(symbol, index, oldFrom, recentFrom, jar);
  return [...recent, ...older];
}

/** NSE corporate announcements for concall / PPT / results PDFs. */
export async function discoverNseInvestorMaterialSources(
  ticker: string,
  market: string | null | undefined,
  importedUrls: Set<string>,
): Promise<DiscoveredMaterialSource[]> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return [];

  const jar = await createNseBuybackSession();
  const rows: NseAnnRow[] = [];
  const seenSeq = new Set<string>();
  for (const index of nseAnnIndex(market)) {
    try {
      for (const row of await fetchNseAnnouncementWindows(symbol, index, jar)) {
        const seq = safeStr(row.seq_id);
        if (seq && seenSeq.has(seq)) continue;
        if (seq) seenSeq.add(seq);
        rows.push(row);
      }
    } catch {
      /* try next index */
    }
  }

  const out: DiscoveredMaterialSource[] = [];
  const seenUrl = new Set<string>();

  for (const row of rows) {
    const url = safeStr(row.attchmntFile);
    if (!url.startsWith("http") || url.endsWith("/-")) continue;

    const classified = classifyRow(row);
    if (!classified) continue;

    const id = sourceId(url);
    if (seenUrl.has(id)) continue;
    seenUrl.add(id);

    const rawDt = row.an_dt || row.sort_date || row.dt;
    const announced_at = parseNseDateTime(rawDt);
    const period = formatPeriod(rawDt);
    out.push({
      id,
      kind: classified.kind,
      title: classified.title,
      period,
      announced_at,
      url,
      provider: "nse_announcements",
      imported: importedUrls.has(id),
    });
  }

  out.sort((a, b) => sourceRecency(b) - sourceRecency(a));
  return out;
}

export type NseOrderAnnHit = {
  title: string;
  url: string;
  period: string | null;
  announced_at: string | null;
  provider: "nse_announcements";
};

/** NSE Reg-30 order / LOI / PO announcements (newest first). */
export async function discoverNseOrderAnnouncements(
  ticker: string,
  market?: string | null,
): Promise<NseOrderAnnHit[]> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return [];

  const jar = await createNseBuybackSession();
  const rows: NseAnnRow[] = [];
  const seenSeq = new Set<string>();
  for (const index of nseAnnIndex(market)) {
    try {
      for (const row of await fetchNseAnnouncementWindows(symbol, index, jar)) {
        const seq = safeStr(row.seq_id);
        if (seq && seenSeq.has(seq)) continue;
        if (seq) seenSeq.add(seq);
        rows.push(row);
      }
    } catch {
      /* try next index */
    }
  }

  const out: NseOrderAnnHit[] = [];
  const seenUrl = new Set<string>();
  for (const row of rows) {
    const url = safeStr(row.attchmntFile);
    if (!url.startsWith("http") || url.endsWith("/-")) continue;
    const desc = safeStr(row.desc);
    const attachmentText = safeStr(row.attchmntText);
    const blob = `${desc} ${attachmentText}`;
    if (!isOrderWinAnnouncementBlob(blob)) continue;
    const id = sourceId(url);
    if (seenUrl.has(id)) continue;
    seenUrl.add(id);
    const rawDt = row.an_dt || row.sort_date || row.dt;
    out.push({
      title: desc || "Order announcement",
      url,
      period: formatPeriod(rawDt),
      announced_at: parseNseDateTime(rawDt),
      provider: "nse_announcements",
    });
  }

  out.sort((a, b) => {
    const at = a.announced_at ? Date.parse(a.announced_at) : 0;
    const bt = b.announced_at ? Date.parse(b.announced_at) : 0;
    return bt - at;
  });
  return out;
}

export type NseMarketOrderHit = {
  ticker: string;
  title: string;
  url: string | null;
  period: string | null;
  announced_at: string | null;
  provider: "nse_announcements";
  company: string | null;
};

function dayWindowLocal(offset: number): { from: Date; to: Date } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - offset);
  const to = new Date(from);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/**
 * Market-wide NSE Reg-30 order / LOI announcements (no per-ticker crawl).
 * Same day-window pattern as earn/concall “Get announced”.
 */
export async function discoverNseAnnouncedOrders(
  daysBack = 1,
): Promise<NseMarketOrderHit[]> {
  const days = Math.min(7, Math.max(1, daysBack));
  const jar = await createNseBuybackSession();
  const out: NseMarketOrderHit[] = [];
  const seen = new Set<string>();

  const ingest = (rows: NseAnnRow[]) => {
    for (const row of rows) {
      const ticker = safeStr(row.symbol).toUpperCase();
      if (!ticker) continue;
      const desc = safeStr(row.desc);
      const attachmentText = safeStr(row.attchmntText);
      const blob = `${desc} ${attachmentText}`;
      if (!isOrderWinMarketHit(blob)) continue;
      const urlRaw = safeStr(row.attchmntFile);
      const url =
        urlRaw.startsWith("http") && !urlRaw.endsWith("/-") ? urlRaw : null;
      const key = `${ticker}|${url || desc}|${safeStr(row.an_dt)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const announced_at =
        parseNseDateTime(row.an_dt) ||
        parseNseDateTime(row.sort_date) ||
        parseNseDateTime(row.dt);
      out.push({
        ticker,
        title: desc || "Order announcement",
        url,
        period: formatPeriod(row.an_dt || row.sort_date || row.dt),
        announced_at,
        provider: "nse_announcements",
        company: safeStr(row.sm_name) || safeStr(row.companyName) || null,
      });
    }
  };

  for (let offset = 0; offset < days; offset += 1) {
    const { from, to } = dayWindowLocal(offset);
    const windows = await Promise.all(
      (["equities", "sme"] as const).map(async (index) => {
        try {
          return await fetchNseAnnouncementWindowsForRange(
            "",
            index,
            from,
            to,
            jar,
          );
        } catch {
          return [] as NseAnnRow[];
        }
      }),
    );
    for (const rows of windows) ingest(rows);
  }

  out.sort((a, b) => {
    const at = a.announced_at ? Date.parse(a.announced_at) : 0;
    const bt = b.announced_at ? Date.parse(b.announced_at) : 0;
    return bt - at;
  });
  return out;
}

export type NseMarketAnnouncementHit = {
  ticker: string;
  company: string | null;
  title: string;
  url: string | null;
  announced_at: string | null;
  period: string | null;
  provider: "nse_announcements";
  index: "equities" | "sme";
};

/**
 * Market-wide NSE corporate announcements (CAME feed via corporate-announcements API).
 * Order / LOI / PO wins are excluded — those belong on the Orderbook screen.
 * Optional `q` filters title text.
 */
export async function discoverNseMarketAnnouncements(
  daysBack = 1,
  opts?: { q?: string | null },
): Promise<NseMarketAnnouncementHit[]> {
  const days = Math.min(7, Math.max(1, daysBack));
  const q = (opts?.q || "").trim().toLowerCase();
  const jar = await createNseBuybackSession();
  const out: NseMarketAnnouncementHit[] = [];
  const seen = new Set<string>();

  const ingest = (rows: NseAnnRow[], index: "equities" | "sme") => {
    for (const row of rows) {
      const ticker = safeStr(row.symbol).toUpperCase();
      if (!ticker) continue;
      const desc = safeStr(row.desc) || safeStr(row.attchmntText);
      if (!desc) continue;
      if (q && !desc.toLowerCase().includes(q)) continue;
      // Keep order-win filings off MarketIQ (Orderbook owns that lane).
      const blob = `${desc} ${safeStr(row.attchmntText)}`;
      if (isOrderWinAnnouncementBlob(blob)) continue;
      const urlRaw = safeStr(row.attchmntFile);
      const url =
        urlRaw.startsWith("http") && !urlRaw.endsWith("/-") ? urlRaw : null;
      const rawDt = row.an_dt || row.sort_date || row.dt;
      const announced_at =
        parseNseDateTime(rawDt) ||
        parseNseDateTime(row.sort_date) ||
        parseNseDateTime(row.dt);
      // Dedupe same ticker + title + calendar day (NSE often posts 2 PDFs).
      const day =
        (announced_at && announced_at.slice(0, 10)) ||
        safeStr(rawDt).slice(0, 10);
      const normTitle = desc.toLowerCase().replace(/\s+/g, " ").trim();
      const key = `${ticker}|${normTitle}|${day}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ticker,
        company: safeStr(row.sm_name) || safeStr(row.companyName) || null,
        title: desc,
        url,
        announced_at,
        period: formatPeriod(rawDt),
        provider: "nse_announcements",
        index,
      });
    }
  };

  for (let offset = 0; offset < days; offset += 1) {
    const { from, to } = dayWindowLocal(offset);
    const windows = await Promise.all(
      (["equities", "sme"] as const).map(async (index) => {
        try {
          const rows = await fetchNseAnnouncementWindowsForRange(
            "",
            index,
            from,
            to,
            jar,
          );
          return { index, rows };
        } catch {
          return { index, rows: [] as NseAnnRow[] };
        }
      }),
    );
    for (const w of windows) ingest(w.rows, w.index);
  }

  out.sort((a, b) => {
    const at = a.announced_at ? Date.parse(a.announced_at) : 0;
    const bt = b.announced_at ? Date.parse(b.announced_at) : 0;
    return bt - at;
  });
  return out;
}

async function fetchNseAnnouncementWindowsForRange(
  symbol: string,
  index: "sme" | "equities",
  from: Date,
  to: Date,
  jar: Awaited<ReturnType<typeof createNseBuybackSession>>,
): Promise<NseAnnRow[]> {
  const dd = (d: Date) =>
    `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
  const u = new URL(CORP_ANN_URL);
  u.searchParams.set("index", index);
  if (symbol.trim()) u.searchParams.set("symbol", symbol.trim().toUpperCase());
  u.searchParams.set("from_date", dd(from));
  u.searchParams.set("to_date", dd(to));
  const res = await fetch(u.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json",
      Referer: NSE_ANN_REF,
      Cookie: jar.cookie,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as unknown;
  return Array.isArray(rows) ? (rows as NseAnnRow[]) : [];
}

function sourceRecency(s: DiscoveredMaterialSource): number {
  if (s.announced_at) {
    const t = Date.parse(s.announced_at);
    if (Number.isFinite(t)) return t;
  }
  const key = periodSortKey(s.period);
  if (!key) return 0;
  const year = Math.floor((key - 1) / 12);
  const month = (key - 1) % 12;
  return Date.UTC(year, month, 15);
}

export { formatPeriod as nseInvestorFormatPeriod };
