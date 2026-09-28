/**
 * Groww company JSON quarterly P&L — backup when Yahoo/NSE/BSE/Screener are thin.
 * Amounts on Groww are already ₹ Cr.
 */
import type { QuarterPoint } from "./quarter-panel";
import { trimReportedQuarters } from "./quarter-panel";
import { growwCompanyData } from "./web-mcap";

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

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Groww labels like `Jun '26` → period-end YYYY-MM-DD. */
export function parseGrowwQuarterLabel(label: string): string | null {
  const m = label
    .trim()
    .match(/^([A-Za-z]{3})\s+'?(\d{2})$/);
  if (!m) return null;
  const mon = m[1]!.toUpperCase();
  const mm = MONTH_NUM[mon];
  if (!mm) return null;
  const yy = Number(m[2]);
  if (!Number.isFinite(yy)) return null;
  const year = yy >= 80 ? 1900 + yy : 2000 + yy;
  const day = MONTH_END[mon] ?? 28;
  return `${year}-${mm}-${String(day).padStart(2, "0")}`;
}

function seriesField(title: string): "revenue" | "netIncome" | "eps" | "ebit" | null {
  const t = title.trim().toLowerCase();
  if (t === "revenue" || t === "sales" || t === "income") return "revenue";
  if (t === "profit" || t === "net profit" || t === "pat") return "netIncome";
  if (t === "eps" || t === "earnings per share") return "eps";
  if (
    t === "operating profit" ||
    t === "ebit" ||
    t === "ebitda" ||
    t === "op"
  ) {
    return "ebit";
  }
  return null;
}

function quarterlyKeyCount(rows: unknown[]): number {
  let n = 0;
  for (const item of rows) {
    n += Object.keys(asRecord(asRecord(item).quarterly)).length;
  }
  return n;
}

function statementRows(raw: unknown, fallback: unknown[]): unknown[] {
  const rec = asRecord(raw);
  const candidates = [
    asArray(rec.CONSOLIDATED),
    asArray(rec.consolidated),
    asArray(rec.STANDALONE),
    asArray(rec.standalone),
    Array.isArray(raw) ? raw : [],
    fallback,
  ];
  let best: unknown[] = [];
  let bestN = -1;
  for (const rows of candidates) {
    const n = quarterlyKeyCount(rows);
    if (n > bestN) {
      bestN = n;
      best = rows;
    }
  }
  return bestN > 0 ? best : fallback;
}

export function parseGrowwFinancialStatement(company: Record<string, unknown>): QuarterPoint[] {
  const fallback = asArray(company.financialStatement);
  const series = statementRows(company.financialStatementV2, fallback);
  const byDate = new Map<string, QuarterPoint>();

  for (const item of series) {
    const rec = asRecord(item);
    const field = seriesField(str(rec.title));
    if (!field) continue;
    const quarterly = asRecord(rec.quarterly);
    for (const [label, value] of Object.entries(quarterly)) {
      const date = parseGrowwQuarterLabel(label);
      const n = num(value);
      if (!date || n == null) continue;
      const prev = byDate.get(date) ?? {
        date,
        revenue: null,
        ebit: null,
        netIncome: null,
        eps: null,
      };
      prev[field] = n;
      byDate.set(date, prev);
    }
  }

  return trimReportedQuarters(
    [...byDate.values()].filter(
      (q) => q.revenue != null || q.netIncome != null,
    ),
  );
}

function fundLabel(item: Record<string, unknown>): string {
  return `${str(item.name)} ${str(item.shortName)}`.toLowerCase();
}

function fundNumber(item: Record<string, unknown>): number | null {
  const raw = item.value;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const text = str(raw).replace(/₹/g, "").replace(/%/g, "").replace(/,/g, "").trim();
  if (!text) return null;
  const m = text.match(/-?[0-9]+(?:\.[0-9]+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Groww header fundamentals — TTM PE / EPS when quarterly EPS is missing. */
export function parseGrowwTtmValuation(company: Record<string, unknown>): {
  pe_ttm: number | null;
  eps_ttm: number | null;
} {
  let pe_ttm: number | null = null;
  let eps_ttm: number | null = null;
  for (const item of asArray(company.fundamentals)) {
    const rec = asRecord(item);
    const label = fundLabel(rec);
    const n = fundNumber(rec);
    if (n == null) continue;
    if (/p\s*\/\s*e|pe ratio/.test(label) && !/industry/.test(label)) {
      pe_ttm = n;
    } else if (/\beps\b/.test(label)) {
      eps_ttm = n;
    }
  }
  return { pe_ttm, eps_ttm };
}

export async function fetchGrowwQuarterlyFundamentals(
  ticker: string,
  companyName?: string | null,
): Promise<QuarterPoint[]> {
  const hit = await fetchGrowwPeadFill(ticker, companyName);
  return hit?.quarters ?? [];
}

export async function fetchGrowwPeadFill(
  ticker: string,
  companyName?: string | null,
): Promise<{
  quarters: QuarterPoint[];
  pe_ttm: number | null;
  eps_ttm: number | null;
} | null> {
  const key = ticker.trim().toUpperCase();
  if (!key) return null;
  try {
    const data = await growwCompanyData(key, (companyName || key).trim());
    if (!data) return null;
    const ttm = parseGrowwTtmValuation(data.company);
    return {
      quarters: parseGrowwFinancialStatement(data.company),
      pe_ttm: ttm.pe_ttm,
      eps_ttm: ttm.eps_ttm,
    };
  } catch {
    return null;
  }
}
