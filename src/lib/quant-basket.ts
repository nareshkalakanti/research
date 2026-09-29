/**
 * Scan · Basket: small-cap universe, factor score, sector-capped equal-weight book.
 * Point-in-time = latest cached prints (not a backtest).
 */
import { loadAllCompanies } from "./db";
import { loadQuarterOverlayMap } from "./fundamentals-scan";
import { isAgeAtLeast } from "./company-age";
import { boardIndependenceForTicker } from "./gov-independence";
import { QUANT_BASKET_CONFIG as cfg } from "./quant-basket-config";
import {
  combineWeighted,
  earningsYield,
  opmPct,
  opmStd,
  patCv,
  pickSectorCappedBook,
  zScores,
} from "./quant-basket-factors";

export type QuantBasketRow = {
  ticker: string;
  sector: string;
  eq: number | null;
  val: number | null;
  gov: number | null;
  score: number | null;
  rank: number | null;
  in_book: boolean;
  weight: number | null;
  opm_std: number | null;
  pat_cv: number | null;
  ebit_yield: number | null;
};

let cache: { at: number; map: Map<string, QuantBasketRow> } | null = null;
const CACHE_MS = 20_000;

function ttmEbit(
  quarters: Array<{ ebit?: number | null }>,
): number | null {
  const xs = quarters
    .map((q) => q.ebit)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (xs.length < 4) return null;
  return xs.slice(-4).reduce((s, v) => s + v, 0);
}

function govIndependenceRaw(ticker: string): number | null {
  const b = boardIndependenceForTicker(ticker);
  if (!b || b.total < 2) return null;
  if (b.family_control) return 0;
  return b.pct;
}

export function loadQuantBasketMap(): Map<string, QuantBasketRow> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.map;

  const overlay = loadQuarterOverlayMap();
  const look = cfg.earnings_quality.lookback_quarters;
  const minQ = cfg.earnings_quality.min_quarters;
  const candidates: Array<{
    ticker: string;
    sector: string;
    opm_std: number | null;
    pat_cv: number | null;
    ebit_yield: number | null;
    gov_raw: number | null;
  }> = [];

  for (const c of loadAllCompanies()) {
    const t = c.ticker.toUpperCase();
    const mcap = c.mcap_cr;
    if (mcap == null || !Number.isFinite(mcap)) continue;
    if (mcap < cfg.universe.mcap_min_cr || mcap > cfg.universe.mcap_max_cr) {
      continue;
    }
    if (!isAgeAtLeast(c.founded_year, cfg.universe.min_listing_years)) {
      continue;
    }
    const o = overlay.get(t);
    const qs = o?.quarters ?? [];
    const tail = qs.slice(-look);
    if (tail.length < minQ) continue;
    const opm = tail.map((q) => opmPct(q.revenue, q.ebit));
    const pats = tail.map((q) => q.netIncome ?? null);
    candidates.push({
      ticker: t,
      sector: (c.sector || "").trim() || "_",
      opm_std: opmStd(opm),
      pat_cv: patCv(pats),
      ebit_yield: earningsYield(ttmEbit(tail), mcap),
      gov_raw: govIndependenceRaw(t),
    });
  }

  const zOpm = zScores(candidates.map((r) => r.opm_std));
  const zPat = zScores(candidates.map((r) => r.pat_cv));
  const zGov = zScores(candidates.map((r) => r.gov_raw));
  const bySector = new Map<string, number[]>();
  candidates.forEach((r) => {
    if (r.ebit_yield == null) return;
    const arr = bySector.get(r.sector) ?? [];
    arr.push(r.ebit_yield);
    bySector.set(r.sector, arr);
  });
  const valPct: Array<number | null> = candidates.map((r) => {
    if (r.ebit_yield == null) return null;
    const xs = (bySector.get(r.sector) ?? []).slice().sort((a, b) => a - b);
    if (xs.length < 2) return null;
    const i = xs.findIndex((v) => v === r.ebit_yield);
    const pos = i < 0 ? xs.length - 1 : i;
    return pos / (xs.length - 1);
  });
  const zVal = zScores(valPct);

  const wEqOpm = cfg.earnings_quality.weights.opm_std;
  const wEqPat = cfg.earnings_quality.weights.pat_cv;
  const scored: QuantBasketRow[] = candidates.map((r, i) => {
    const eq = combineWeighted([
      { z: zOpm[i] ?? null, weight: wEqOpm },
      { z: zPat[i] ?? null, weight: wEqPat },
    ]);
    const val = zVal[i] ?? null;
    const gov = zGov[i] ?? null;
    const score = combineWeighted([
      { z: gov, weight: cfg.score_weights.gov },
      { z: eq, weight: cfg.score_weights.eq },
      { z: val, weight: cfg.score_weights.val },
    ]);
    return {
      ticker: r.ticker,
      sector: r.sector,
      eq,
      val,
      gov,
      score,
      rank: null,
      in_book: false,
      weight: null,
      opm_std: r.opm_std,
      pat_cv: r.pat_cv,
      ebit_yield: r.ebit_yield,
    };
  });

  const ranked = scored
    .filter((r) => r.score != null)
    .sort(
      (a, b) =>
        (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
        a.ticker.localeCompare(b.ticker),
    );

  const book = pickSectorCappedBook(
    ranked.map((r) => ({
      ticker: r.ticker,
      sector: r.sector,
      score: r.score as number,
    })),
    cfg.portfolio.n_stocks,
    cfg.portfolio.max_sector_weight,
  );
  const bookSet = new Set(book.map((r) => r.ticker));
  const wt = book.length ? 1 / book.length : null;
  const byTicker = new Map(scored.map((r) => [r.ticker, r]));
  book.forEach((b, i) => {
    const row = byTicker.get(b.ticker);
    if (!row) return;
    row.in_book = true;
    row.weight = wt;
    row.rank = i + 1;
  });

  const map = new Map<string, QuantBasketRow>();
  for (const r of scored) map.set(r.ticker, r);
  cache = { at: now, map };
  return map;
}

export function invalidateQuantBasketCache(): void {
  cache = null;
}

export function quantBasketTickerSet(): Set<string> {
  const out = new Set<string>();
  for (const [t, r] of loadQuantBasketMap()) {
    if (r.in_book) out.add(t);
  }
  return out;
}
