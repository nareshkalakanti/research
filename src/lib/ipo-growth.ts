import { IPO2_RULES } from "./ipo2-bases";
import { openSqliteNamed } from "./sqlite-utils";

/** Quarterly growth reads for IPO2 (saved Screener quarters in metrics.db; read only). */
export type Growth = { sales_yoy: number | null; np_yoy: number | null; quarter: string | null; stale: boolean };

const r1 = (n: number) => Math.round(n * 10) / 10;

export type Quarter = { date: string; revenue: number | null; netIncome: number | null };

/**
 * Growth in the initial quarters (IPO V2.0: "high growth sales / earning numbers in the initial quarters"):
 * the first 4 quarters ending after the listing date, each vs the same quarter a year earlier.
 * ok = sales and profit both up 20%+ in most of the quarters that can be compared.
 */
export type EarlyGrowth = {
  quarters: Array<{ quarter: string; sales_yoy: number | null; np_yoy: number | null }>;
  /** Quarters with both sales and profit up growthPct+. */
  strong: number;
  /** Quarters that could be compared (a year-ago quarter saved). */
  measured: number;
  ok: boolean | null;
};

const yoyOf = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && b > 0 && a / b < 100 && a / b > 0.01 ? r1((a / b - 1) * 100) : null;
const monthIdx = (s: string) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7));

export function earlyGrowth(qs: Quarter[], listing: string): EarlyGrowth | null {
  const after = qs.filter((q) => q.date > listing).slice(0, 4);
  if (!after.length) return null;
  const rows = after.map((q) => {
    const prev = qs.find((x) => Math.abs(monthIdx(q.date) - monthIdx(x.date) - 12) <= 1);
    return { quarter: q.date.slice(0, 7), sales_yoy: yoyOf(q.revenue, prev?.revenue), np_yoy: yoyOf(q.netIncome, prev?.netIncome) };
  });
  const m = rows.filter((r) => r.sales_yoy != null && r.np_yoy != null);
  const strong = m.filter((r) => r.sales_yoy! >= IPO2_RULES.growthPct && r.np_yoy! >= IPO2_RULES.growthPct).length;
  return { quarters: rows, strong, measured: m.length, ok: m.length ? strong * 2 > m.length : null };
}

/** Saved Screener quarters per ticker, oldest first. */
export function savedQuarters(): Map<string, Quarter[]> {
  const out = new Map<string, Quarter[]>();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    for (const r of db.prepare(`SELECT UPPER(ticker) AS t, quarters_json AS j FROM screener_quarters_cache`).all() as Array<{ t: string; j: string }>) {
      try {
        out.set(
          r.t,
          (JSON.parse(r.j) as Quarter[]).filter((q) => q.date).sort((a, b) => a.date.localeCompare(b.date)),
        );
      } catch {
        /* bad row */
      }
    }
  } finally {
    db.close();
  }
  return out;
}

/** Latest quarter vs the same quarter a year earlier (Screener quarters). */
export function latestGrowth(qs: Quarter[] | undefined): Growth | null {
  const q = qs?.[qs.length - 1];
  if (!qs || !q) return null;
  const cut = new Date();
  cut.setUTCMonth(cut.getUTCMonth() - IPO2_RULES.growthMaxAgeMonths);
  const quarter = q.date.slice(0, 7);
  // Too old to say anything about growth now.
  if (quarter < cut.toISOString().slice(0, 7)) return { sales_yoy: null, np_yoy: null, quarter, stale: true };
  const prev = qs.find((x) => Math.abs(monthIdx(q.date) - monthIdx(x.date) - 12) <= 1);
  return { sales_yoy: yoyOf(q.revenue, prev?.revenue), np_yoy: yoyOf(q.netIncome, prev?.netIncome), quarter, stale: false };
}


/** One ticker's saved quarters, oldest first. */
export function quartersFor(ticker: string): Quarter[] | null {
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const r = db.prepare(`SELECT quarters_json AS j FROM screener_quarters_cache WHERE UPPER(ticker) = ?`).get(ticker.toUpperCase()) as
      | { j: string }
      | undefined;
    if (!r) return null;
    return (JSON.parse(r.j) as Quarter[]).filter((q) => q.date).sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return null;
  } finally {
    db.close();
  }
}
