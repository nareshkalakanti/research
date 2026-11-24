/**
 * Current (trailing-12-month) EPS from reported figures only: stored TTM,
 * the last four Screener quarters, then Yahoo's reported trailing EPS.
 * Never derived from price ÷ P/E.
 */
import type { QuarterPoint } from "@/lib/quarter-panel";
import { openSqliteNamed } from "@/lib/sqlite-utils";
import { trailingYear } from "@/lib/ttm";
import { fetchQuoteEpsTtm } from "@/lib/yfinance";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Latest quarter must have ended within this many days. */
export const TTM_MAX_AGE_DAYS = 300;
/** First-to-last end date for four consecutive quarters is about 273 days. */
const TTM_SPAN_DAYS = { min: 250, max: 300 };

export type CurrentEpsSource = "stored_ttm" | "screener_quarters" | "yahoo_ttm";

export const CURRENT_EPS_SOURCE_LABEL: Record<CurrentEpsSource, string> = {
  stored_ttm: "Stored TTM",
  screener_quarters: "Screener, last 4 quarters",
  yahoo_ttm: "Yahoo, trailing 12 months",
};

/** Sum of the last four reported quarterly EPS, when they are consecutive and recent. */
export function ttmEpsFromQuarters(
  quarters: readonly Pick<QuarterPoint, "date" | "eps">[],
  now = Date.now(),
): number | null {
  const reported = quarters
    .filter((q) => typeof q.eps === "number" && Number.isFinite(q.eps) && q.date)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (reported.length < 4) return null;
  const last4 = reported.slice(-4);
  const first = Date.parse(last4[0]!.date);
  const last = Date.parse(last4[3]!.date);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const span = (last - first) / DAY_MS;
  if (span < TTM_SPAN_DAYS.min || span > TTM_SPAN_DAYS.max) return null;
  if ((now - last) / DAY_MS > TTM_MAX_AGE_DAYS) return null;
  const sum = last4.reduce((acc, q) => acc + (q.eps as number), 0);
  return Math.round(sum * 100) / 100;
}

function cachedQuarters(ticker: string): QuarterPoint[] {
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      const row = db
        .prepare(`SELECT quarters_json FROM screener_quarters_cache WHERE ticker = ?`)
        .get(ticker.toUpperCase()) as { quarters_json: string } | undefined;
      const parsed = row ? (JSON.parse(row.quarters_json) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as QuarterPoint[]) : [];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export async function resolveCurrentEps(input: {
  ticker: string;
  market?: string | null;
  storedTtm?: number | null;
}): Promise<{ eps: number | null; source: CurrentEpsSource | null; price: number | null }> {
  if (input.storedTtm != null && Number.isFinite(input.storedTtm)) {
    return { eps: input.storedTtm, source: "stored_ttm", price: null };
  }
  const fromQuarters = ttmEpsFromQuarters(cachedQuarters(input.ticker));
  if (fromQuarters != null) {
    return { eps: fromQuarters, source: "screener_quarters", price: null };
  }
  const yahoo = await fetchQuoteEpsTtm(input.ticker, input.market);
  if (yahoo.eps != null) return { eps: yahoo.eps, source: "yahoo_ttm", price: yahoo.price };
  return { eps: null, source: null, price: yahoo.price };
}

/** Latest year with an EPS figure, and that same year's profit (₹ Cr). */
export function latestAnnualEpsPat(
  pl: { dates: string[]; eps: Array<number | null>; pat: Array<number | null> } | null | undefined,
): { eps: number | null; pat: number | null } {
  if (pl)
    for (let i = pl.dates.length - 1; i >= 0; i--) {
      const e = pl.eps[i];
      if (e != null && Number.isFinite(e)) {
        const p = pl.pat[i];
        return { eps: e, pat: p != null && Number.isFinite(p) ? p : null };
      }
    }
  return { eps: null, pat: null };
}

export type EpsPickSource = "screener_quarters" | "quarter_profit" | "yahoo_ttm" | "annual";

export const EPS_PICK_LABEL: Record<EpsPickSource, string> = {
  screener_quarters: "last 4 quarters (Screener EPS)",
  quarter_profit: "last 4 quarters' profit ÷ shares",
  yahoo_ttm: "Yahoo, trailing 12 months",
  annual: "latest annual EPS",
};

/**
 * One current-EPS rule for Napkin (headline P/E, PEG) and the score (Graham,
 * intrinsic value):
 *   1. sum of the last 4 quarters' (or 2 half-years') EPS — unless it is more
 *      than 1.5× off the profit-based figure (quarterly EPS not adjusted for a
 *      bonus / split);
 *   2. last 12 months' profit ÷ shares, with shares = latest annual profit ÷
 *      annual EPS (so minority interest cancels, as in reported EPS);
 *   3. Yahoo's trailing EPS, only when within 0.5–2× of the latest annual EPS;
 *   4. latest annual EPS.
 * Quarterly profit may be in rupees (NSE/Yahoo series): any sales of ₹1 Cr+
 * written as a rupee amount (≥ 1e7) marks the series as rupees.
 */
export function pickCurrentEps(input: {
  quarters: ReadonlyArray<{ date: string; eps?: number | null; netIncome?: number | null; revenue?: number | null }>;
  annualEps: number | null | undefined;
  annualPat: number | null | undefined;
  yahooTtm?: number | null;
  now?: number;
}): { eps: number | null; source: EpsPickSource | null; rejected_yahoo: number | null } {
  const now = input.now ?? Date.now();
  const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
  const annualEps = fin(input.annualEps) ? input.annualEps : null;
  const annualPat = fin(input.annualPat) ? input.annualPat : null;
  const rupees = input.quarters.some((q) => fin(q.revenue) && Math.abs(q.revenue) >= 1e7);
  const qs = input.quarters.map((q) => ({
    date: q.date,
    eps: fin(q.eps) ? q.eps : null,
    np: fin(q.netIncome) ? (rupees ? q.netIncome / 1e7 : q.netIncome) : null,
  }));
  const round = (v: number) => Math.round(v * 100) / 100;

  const shares = annualEps != null && annualPat != null && annualEps > 0 && annualPat > 0 ? annualPat / annualEps : null;
  const npYear = trailingYear(qs, now, (q) => q.np != null);
  const fromProfit = npYear && shares ? round(npYear.reduce((a, q) => a + q.np!, 0) / shares) : null;
  const epsYear = trailingYear(qs, now, (q) => q.eps != null);
  const fromEps = epsYear ? round(epsYear.reduce((a, q) => a + q.eps!, 0)) : null;

  if (fromEps != null) {
    const off =
      fromProfit != null && fromProfit > 0 && fromEps > 0 && (fromEps / fromProfit > 1.5 || fromProfit / fromEps > 1.5);
    if (!off) return { eps: fromEps, source: "screener_quarters", rejected_yahoo: null };
  }
  if (fromProfit != null) return { eps: fromProfit, source: "quarter_profit", rejected_yahoo: null };
  const y = fin(input.yahooTtm) ? input.yahooTtm : null;
  if (y != null) {
    const fits = annualEps == null || annualEps <= 0 || y <= 0 || (y / annualEps >= 0.5 && y / annualEps <= 2);
    if (fits) return { eps: y, source: "yahoo_ttm", rejected_yahoo: null };
    return { eps: annualEps, source: "annual", rejected_yahoo: y };
  }
  return annualEps != null ? { eps: annualEps, source: "annual", rejected_yahoo: null } : { eps: null, source: null, rejected_yahoo: null };
}
