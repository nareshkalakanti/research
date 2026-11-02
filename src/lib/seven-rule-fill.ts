/**
 * Slow ROE/ROCE fill for Scan 7-Rule.
 *
 * Screener blocks aggressive batches — this path is serial, long-gapped,
 * Tickertape-first, and stops early when Screener is paused.
 */
import { loadAllCompanies } from "./db";
import {
  FUND_WATCHLIST_KEYS,
  type FundFilterState,
  type FundWatchlistKey,
} from "./fund-watchlist-meta";
import { activeFundFilterSet, fundWatchlistAllTickers } from "./fund-watchlists";
import { edgeTickerSet } from "./edge";
import { holdingsTickerSet } from "./holdings";
import { notesTickerSet } from "./notes";
import { isAgeAtLeast } from "./company-age";
import { filterCompaniesByScanList } from "./scan-lists-server";
import {
  fetchScreenerTopRatios,
  loadScreenerRatiosMap,
} from "./screener-ratios";
import {
  ScreenerPausedError,
  screenerPausedUntil,
} from "./screener-fetch";
import { loadTickertapeRatiosMap, writeTickertapeRatiosCache } from "./tickertape-ratios-cache";
import { tickertapeStockRatios } from "./web-mcap";
import { openSqliteNamed } from "./sqlite-utils";
import { invalidateSevenRuleScanCache } from "./seven-rule-scan";
import type { CapTier } from "./types";
import { capTier } from "./types";

/** Extra pause after each ticker (on top of Screener's own 2.5–5s gap). */
const EXTRA_GAP_MS = 12_000;
const EXTRA_JITTER_MS = 8_000;

export type SevenRuleFillResult = {
  tried: number;
  saved: number;
  failed: number;
  remaining: number;
  saved_tickers: string[];
  done: boolean;
  paused?: boolean;
  paused_until?: string | null;
  message?: string;
};

