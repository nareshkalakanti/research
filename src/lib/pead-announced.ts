/**
 * PEAD 2 result dates = financial-result *announcements*, not quarter period-ends.
 * Growth uses the latest quarter-end that has an announcement in [q_end, q_end+120d].
 */
import { JUNK_SUBJECTS } from "./strategy/concall-drift-earn";
import { marketIqDbFile } from "./iq-dbs";
import { openSqliteNamed } from "./sqlite-utils";
import type { QuarterPoint } from "./quarter-panel";
import { createNseBuybackSession } from "./nse-buybacks";
import {
  formatNseApiDateFromInstant,
  istCivilDayToUtcNoon,
  istRangeDaysBack,
  parseNseDateTime,
} from "./nse-time";
import { runConcurrent } from "./scrape-pool";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ANNOUNCE_WINDOW_DAYS = 120;
const FUTURE_QUARTER_SLACK_DAYS = 5;

function isoDay(raw: string | null | undefined): string | null {
  const d = (raw || "").slice(0, 10);
  return ISO_DAY.test(d) ? d : null;
}

function utcNoon(iso: string): number {
  return Date.parse(`${iso}T12:00:00Z`);
}

function addDays(iso: string, days: number): string {
  const t = utcNoon(iso) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function isCalendarQuarterEnd(iso: string | null | undefined): boolean {
  const d = isoDay(iso);
  if (!d) return false;
  const day = d.slice(8, 10);
  const month = d.slice(5, 7);
  if (month === "03" && day === "31") return true;
  if (month === "06" && day === "30") return true;
  if (month === "09" && day === "30") return true;
  if (month === "12" && day === "31") return true;
  return false;
}

/** NSE financial-result filing — not clarifications, trading window, or board-only. */
export function isPeadResultAnnouncement(
  headline: string | null | undefined,
  summary: string | null | undefined,
): boolean {
  const head = (headline || "").trim();
  const sum = (summary || "").trim();
  const blob = `${head} ${sum}`.toLowerCase();
  if (!blob.trim()) return false;
  if (JUNK_SUBJECTS.has(head)) return false;
  if (/trading window|^updates$/i.test(head)) return false;
  if (
    /clarification|reply to clarification/i.test(blob) &&
    !/period ended|quarter ended|unaudited financial results|audited financial results/i.test(
      blob,
    )
  ) {
    return false;
  }
  if (/outcome of board/i.test(blob)) {
    return /financial result|period ended|quarter ended|unaudited|audited financial/i.test(
      blob,
    );
  }
  if (
    /financial result updates|integrated filing- financial|unaudited financial results|audited financial results/i.test(
      blob,
    )
  ) {
    return true;
  }
  if (/financial results/i.test(blob) && !/clarification/i.test(blob)) {
    return true;
  }
  return false;
}

export function latestAnnounceOnOrBefore(
  dates: string[],
  asOf?: string,
): string | null {
  const today = isoDay(asOf) || new Date().toISOString().slice(0, 10);
  const ok = dates
    .map((d) => isoDay(d))
    .filter((d): d is string => Boolean(d) && d <= today)
    .sort();
  return ok[ok.length - 1] ?? null;
}

export function quarterHasAnnouncement(
  quarterEnd: string,
  announceDates: string[],
  asOf?: string,
): boolean {
  const q = isoDay(quarterEnd);
  if (!q) return false;
  const today = isoDay(asOf) || new Date().toISOString().slice(0, 10);
  const hi = addDays(q, ANNOUNCE_WINDOW_DAYS);
  return announceDates.some((raw) => {
    const a = isoDay(raw);
    if (!a || a > today) return false;
    return a >= q && a <= hi;
  });
}

export function trimReportedQuarters(
  quarters: QuarterPoint[],
  asOf?: string,
): QuarterPoint[] {
  const today = isoDay(asOf) || new Date().toISOString().slice(0, 10);
  const slack = addDays(today, FUTURE_QUARTER_SLACK_DAYS);
  return quarters.filter((q) => {
    const d = isoDay(q.date);
    return d != null && d <= slack;
  });
}

/** Drop leading unannounced period-ends (Yahoo/Screener placeholders). */
export function sliceToAnnouncedQuarters(
  quarters: QuarterPoint[],
  announceDates: string[],
  asOf?: string,
): QuarterPoint[] {
  const reported = trimReportedQuarters(quarters, asOf);
  if (!reported.length) return [];
  if (!announceDates.length) return reported;
  const dated = [...reported].sort((a, b) =>
    (isoDay(a.date) || "").localeCompare(isoDay(b.date) || ""),
  );
  for (let offset = 0; offset < dated.length; offset++) {
    const last = dated[dated.length - 1 - offset]!;
    const qEnd = isoDay(last.date);
    if (qEnd && quarterHasAnnouncement(qEnd, announceDates, asOf)) {
      return dated.slice(0, dated.length - offset);
    }
  }
  return dated;
}

let announceCache: { at: number; map: Map<string, string[]> } | null = null;
const ANNOUNCE_CACHE_MS = 45_000;

export function loadPeadAnnounceDatesMap(): Map<string, string[]> {
  const now = Date.now();
  if (announceCache && now - announceCache.at < ANNOUNCE_CACHE_MS) {
    return announceCache.map;
  }
  const map = new Map<string, string[]>();
  try {
    const db = openSqliteNamed(marketIqDbFile(), {
      readonly: true,
      wal: true,
      fileMustExist: true,
    });
    try {
      const rows = db
        .prepare(
          `SELECT ticker, announcement_date, headline, summary
           FROM announcement_screens
           WHERE COALESCE(ticker, '') != ''
             AND COALESCE(announcement_date, '') != ''`,
        )
        .all() as Array<{
        ticker: string;
        announcement_date: string;
        headline: string | null;
        summary: string | null;
      }>;
      for (const row of rows) {
        if (!isPeadResultAnnouncement(row.headline, row.summary)) continue;
        const day = isoDay(row.announcement_date);
        if (!day) continue;
        const key = row.ticker.trim().toUpperCase();
        const list = map.get(key) ?? [];
        list.push(day);
        map.set(key, list);
      }
      for (const [k, list] of map) {
        map.set(k, [...new Set(list)].sort());
      }
    } finally {
      db.close();
    }
  } catch {
    /* missing MarketIQ db */
  }
  for (const [ticker, dates] of loadPeadNseResultDatesMap()) {
    const list = map.get(ticker) ?? [];
    for (const d of dates) list.push(d);
    map.set(ticker, [...new Set(list)].sort());
  }
  announceCache = { at: now, map };
  return map;
}

const NSE_ANN_URL = "https://www.nseindia.com/api/corporate-announcements";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

function nseResultDatesDb() {
  const handle = openSqliteNamed("metrics.db", { wal: true });
  handle.exec(`
    CREATE TABLE IF NOT EXISTS pead_nse_result_dates (
      ticker TEXT PRIMARY KEY,
      dates_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return handle;
}

export function loadPeadNseResultDatesMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  try {
    const handle = nseResultDatesDb();
    try {
      const rows = handle
        .prepare(`SELECT ticker, dates_json FROM pead_nse_result_dates`)
        .all() as Array<{ ticker: string; dates_json: string }>;
      for (const row of rows) {
        let dates: unknown;
        try {
          dates = JSON.parse(row.dates_json);
        } catch {
          continue;
        }
        if (!Array.isArray(dates)) continue;
        const days = dates
          .map((d) => isoDay(String(d)))
          .filter((d): d is string => Boolean(d));
        if (days.length) map.set(row.ticker.toUpperCase(), [...new Set(days)].sort());
      }
    } finally {
      handle.close();
    }
  } catch {
    /* missing */
  }
  return map;
}

export function savePeadNseResultDates(ticker: string, dates: string[]): void {
  const handle = nseResultDatesDb();
  try {
    handle
      .prepare(
        `INSERT INTO pead_nse_result_dates (ticker, dates_json, updated_at)
         VALUES (@ticker, @dates_json, @updated_at)
         ON CONFLICT(ticker) DO UPDATE SET
           dates_json = excluded.dates_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        ticker: ticker.trim().toUpperCase(),
        dates_json: JSON.stringify([...new Set(dates.map((d) => isoDay(d)).filter(Boolean))]),
        updated_at: new Date().toISOString(),
      });
  } finally {
    handle.close();
  }
}

