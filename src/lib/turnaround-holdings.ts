/**
 * Turnaround / distressed holdings — overlap of personal holdings with
 * stocks-ai distress seed monitor (8 names in current portfolio).
 */
import { loadHoldings, type HoldingRow } from "@/lib/holdings";

/** Distress turnaround seed tickers (stocks-ai load_distress_seed_tickers). */
export const TURNAROUND_SEED_TICKERS = [
  "ATAM",
  "BPL",
  "DGCONTENT",
  "GPTINFRA",
  "HMT",
  "LOKESHMACH",
  "MIRCELECTR",
  "TEAMGTY",
] as const;

export type TurnaroundHolding = HoldingRow & {
  yahoo_symbol: string;
};

function toYahooSymbol(ticker: string, market: string): string {
  const t = ticker.trim().toUpperCase();
  if (t.endsWith(".NS") || t.endsWith(".BO")) return t;
  const mk = (market || "").toUpperCase();
  if (mk.includes("SME") || mk.includes("EMERGE")) return `${t}-SM.NS`;
  if (mk === "BSE") return `${t}.BO`;
  return `${t}.NS`;
}

/** Holdings that match the turnaround seed list. */
export function loadTurnaroundHoldings(): TurnaroundHolding[] {
  const seed = new Set(TURNAROUND_SEED_TICKERS.map((t) => t.toUpperCase()));
  return loadHoldings()
    .filter((h) => seed.has(h.ticker.toUpperCase()))
    .map((h) => ({
      ...h,
      yahoo_symbol: toYahooSymbol(h.ticker, h.market),
    }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function turnaroundScanSymbols(): string[] {
  return loadTurnaroundHoldings().map((h) => h.yahoo_symbol);
}

export function turnaroundSeedNotInHoldings(): string[] {
  const held = new Set(loadHoldings().map((h) => h.ticker.toUpperCase()));
  return TURNAROUND_SEED_TICKERS.filter((t) => !held.has(t));
}