export type SevenRuleFillSelection = {
  cap?: CapTier | "All";
  hold?: boolean;
  edge?: boolean;
  sme?: boolean;
  note?: boolean;
  ageMin?: number | null;
  age25?: boolean;
  funds?: FundFilterState;
  fundAll?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hasRoeRoce(ticker: string): boolean {
  const t = ticker.toUpperCase();
  const s = loadScreenerRatiosMap().get(t);
  const tape = loadTickertapeRatiosMap().get(t);
  const roe = s?.roe ?? tape?.roe ?? null;
  const roce = s?.roce ?? tape?.roce ?? null;
  return roe != null || roce != null;
}

function hasUsableQuarters(ticker: string): boolean {
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      const row = db
        .prepare(
          `SELECT quarters_json FROM screener_quarters_cache WHERE ticker = ?`,
        )
        .get(ticker.toUpperCase()) as { quarters_json: string } | undefined;
      if (!row?.quarters_json) return false;
      const qs = JSON.parse(row.quarters_json) as unknown[];
      return Array.isArray(qs) && qs.length >= 4;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function applySelectionFilters<
  T extends {
    ticker: string;
    market: string;
    mcap_cr?: number | null;
    founded_year?: string | null;
  },
>(pool: T[], selection: SevenRuleFillSelection): T[] {
  let out = pool;
  if (selection.cap && selection.cap !== "All") {
    out = out.filter((c) => capTier(c.mcap_cr ?? null) === selection.cap);
  }
  if (selection.hold) {
    const hold = holdingsTickerSet();
    out = out.filter((c) => hold.has(c.ticker.toUpperCase()));
  }
  if (selection.edge) {
    const edge = edgeTickerSet();
    out = out.filter((c) => edge.has(c.ticker.toUpperCase()));
  }
  if (selection.sme) {
    out = out.filter((c) => /\bSME\b/i.test(c.market || ""));
  }
  if (selection.note) {
    const notes = notesTickerSet();
    out = out.filter((c) => notes.has(c.ticker.toUpperCase()));
  }
  const ageMin =
    selection.ageMin ?? (selection.age25 === true ? 25 : null);
  if (ageMin != null) {
    out = out.filter((c) => isAgeAtLeast(c.founded_year, ageMin));
  }
  if (selection.fundAll) {
    const all = fundWatchlistAllTickers();
    out = out.filter((c) => all.has(c.ticker.toUpperCase()));
  } else {
    const fundSet = activeFundFilterSet(selection.funds ?? {});
    if (fundSet) {
      out = out.filter((c) => fundSet.has(c.ticker.toUpperCase()));
    }
  }
  return out;
}

export function hasSevenRuleFillSelection(
  selection: SevenRuleFillSelection | null | undefined,
): boolean {
  if (!selection) return false;
  if (selection.cap && selection.cap !== "All") return true;
  if (selection.hold || selection.edge || selection.sme || selection.note) {
    return true;
  }
  if (selection.ageMin != null || selection.age25) return true;
  if (selection.fundAll) return true;
  if (selection.funds) {
    for (const k of FUND_WATCHLIST_KEYS) {
      if (selection.funds[k as FundWatchlistKey]) return true;
    }
  }
  return false;
}

/** Tickers with quarters but missing ROE/ROCE — need slow ratio fill. */
export function pendingSevenRuleFillTickers(opts: {
  market?: string;
  tickers?: string[];
  selection?: SevenRuleFillSelection | null;
}): string[] {
  const all = loadAllCompanies();
  let pool = filterCompaniesByScanList(all, opts.market || "All", all);
  if (opts.selection && hasSevenRuleFillSelection(opts.selection)) {
    pool = applySelectionFilters(pool, opts.selection);
  }
  if (opts.tickers?.length) {
    const want = new Set(opts.tickers.map((t) => t.toUpperCase()));
    pool = pool.filter((c) => want.has(c.ticker.toUpperCase()));
  }
  const out: string[] = [];
  for (const c of pool) {
    const t = c.ticker.toUpperCase();
    if (!hasUsableQuarters(t)) continue;
    if (hasRoeRoce(t)) continue;
    out.push(t);
  }
  return out.sort();
}

async function fillOneRatio(
  ticker: string,
  name: string,
): Promise<"saved" | "failed" | "paused"> {
  // Tickertape first — avoid Screener when possible.
  try {
    const tape = await tickertapeStockRatios(ticker, name);
    if (tape && (tape.roe != null || tape.roce != null)) {
      writeTickertapeRatiosCache(ticker, tape);
      if (tape.roe != null && tape.roce != null) return "saved";
    }
  } catch {
    /* try Screener */
  }

  const paused = screenerPausedUntil();
  if (paused) return "paused";

  try {
    const ratios = await fetchScreenerTopRatios(ticker);
    if (ratios.roe != null || ratios.roce != null) return "saved";
    return "failed";
  } catch (e) {
    if (e instanceof ScreenerPausedError) return "paused";
    const msg = e instanceof Error ? e.message : String(e);
    if (/paused until|Screener blocked/i.test(msg)) return "paused";
    return "failed";
  }
}

export async function runSevenRuleFillBatch(opts: {
  market?: string;
  tickers?: string[];
  selection?: SevenRuleFillSelection | null;
  limit?: number;
}): Promise<SevenRuleFillResult> {
  // Tiny batches — Screener blocks if we rush.
  const limit = Math.min(5, Math.max(1, opts.limit ?? 3));
  const scopeOpts = {
    market: opts.market,
    tickers: opts.tickers,
    selection: opts.selection,
  };

  const pausedUntil = screenerPausedUntil();
  if (pausedUntil) {
    const remaining = pendingSevenRuleFillTickers(scopeOpts).length;
    return {
      tried: 0,
      saved: 0,
      failed: 0,
      remaining,
      saved_tickers: [],
      done: remaining === 0,
      paused: true,
      paused_until: pausedUntil,
      message: `Screener paused until ${pausedUntil} · ${remaining.toLocaleString()} left`,
    };
  }

  const pending = pendingSevenRuleFillTickers(scopeOpts);
  const batch = pending.slice(0, limit);
  if (!batch.length) {
    return {
      tried: 0,
      saved: 0,
      failed: 0,
      remaining: 0,
      saved_tickers: [],
      done: true,
      message: "7-Rule ROE/ROCE coverage complete for this pool",
    };
  }

  const nameByTicker = new Map(
    loadAllCompanies().map((c) => [c.ticker.toUpperCase(), c.name || ""]),
  );

  const savedTickers: string[] = [];
  let failed = 0;
  let paused = false;
  let pausedAt: string | null = null;

  for (let i = 0; i < batch.length; i++) {
    const ticker = batch[i]!;
    const status = await fillOneRatio(
      ticker,
      nameByTicker.get(ticker) || ticker,
    );
    if (status === "saved") savedTickers.push(ticker);
    else if (status === "failed") failed += 1;
    else {
      paused = true;
      pausedAt = screenerPausedUntil();
      break;
    }
    // Always wait between names — even Tickertape-only — so Screener stays cold.
    if (i < batch.length - 1 && !paused) {
      const wait = EXTRA_GAP_MS + Math.random() * EXTRA_JITTER_MS;
      await sleep(wait);
    }
  }

  invalidateSevenRuleScanCache();
  // Clear in-memory Screener ratios map so next score sees writes.
  // loadScreenerRatiosMap has its own TTL; force rebuild via invalidate.
  const remaining = pendingSevenRuleFillTickers(scopeOpts).length;

  return {
    tried: savedTickers.length + failed + (paused ? 1 : 0),
    saved: savedTickers.length,
    failed,
    remaining,
    saved_tickers: savedTickers,
    done: remaining === 0 && !paused,
    paused,
    paused_until: pausedAt,
    message: paused
      ? `Paused Screener · +${savedTickers.length} · ${remaining.toLocaleString()} left`
      : `Filled ${savedTickers.length} · ${failed} failed · ${remaining.toLocaleString()} left`,
  };
}
