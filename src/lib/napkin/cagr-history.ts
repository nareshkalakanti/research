import type { ScreenerAnnualPl } from "@/lib/screener-annual";
import type { GrowwAnnualPoint } from "@/lib/groww-quarters";

export function fiscalYearLabel(raw: string): string | null {
  const m = String(raw || "").match(/(19|20)\d{2}/);
  return m ? m[0] : null;
}

export function alignedYearPairs(
  dates: string[],
  values: Array<number | null | undefined>,
): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const n = Math.min(dates.length, values.length);
  for (let i = 0; i < n; i++) {
    const y = fiscalYearLabel(dates[i] || "");
    const v = values[i];
    if (!y || v == null || !Number.isFinite(v)) continue;
    out.push([y, v]);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}

export function screenerPlPairs(pl: ScreenerAnnualPl): {
  revenue: Array<[string, number]>;
  profit: Array<[string, number]>;
  eps: Array<[string, number]>;
} {
  return {
    revenue: alignedYearPairs(pl.dates, pl.revenue),
    profit: alignedYearPairs(pl.dates, pl.pat),
    eps: alignedYearPairs(pl.dates, pl.eps),
  };
}

export function growwAnnualPairs(rows: GrowwAnnualPoint[]): {
  revenue: Array<[string, number]>;
  profit: Array<[string, number]>;
  eps: Array<[string, number]>;
} {
  const revenue: Array<[string, number]> = [];
  const profit: Array<[string, number]> = [];
  const eps: Array<[string, number]> = [];
  for (const r of rows) {
    if (r.revenue != null) revenue.push([r.year, r.revenue]);
    if (r.netIncome != null) profit.push([r.year, r.netIncome]);
    if (r.eps != null) eps.push([r.year, r.eps]);
  }
  return { revenue, profit, eps };
}
