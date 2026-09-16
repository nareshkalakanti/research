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

function seriesField(title: string): "revenue" | "netIncome" | null {
  const t = title.trim().toLowerCase();
  if (t === "revenue" || t === "sales" || t === "income") return "revenue";
  if (t === "profit" || t === "net profit" || t === "pat") return "netIncome";
  return null;
}

function statementRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const rec = asRecord(raw);
  if (Array.isArray(rec.CONSOLIDATED)) return rec.CONSOLIDATED;
  if (Array.isArray(rec.consolidated)) return rec.consolidated;
  if (Array.isArray(rec.STANDALONE)) return rec.STANDALONE;
  return [];
}

export function parseGrowwFinancialStatement(company: Record<string, unknown>): QuarterPoint[] {
  const rows = statementRows(company.financialStatementV2);
  const fallback = asArray(company.financialStatement);
  const series = rows.length ? rows : fallback;
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

export async function fetchGrowwQuarterlyFundamentals(
  ticker: string,
  companyName?: string | null,
): Promise<QuarterPoint[]> {
  const key = ticker.trim().toUpperCase();
  if (!key) return [];
  try {
    const data = await growwCompanyData(key, (companyName || key).trim());
    if (!data) return [];
    return parseGrowwFinancialStatement(data.company);
  } catch {
    return [];
  }
}