export function invalidatePeadAnnounceCache(): void {
  announceCache = null;
}

async function fetchNseAnnRows(
  symbol: string,
  index: "equities" | "sme",
  jar: { cookie: string },
): Promise<Array<Record<string, unknown>>> {
  const { from: fromDay, to: toDay } = istRangeDaysBack(400);
  const u = new URL(NSE_ANN_URL);
  u.searchParams.set("index", index);
  u.searchParams.set("symbol", symbol);
  u.searchParams.set(
    "from_date",
    formatNseApiDateFromInstant(istCivilDayToUtcNoon(fromDay)),
  );
  u.searchParams.set(
    "to_date",
    formatNseApiDateFromInstant(istCivilDayToUtcNoon(toDay)),
  );
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
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function datesFromNseRows(rows: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const desc = String(row.desc ?? "").trim();
    const att = String(row.attchmntText ?? "").trim();
    if (!isPeadResultAnnouncement(desc, att)) continue;
    const iso = parseNseDateTime(row.an_dt || row.sort_date || row.dt);
    const day = isoDay(iso);
    if (day) out.push(day);
  }
  return [...new Set(out)].sort();
}

export async function refreshPeadNseResultDates(
  rows: Array<{ ticker: string; market: string }>,
): Promise<number> {
  const nseRows = rows.filter((r) => {
    const m = (r.market || "").toUpperCase();
    return !m.includes("BSE") && m !== "BOMBAY STOCK EXCHANGE";
  });
  if (!nseRows.length) return 0;
  const jar = await createNseBuybackSession();
  let updated = 0;
  await runConcurrent(nseRows, 3, async (row) => {
    const mk = (row.market || "").toUpperCase();
    const indexes: Array<"equities" | "sme"> =
      mk.includes("SME") ? ["sme", "equities"] : ["equities", "sme"];
    let dates: string[] = [];
    for (const index of indexes) {
      try {
        dates = datesFromNseRows(await fetchNseAnnRows(row.ticker, index, jar));
      } catch {
        dates = [];
      }
      if (dates.length) break;
    }
    savePeadNseResultDates(row.ticker, dates);
    updated += 1;
  });
  invalidatePeadAnnounceCache();
  return updated;
}
