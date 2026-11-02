/**
 * Scan 7-Rule universe from cached quarters + ROE/ROCE ratios (no live I/O).
 */
import {
  buildQuarterPanel,
  type QuarterPoint,
} from "./quarter-panel";
import {
  sevenRuleFromPanel,
  type SevenRuleRating,
  type SevenRuleResult,
} from "./seven-rule-score";
import { loadScreenerRatiosMap } from "./screener-ratios";
import { loadTickertapeRatiosMap } from "./tickertape-ratios-cache";
import { openSqliteNamed } from "./sqlite-utils";

export type SevenRuleScanRow = {
  ticker: string;
  score: number;
  passed: number;
  rating: SevenRuleRating | null;
  provisional: boolean;
  ratingLabel: string | null;
  roe: number | null;
  roce: number | null;
};

type Cache = {
  at: number;
  map: Map<string, SevenRuleScanRow>;
  /** Deep-dive+ and fully evaluated (passed ≥ 5, not provisional). */
  pass: Set<string>;
  /** Any scored ticker (including provisional / low pass). */
  scored: Set<string>;
};

let cache: Cache | null = null;
const CACHE_MS = 60_000;

type QuarterCacheRow = {
  ticker: string;
  quarters_json: string;
};

function loadQuartersMap(): Map<string, QuarterPoint[]> {
  const out = new Map<string, QuarterPoint[]>();
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      const rows = db
        .prepare(`SELECT ticker, quarters_json FROM screener_quarters_cache`)
        .all() as QuarterCacheRow[];
      for (const row of rows) {
        try {
          const qs = JSON.parse(row.quarters_json) as QuarterPoint[];
          if (Array.isArray(qs) && qs.length >= 2) {
            out.set(row.ticker.toUpperCase(), qs);
          }
        } catch {
          /* skip */
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* missing db */
  }
  return out;
}

function resolveRoeRoce(ticker: string): {
  roe: number | null;
  roce: number | null;
} {
  const t = ticker.toUpperCase();
  const screener = loadScreenerRatiosMap().get(t);
  const tape = loadTickertapeRatiosMap().get(t);
  return {
    roe: screener?.roe ?? tape?.roe ?? null,
    roce: screener?.roce ?? tape?.roce ?? null,
  };
}

function toScanRow(
  ticker: string,
  result: SevenRuleResult,
  roe: number | null,
  roce: number | null,
): SevenRuleScanRow {
  return {
    ticker,
    score: result.score,
    passed: result.passed,
    rating: result.rating,
    provisional: result.provisional,
    ratingLabel: result.ratingLabel,
    roe,
    roce,
  };
}

function rebuild(): Cache {
  const map = new Map<string, SevenRuleScanRow>();
  const pass = new Set<string>();
  const scored = new Set<string>();
  const quarters = loadQuartersMap();
  for (const [ticker, qs] of quarters) {
    const panel = buildQuarterPanel(qs);
    if (!panel?.labels?.length) continue;
    const { roe, roce } = resolveRoeRoce(ticker);
    const result = sevenRuleFromPanel(panel, { roe, roce });
    if (!result) continue;
    const row = toScanRow(ticker, result, roe, roce);
    map.set(ticker, row);
    scored.add(ticker);
    if (!row.provisional && row.passed >= 5) pass.add(ticker);
  }
  return { at: Date.now(), map, pass, scored };
}

function getCache(): Cache {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache;
  cache = rebuild();
  return cache;
}

export function invalidateSevenRuleScanCache(): void {
  cache = null;
}

export function loadSevenRuleScanMap(): Map<string, SevenRuleScanRow> {
  return getCache().map;
}

/** Tickers that clear Deep Dive+ (passed ≥ 5, fully evaluated). */
export function sevenRulePassTickerSet(): Set<string> {
  return getCache().pass;
}

export function sevenRuleScoredTickerSet(): Set<string> {
  return getCache().scored;
}
