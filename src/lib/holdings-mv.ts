import { fetchDailyBars } from "./ohlc";
import { loadHoldings } from "./holdings";
import { runConcurrent } from "./scrape-pool";
import {
  capWeights,
  covMatrix,
  gradient,
  meanVec,
  optimalWeights,
  ridge,
  shrinkAlpha,
  utility,
} from "./holdings-mv-math";
import { tradingviewUrl } from "./links";

const LOOKBACK = 120;
const MIN_DAYS = 40;
const MAX_NAMES = 80;
const ANN = 252;

export type HoldingsMvRow = {
  ticker: string;
  name: string;
  current_w: number;
  suggested_w: number;
  delta_w: number;
  alpha: number;
  grad: number;
  days: number;
  tv_url: string;
};

export type HoldingsMvResult = {
  lambda: number;
  max_w: number;
  names: number;
  days: number;
  L_current: number;
  L_star: number;
  skipped: string[];
  rows: HoldingsMvRow[];
};

function commonDates(maps: Map<string, number>[]): string[] {
  if (!maps.length) return [];
  let set = new Set(maps[0]!.keys());
  for (const m of maps.slice(1)) {
    const next = new Set<string>();
    for (const d of set) if (m.has(d)) next.add(d);
    set = next;
  }
  return [...set].sort();
}

function dropUntilOverlap(
  tickers: string[],
  byTicker: Map<string, Map<string, number>>,
): { keep: string[]; dates: string[] } {
  let keep = tickers.filter((t) => (byTicker.get(t)?.size ?? 0) >= MIN_DAYS);
  for (;;) {
    const dates = commonDates(keep.map((t) => byTicker.get(t)!));
    if (dates.length >= MIN_DAYS || keep.length <= 2) {
      return { keep, dates };
    }
    let worst = keep[0]!;
    let n = byTicker.get(worst)?.size ?? 0;
    for (const t of keep) {
      const s = byTicker.get(t)?.size ?? 0;
      if (s < n) {
        n = s;
        worst = t;
      }
    }
    keep = keep.filter((t) => t !== worst);
  }
}

export async function runHoldingsMeanVariance(opts: {
  lambda: number;
  maxW?: number;
}): Promise<HoldingsMvResult> {
  const lambda = Math.min(40, Math.max(0.25, Number(opts.lambda) || 8));
  const holdings = loadHoldings().slice(0, MAX_NAMES);
  const skipped: string[] = [];
  const byTicker = new Map<string, Map<string, number>>();
  const names = new Map<string, string>();
  const markets = new Map<string, string>();

  await runConcurrent(holdings, 4, async (h) => {
    const t = h.ticker.toUpperCase();
    names.set(t, (h.name || t).trim());
    markets.set(t, h.market || "NSE");
    const bars = await fetchDailyBars(t, h.market, 1);
    const m = new Map<string, number>();
    for (const b of bars) {
      if (b.close > 0) m.set(b.date.slice(0, 10), b.close);
    }
    if (m.size < MIN_DAYS) {
      skipped.push(t);
      return;
    }
    byTicker.set(t, m);
  });

  const { keep, dates } = dropUntilOverlap([...byTicker.keys()].sort(), byTicker);
  for (const t of byTicker.keys()) {
    if (!keep.includes(t)) skipped.push(t);
  }
  if (keep.length < 2 || dates.length < MIN_DAYS) {
    return {
      lambda,
      max_w: 0,
      names: 0,
      days: dates.length,
      L_current: 0,
      L_star: 0,
      skipped: [...new Set(skipped)].sort(),
      rows: [],
    };
  }

  const useDates = dates.slice(-LOOKBACK);
  const series: number[][] = [];
  const dayCount = new Map<string, number>();
  for (let d = 1; d < useDates.length; d++) {
    const row: number[] = [];
    let ok = true;
    for (const t of keep) {
      const a = byTicker.get(t)!.get(useDates[d - 1]!);
      const b = byTicker.get(t)!.get(useDates[d]!);
      if (!(a && b && a > 0 && b > 0)) {
        ok = false;
        break;
      }
      row.push(Math.log(b / a));
    }
    if (!ok) continue;
    series.push(row);
    for (const t of keep) dayCount.set(t, (dayCount.get(t) ?? 0) + 1);
  }

  if (series.length < MIN_DAYS - 5) {
    return {
      lambda,
      max_w: 0,
      names: keep.length,
      days: series.length,
      L_current: 0,
      L_star: 0,
      skipped: [...new Set(skipped)].sort(),
      rows: [],
    };
  }

  const muRaw = meanVec(series).map((x) => x * ANN);
  const mu = shrinkAlpha(muRaw);
  let F = covMatrix(series).map((row) => row.map((v) => v * ANN));
  const diagMean =
    F.reduce((s, row, i) => s + row[i]!, 0) / Math.max(1, F.length);
  F = ridge(F, Math.max(1e-6, 0.02 * diagMean));

  const n = keep.length;
  const maxW = Math.min(
    0.2,
    Math.max(0.04, Number(opts.maxW) || 4 / n),
  );
  const P0 = new Array(n).fill(1 / n);
  let Pstar = optimalWeights(mu, F, lambda);
  if (!Pstar) Pstar = P0.slice();
  Pstar = capWeights(Pstar, maxW);
  const g = gradient(mu, P0, F, lambda);
  const L0 = utility(mu, P0, F, lambda);
  const L1 = utility(mu, Pstar, F, lambda);

  const rows: HoldingsMvRow[] = keep.map((t, i) => ({
    ticker: t,
    name: names.get(t) || t,
    current_w: P0[i]!,
    suggested_w: Pstar[i]!,
    delta_w: Pstar[i]! - P0[i]!,
    alpha: mu[i]!,
    grad: g[i]!,
    days: dayCount.get(t) ?? series.length,
    tv_url: tradingviewUrl(t, markets.get(t)),
  }));
  rows.sort((a, b) => b.delta_w - a.delta_w || a.ticker.localeCompare(b.ticker));

  return {
    lambda,
    max_w: maxW,
    names: n,
    days: series.length,
    L_current: L0,
    L_star: L1,
    skipped: [...new Set(skipped)].sort(),
    rows,
  };
}
