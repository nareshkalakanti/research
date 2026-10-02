/**
 * Current (trailing-12-month) EPS from reported figures only: stored TTM,
 * the last four Screener quarters, then Yahoo's reported trailing EPS.
 * Never derived from price ÷ P/E.
 */
import type { QuarterPoint } from "@/lib/quarter-panel";
import { openSqliteNamed } from "@/lib/sqlite-utils";
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
