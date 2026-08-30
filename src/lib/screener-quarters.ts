/**
 * Screener.in quarterly / half-yearly results table → QuarterPoint[].
 * Fallback when Yahoo and NSE XBRL are empty (common on NSE SME).
 */
import * as cheerio from "cheerio";
import { screenerUrl } from "./links";
import type { QuarterPoint } from "./quarter-panel";
import { trimReportedQuarters } from "./quarter-panel";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MONTH_NUM: Record<string, string> = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
};

const MONTH_END: Record<string, number> = {
  JAN: 31,
  FEB: 28,
  MAR: 31,
  APR: 30,
  MAY: 31,
  JUN: 30,
  JUL: 31,
  AUG: 31,
  SEP: 30,
  OCT: 31,
  NOV: 30,
  DEC: 31,
};

function parsePeriodLabel(label: string): string | null {
  const m = label.trim().match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return null;
  const mon = m[1]!.toUpperCase();
  const month = MONTH_NUM[mon];
  const day = MONTH_END[mon];
  if (!month || !day) return null;
  return `${m[2]}-${month}-${String(day).padStart(2, "0")}`;
}

function parseNum(raw: string): number | null {
  const t = raw.replace(/\u00a0/g, " ").replace(/,/g, "").replace(/%$/, "").trim();
  if (!t || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function pickResultsTable($: cheerio.CheerioAPI): cheerio.Cheerio | null {
  let picked: cheerio.Cheerio | null = null;

  $("h2").each((_, h2) => {
    const title = $(h2).text().trim();
    if (!/^(Quarterly|Half Yearly) Results$/i.test(title)) return;
    const table = $(h2).closest("section").find("table").first();
    if (table.length) {
      picked = table;
      return false;
    }
  });

  if (picked?.length) return picked;

  $("table").each((_, el) => {
    const headers = $(el)
      .find("thead th")
      .map((__, th) => $(th).text().trim())
      .get()
      .filter(Boolean);
    const periodCols = headers.filter((h) => parsePeriodLabel(h));
    if (periodCols.length >= 2) {
      picked = $(el);
      return false;
    }
  });

  return picked?.length ? picked : null;
}

/** Parse Screener quarterly or half-yearly results (values in ₹ Cr). */
export async function fetchScreenerQuarterlyFundamentals(
  ticker: string,
): Promise<QuarterPoint[]> {
  const key = ticker.trim().toUpperCase();
  if (!key) return [];

  const res = await fetch(screenerUrl(key), {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return [];

  const html = await res.text();
  if (/captcha|access denied|rate limit/i.test(html)) return [];

  const $ = cheerio.load(html);
  const table = pickResultsTable($);
  if (!table) return [];

  const headers = table
    .find("thead th")
    .map((_, th) => $(th).text().trim())
    .get();

  const periods: Array<{ idx: number; date: string; label: string }> = [];
  headers.forEach((h, idx) => {
    if (idx === 0) return;
    const date = parsePeriodLabel(h);
    if (date) periods.push({ idx, date, label: h });
  });
  if (periods.length < 2) return [];

  const byDate = new Map<string, QuarterPoint>();
  for (const p of periods) {
    byDate.set(p.date, {
      date: p.date,
      revenue: null,
      netIncome: null,
      eps: null,
      ebit: null,
      otherIncome: null,
    });
  }

  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr)
      .find("td, th")
      .map((__, td) => $(td).text().trim())
      .get();
    if (cells.length < 2) return;

    const label = cells[0]?.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase() || "";
    let field: keyof Pick<QuarterPoint, "revenue" | "netIncome" | "eps" | "ebit" | "otherIncome"> | null =
      null;
    if (label.startsWith("sales")) field = "revenue";
    else if (label.startsWith("net profit")) field = "netIncome";
    else if (label.startsWith("eps")) field = "eps";
    else if (label.startsWith("operating profit")) field = "ebit";
    else if (label.startsWith("other income")) field = "otherIncome";
    if (!field) return;

    for (const p of periods) {
      const val = parseNum(cells[p.idx] || "");
      if (val == null) continue;
      const point = byDate.get(p.date);
      if (point) point[field] = val;
    }
  });

  return trimReportedQuarters(
    [...byDate.values()].filter(
      (q) => q.revenue != null || q.netIncome != null || q.eps != null,
    ),
  );
}
