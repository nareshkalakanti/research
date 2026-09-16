/**
 * BSE quarterly results — TabResults_PAR API (official BSE stock page tab).
 */
import type { QuarterPoint } from "./quarter-panel";
import { trimReportedQuarters } from "./quarter-panel";
import { BSE_HEADERS, loadBseSmeCacheMap } from "./bse-sme";
import { cacheBseScripCode, resolveBseScripCode } from "./bse-investor-discover";
import { growwCompanyData } from "./web-mcap";

const RESULTS_API =
  "https://api.bseindia.com/BseIndiaAPI/api/TabResults_PAR/w";

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

type BseResultsRow = {
  title?: string;
  v1?: string | number | null;
  v2?: string | number | null;
  v3?: string | number | null;
};

type BseResultsJson = {
  col1?: string;
  col2?: string;
  col3?: string;
  col4?: string;
  resultinCr?: BseResultsRow[];
};

function num(v: unknown): number | null {
  if (v == null || v === "" || v === "-") return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function parsePeriodEnd(label: string): string | null {
  const m = label.trim().match(/^([A-Za-z]{3})-(\d{2})$/);
  if (!m) return null;
  const mon = m[1]!.toUpperCase();
  const day = MONTH_END[mon];
  const month = MONTH_NUM[mon];
  if (!day || !month) return null;
  const year = 2000 + Number(m[2]);
  return `${year}-${month}-${String(day).padStart(2, "0")}`;
}

function isQuarterPeriod(label: string): boolean {
  return /^[A-Za-z]{3}-\d{2}$/.test(label.trim());
}

function rowValue(
  rows: BseResultsRow[],
  titles: string | string[],
  key: "v1" | "v2" | "v3",
): number | null {
  const want = (Array.isArray(titles) ? titles : [titles]).map((t) =>
    t.trim().toLowerCase(),
  );
  for (const title of want) {
    const row = rows.find(
      (r) => String(r.title || "").trim().toLowerCase() === title,
    );
    const v = row ? num(row[key]) : null;
    if (v != null) return v;
  }
  return null;
}

function parseResultsPayload(raw: unknown): QuarterPoint[] {
  let json = raw;
  if (typeof json === "string") {
    try {
      json = JSON.parse(json) as unknown;
    } catch {
      return [];
    }
  }
  if (typeof json === "string") {
    try {
      json = JSON.parse(json) as unknown;
    } catch {
      return [];
    }
  }
  const data = json as BseResultsJson;
  const rows = data.resultinCr ?? [];
  if (!rows.length) return [];

  const periods: Array<{ label: string; key: "v1" | "v2" | "v3" }> = [];
  if (isQuarterPeriod(data.col2 || "")) periods.push({ label: data.col2!, key: "v1" });
  if (isQuarterPeriod(data.col3 || "")) periods.push({ label: data.col3!, key: "v2" });
  if (isQuarterPeriod(data.col4 || "")) periods.push({ label: data.col4!, key: "v3" });

  const out: QuarterPoint[] = [];
  for (const p of periods) {
    const date = parsePeriodEnd(p.label);
    if (!date) continue;
    const revenue = rowValue(rows, ["Revenue", "Sales", "Net Sales"], p.key);
    const netIncome = rowValue(
      rows,
      ["Net Profit", "Profit After Tax", "PAT"],
      p.key,
    );
    const eps = rowValue(rows, ["EPS", "Basic EPS"], p.key);
    const opm = rowValue(rows, ["OPM %", "OPM"], p.key);
    const ebit =
      revenue != null && opm != null
        ? Math.round(((revenue * opm) / 100) * 100) / 100
        : null;
    if (revenue == null && netIncome == null && eps == null) continue;
    out.push({ date, revenue, netIncome, eps, ebit });
  }

  return trimReportedQuarters(out);
}

/** Fetch quarterly P&L for a BSE scrip code. */
export async function fetchBseQuarterlyFundamentals(
  scripCode: string,
): Promise<QuarterPoint[]> {
  const code = scripCode.trim();
  if (!code) return [];
  const url = `${RESULTS_API}?scripcode=${encodeURIComponent(code)}&tabtype=RESULTS`;
  try {
    const res = await fetch(url, { headers: BSE_HEADERS });
    if (!res.ok) return [];
    const json = (await res.json()) as unknown;
    return parseResultsPayload(json);
  } catch {
    return [];
  }
}

/** Resolve ticker → BSE scrip code, then fetch quarters. */
export async function fetchBseQuarterlyByTicker(
  ticker: string,
): Promise<QuarterPoint[]> {
  const key = ticker.toUpperCase();
  // Prefer live/cached scrip (company_bse_scrip) — SME list JSON is often absent.
  let code =
    resolveBseScripCode(key, null) ||
    loadBseSmeCacheMap().get(key)?.scrip_code?.trim() ||
    null;
  if (!code) {
    try {
      const groww = await growwCompanyData(key, key);
      const bse = String(groww?.hit.bse_scrip_code || "").trim();
      if (/^\d{4,8}$/.test(bse)) {
        cacheBseScripCode(key, bse);
        code = bse;
      }
    } catch {
      /* Groww scrip lookup is optional */
    }
  }
  if (!code) return [];
  return fetchBseQuarterlyFundamentals(code);
}
