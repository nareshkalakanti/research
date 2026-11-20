import { rotationCloses } from "./rotation-bars";
import { fetchScreenerAllAnnual } from "./screener-annual";
import { screenerPausedUntil } from "./screener-fetch";
import { openSqliteNamed } from "./sqlite-utils";
import { fillHtIvFromYahoo } from "./sector-rotation-board";
import { buildScannerData } from "./scanner";
import { loadCachedQuartersSeries } from "./screener-quarters";
import { rotationFetchYears } from "./sector-rotation-series";
import { loadStockMaster } from "./stock-master";
import { loadHtIvMap } from "./strategy/ht-store";
import { runConcurrent } from "./scrape-pool";

/**
 * Value page: the ranking universe (Sales growth 3Y, ROCE 3Y, P/B per stock,
 * StockScans industry) and an industry Headwind / Tailwind breadth score.
 * Everything comes from stored data — no live fetches.
 */

/**
 * Screener annual series for every cached stock: 3-year sales CAGR (last FY vs
 * three years earlier) and 3-year average ROCE — the same definitions as the
 * Intrinsic Value ranking. Read in one pass from metrics.db.
 */
function loadScreenerLegs(): Map<string, { sales3y: number | null; roce3y: number | null; fy: string | null; bv?: number | null }> {
  const out = new Map<string, { sales3y: number | null; roce3y: number | null; fy: string | null; bv?: number | null }>();
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, annual_json FROM screener_annual_cache`).all() as Array<{
        t: string;
        annual_json: string;
      }>) {
        try {
          const a = JSON.parse(r.annual_json) as { dates: string[]; sales: Array<number | null>; roce: Array<number | null> };
          // Annual columns only (the most common month — drops half-year columns).
          const months = new Map<string, number>();
          for (const d of a.dates) months.set(d.slice(5, 7), (months.get(d.slice(5, 7)) ?? 0) + 1);
          const main = [...months].sort((x, y) => y[1] - x[1])[0]?.[0];
          const idx = a.dates.map((d, i) => (d.slice(5, 7) === main ? i : -1)).filter((i) => i >= 0);
          const sales = idx.map((i) => a.sales[i] ?? null);
          const roce = idx.map((i) => a.roce[i] ?? null);
          const n = sales.length;
          const end = sales[n - 1];
          const start = sales[n - 4];
          const sales3y = n >= 4 && end != null && start != null && start > 0 && end > 0 ? (Math.pow(end / start, 1 / 3) - 1) * 100 : null;
          const last3 = roce.slice(-3).filter((v): v is number => v != null && Number.isFinite(v));
          const roce3y = last3.length === 3 ? last3.reduce((x, y) => x + y, 0) / 3 : null;
          out.set(r.t, { sales3y, roce3y, fy: idx.length ? a.dates[idx[idx.length - 1]!]!.slice(0, 4) : null });
        } catch {
          /* bad row */
        }
      }
      // Latest book value (equity + reserves) → P/B when Yahoo has none.
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, bs_json FROM screener_annual_bs_cache`).all() as Array<{ t: string; bs_json: string }>) {
        try {
          const b = JSON.parse(r.bs_json) as { dates: string[]; book_value: Array<number | null> };
          // Last full-year (most common month, i.e. March) book value — not the half-year column.
          const months = new Map<string, number>();
          for (const d of b.dates) months.set(d.slice(5, 7), (months.get(d.slice(5, 7)) ?? 0) + 1);
          const main = [...months].sort((x, y) => y[1] - x[1])[0]?.[0];
          let bv: number | null = null;
          for (let i = b.dates.length - 1; i >= 0; i--) {
            const v = b.book_value[i];
            if (b.dates[i]!.slice(5, 7) === main && v != null && v > 0) {
              bv = v;
              break;
            }
          }
          const e = out.get(r.t);
          if (e) e.bv = bv;
          else out.set(r.t, { sales3y: null, roce3y: null, fy: null, bv });
        } catch {
          /* skip */
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* no cache */
  }
  return out;
}

export type ValueStock = {
  t: string;
  name: string;
  market: string;
  sector: string | null;
  industry: string | null;
  mcap: number | null;
  web: string | null;
  /** Quality legs (null = not fetched yet). */
  sales3y: number | null;
  roce3y: number | null;
  pb: number | null;
  /** Where Sales growth / ROCE came from: Screener annual (preferred) or Yahoo. */
  src: "screener" | "yahoo" | null;
};

export type ValueUniverse = {
  rows: ValueStock[];
  industries: Array<{ name: string; n: number; ranked: number }>;
  as_of: string | null;
};

const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** Same stocks and the same industry as the Scanner page, plus quality legs. */
export function buildValueUniverse(): ValueUniverse {
  const scan = buildScannerData();
  const ht = loadHtIvMap();
  const rows: ValueStock[] = [];
  let asOf: string | null = null;
  const legs = loadScreenerLegs();
  for (const r of scan.rows) {
    const h = ht.get(r.t);
    const yahooOk = h && ok(h.sales_growth_3y) && ok(h.roce_3y) && ok(h.pb) && h.pb > 0;
    const sc = legs.get(r.t);
    const scOk = sc && sc.sales3y != null && sc.roce3y != null;
    const mcapNow = r.mcap ?? h?.market_cap_cr ?? null;
    // P/B = today's market cap ÷ latest book value (Screener); Yahoo's cached P/B only as fallback.
    const pb = sc?.bv && mcapNow ? mcapNow / sc.bv : h && ok(h.pb) && h.pb > 0 ? h.pb : null;
    if (yahooOk && h.fetched_at && (!asOf || h.fetched_at > asOf)) asOf = h.fetched_at;
    const useSc = scOk && pb != null;
    rows.push({
      t: r.t,
      name: r.name,
      market: r.market || "NSE",
      sector: r.sector,
      industry: r.industry,
      mcap: r.mcap ?? (h?.market_cap_cr ?? null),
      web: r.web,
      sales3y: useSc ? sc.sales3y : yahooOk ? h.sales_growth_3y : null,
      roce3y: useSc ? sc.roce3y : yahooOk ? h.roce_3y : null,
      pb: useSc || yahooOk ? pb : null,
      src: useSc ? "screener" : yahooOk ? "yahoo" : null,
    });
  }
  const ind = new Map<string, { n: number; ranked: number }>();
  for (const r of rows) {
    if (!r.industry) continue;
    const e = ind.get(r.industry) ?? { n: 0, ranked: 0 };
    e.n++;
    if (r.sales3y != null) e.ranked++;
    ind.set(r.industry, e);
  }
  return {
    rows,
    industries: [...ind.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => a.name.localeCompare(b.name)),
    as_of: asOf,
  };
}

// ---- Headwind / Tailwind ------------------------------------------------------------

export type WindRow = {
  industry: string;
  sector: string | null;
  n: number;
  above: number;
  below: number;
  /** (above − below) / n, from −1 to +1. */
  score: number;
  /** Median 3-month return of the industry's stocks (%). */
  ret3m: number | null;
  indicator: "TAILWIND" | "HEADWIND" | "NEUTRAL";
};

export const WIND = {
  /** Price vs its own N-day average decides "rising" / "falling". */
  smaDays: 50,
  tailwind: 0.2,
  headwind: -0.2,
  minStocks: 1,
} as const;

let windCache: { at: number; data: { rows: WindRow[]; as_of: string | null } } | null = null;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Breadth per StockScans industry: share of stocks trading above their 50-day
 * average minus the share below it. +1 = every stock rising, −1 = every stock
 * falling. Uses the Rotation price cache (refreshed after each close).
 */
export async function buildHeadwinds(opts?: { fresh?: boolean }): Promise<{ rows: WindRow[]; as_of: string | null }> {
  if (!opts?.fresh && windCache && Date.now() - windCache.at < 10 * 60_000) return windCache.data;
  const master = loadStockMaster();
  const stocks = [...master.entries()].filter(([, m]) => m.tracked && m.active && m.industry);
  const years = rotationFetchYears();
  let asOf: string | null = null;
  const stats = await runConcurrent(stocks, 8, async ([t, m]) => {
    try {
      const bars = await rotationCloses(t, m.exchange || "NSE", years);
      if (bars.length < WIND.smaDays + 5) return null;
      const last = bars[bars.length - 1]!;
      if (!asOf || last.date > asOf) asOf = last.date;
      // Skip stocks with no trade for 3+ weeks (suspended / illiquid).
      if (Date.now() - Date.parse(`${last.date}T12:00:00Z`) > 21 * 86_400_000) return null;
      const win = bars.slice(-WIND.smaDays);
      const sma = win.reduce((a, b) => a + b.close, 0) / win.length;
      const back = bars[bars.length - 64];
      return {
        industry: m.industry!,
        sector: m.sector,
        up: last.close > sma,
        ret3m: back && back.close > 0 ? (last.close / back.close - 1) * 100 : null,
      };
    } catch {
      return null;
    }
  });
  const by = new Map<string, { sector: string | null; up: number; down: number; rets: number[] }>();
  for (const s of stats) {
    if (!s) continue;
    const e = by.get(s.industry) ?? { sector: s.sector, up: 0, down: 0, rets: [] };
    if (s.up) e.up++;
    else e.down++;
    if (s.ret3m != null) e.rets.push(s.ret3m);
    by.set(s.industry, e);
  }
  const rows: WindRow[] = [];
  for (const [industry, e] of by) {
    const n = e.up + e.down;
    if (n < WIND.minStocks) continue;
    const score = Math.round(((e.up - e.down) / n) * 10000) / 10000;
    rows.push({
      industry,
      sector: e.sector,
      n,
      above: e.up,
      below: e.down,
      score,
      ret3m: median(e.rets),
      indicator: score >= WIND.tailwind ? "TAILWIND" : score <= WIND.headwind ? "HEADWIND" : "NEUTRAL",
    });
  }
  rows.sort((a, b) => b.score - a.score || b.n - a.n);
  const data = { rows, as_of: asOf };
  windCache = { at: Date.now(), data };
  return data;
}

// ---- Fill missing quality legs (Yahoo only) ------------------------------------------

const FILL_STOP = "__valueFillStop";
type StopHolder = { [FILL_STOP]?: boolean };
export function stopValueFill(): void {
  (globalThis as StopHolder)[FILL_STOP] = true;
}

/**
 * Sales growth 3Y / ROCE 3Y / P/B for every Value stock that has none, biggest
 * first, from Yahoo (no Screener budget used). Slow and polite: ~1 stock/s;
 * on a Yahoo rate limit it waits a minute and carries on (gives up after 5).
 */
export async function fillValueQuality(onProgress: (done: number, total: number, filled: number) => void) {
  const holder = globalThis as StopHolder;
  holder[FILL_STOP] = false;
  const { rows } = buildValueUniverse();
  const missing = rows.filter((r) => r.sales3y == null).sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0));
  // Yahoo already said "not found / incomplete" in the last 14 days → go straight to Screener.
  const ht = loadHtIvMap();
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const yahooTried = (t: string) => {
    const h = ht.get(t);
    return !!h && h.status !== "ok" && (h.fetched_at ?? "") >= since;
  };
  const yq = missing.filter((r) => !yahooTried(r.t));
  const total = missing.length;
  let done = 0;
  let filled = 0;
  let limits = 0;
  onProgress(0, total, 0);
  // 1) Yahoo (fast, no Screener budget)
  const leftover: ValueStock[] = missing.filter((r) => yahooTried(r.t));
  for (const r of yq) {
    if (holder[FILL_STOP]) return { tried: done, filled, left: total - done, not_found: done - filled };
    let got = false;
    try {
      got = await fillHtIvFromYahoo({ ticker: r.t, name: r.name, market: r.market });
    } catch {
      if (++limits > 5) break;
      await new Promise((s) => setTimeout(s, 60_000));
    }
    done++;
    if (got) filled++;
    else leftover.push(r);
    onProgress(done, total, filled);
    await new Promise((s) => setTimeout(s, 700));
  }
  // 2) Screener for what Yahoo lacks: one page per stock, slow, stop on any block.
  //    Progress restarts as "Screener i of n".
  done = 0;
  const n2 = leftover.length;
  onProgress(0, n2, filled);
  for (const r of leftover) {
    if (holder[FILL_STOP] || screenerPausedUntil()) break;
    try {
      const res = await fetchScreenerAllAnnual(r.t);
      if (res.annual) filled++;
    } catch {
      break; // blocked / paused — next run continues
    }
    done++;
    onProgress(done, n2, filled);
    await new Promise((s) => setTimeout(s, 5000 + Math.random() * 2000));
  }
  return { tried: done, filled, left: n2 - done, not_found: done - filled };
}

// ---- Industry cycle: out of favour → hot -------------------------------------------------

export const CYCLE = {
  /** Classification on average constituent-company returns (per year). Checked in this order. */
  deepOut5y: 2,
  out3y: 0,
  extremeHot5y: 35,
  hot3y: 25,
} as const;
export type CycleStatus = "deep_out" | "out" | "extreme_hot" | "hot" | "neutral";
export type CycleRow = {
  industry: string;
  status: CycleStatus;
  ret3y: number | null;
  ret5y: number | null;
  n: number;
  cov3y: number;
  cov5y: number;
};

let cycleCache: { at: number; data: { rows: CycleRow[]; as_of: string | null } } | null = null;

/**
 * Each industry's average 3-year and 5-year return per year (CAGR) across its
 * companies, from the stored daily prices, classified:
 * deep out of favour 5Y < 2% · out of favour 3Y < 0% · extremely hot 5Y > 35% ·
 * hot 3Y > 25% · neutral the rest.
 */
export async function buildIndustryCycle(opts?: { fresh?: boolean }): Promise<{ rows: CycleRow[]; as_of: string | null }> {
  if (!opts?.fresh && cycleCache && Date.now() - cycleCache.at < 30 * 60_000) return cycleCache.data;
  const scan = buildScannerData();
  const years = rotationFetchYears();
  let asOf: string | null = null;
  const per = await runConcurrent(scan.rows, 8, async (r) => {
    if (!r.industry) return null;
    try {
      const bars = await rotationCloses(r.t, r.market || "NSE", years);
      if (bars.length < 60) return null;
      const last = bars[bars.length - 1]!;
      if (Date.now() - Date.parse(`${last.date}T12:00:00Z`) > 21 * 86_400_000) return null;
      if (!asOf || last.date > asOf) asOf = last.date;
      const at = (y: number) => {
        const d = new Date(`${last.date}T00:00:00Z`);
        d.setUTCFullYear(d.getUTCFullYear() - y);
        const want = d.toISOString().slice(0, 10);
        // First bar on/after the date, but only if the series really starts by then.
        if (bars[0]!.date > want) return null;
        const b = bars.find((x) => x.date >= want);
        return b && b.close > 0 ? b.close : null;
      };
      const c3 = at(3);
      const c5 = at(5);
      return {
        industry: r.industry,
        r3: c3 ? (Math.pow(last.close / c3, 1 / 3) - 1) * 100 : null,
        r5: c5 ? (Math.pow(last.close / c5, 1 / 5) - 1) * 100 : null,
      };
    } catch {
      return null;
    }
  });
  const by = new Map<string, { n: number; r3: number[]; r5: number[] }>();
  for (const r of scan.rows) {
    if (!r.industry) continue;
    const e = by.get(r.industry) ?? { n: 0, r3: [], r5: [] };
    e.n++;
    by.set(r.industry, e);
  }
  for (const p of per) {
    if (!p) continue;
    const e = by.get(p.industry)!;
    if (p.r3 != null) e.r3.push(p.r3);
    if (p.r5 != null) e.r5.push(p.r5);
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const rows: CycleRow[] = [];
  for (const [industry, e] of by) {
    const ret3y = avg(e.r3);
    const ret5y = avg(e.r5);
    if (ret3y == null && ret5y == null) continue;
    const status: CycleStatus =
      ret5y != null && ret5y < CYCLE.deepOut5y
        ? "deep_out"
        : ret3y != null && ret3y < CYCLE.out3y
          ? "out"
          : ret5y != null && ret5y > CYCLE.extremeHot5y
            ? "extreme_hot"
            : ret3y != null && ret3y > CYCLE.hot3y
              ? "hot"
              : "neutral";
    const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
    rows.push({ industry, status, ret3y: r2(ret3y), ret5y: r2(ret5y), n: e.n, cov3y: e.r3.length, cov5y: e.r5.length });
  }
  rows.sort((a, b) => (a.ret3y ?? 1e9) - (b.ret3y ?? 1e9));
  const data = { rows, as_of: asOf };
  cycleCache = { at: Date.now(), data };
  return data;
}

// ---- Sector valuation: % of companies under / over their own history --------------------

export const VAL = {
  /** Under / over = current P/E this far below / above the company's 5-year median P/E. */
  band: 0.15,
  years: 5,
  minYears: 3,
} as const;
export type ValVerdict = "under" | "fair" | "over";
export type ValStock = { t: string; name: string; pe: number; peMedian: number; ratio: number; verdict: ValVerdict };
export type ValSector = {
  industry: string;
  n: number;
  scored: number;
  under: number;
  over: number;
  under_pct: number;
  over_pct: number;
  stocks: ValStock[];
};

let valCache: { at: number; data: { rows: ValSector[]; as_of: string | null } } | null = null;

/**
 * For every company with Screener annual EPS: P/E at each year end (price on
 * that date ÷ that year's EPS) over the last 5 years → median, vs today's P/E
 * (price ÷ last-4-quarter EPS, else latest annual EPS). Loss years are skipped.
 * A sector's undervalued % = share of its scored companies more than 15% below
 * their own median P/E (overvalued: more than 15% above).
 */
export async function buildSectorValuation(opts?: { fresh?: boolean }): Promise<{ rows: ValSector[]; as_of: string | null }> {
  if (!opts?.fresh && valCache && Date.now() - valCache.at < 30 * 60_000) return valCache.data;
  const scan = buildScannerData();
  const annual = new Map<string, { dates: string[]; eps: Array<number | null> }>();
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, annual_json FROM screener_annual_cache`).all() as Array<{
        t: string;
        annual_json: string;
      }>) {
        try {
          const a = JSON.parse(r.annual_json) as { dates: string[]; eps: Array<number | null> };
          if (a.dates?.length) annual.set(r.t, a);
        } catch {
          /* skip */
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* none */
  }
  const years = rotationFetchYears();
  let asOf: string | null = null;
  const per = await runConcurrent(scan.rows, 8, async (r) => {
    const a = annual.get(r.t);
    if (!a || !r.industry) return null;
    try {
      const bars = await rotationCloses(r.t, r.market || "NSE", years);
      if (bars.length < 200) return null;
      const last = bars[bars.length - 1]!;
      if (!asOf || last.date > asOf) asOf = last.date;
      const priceOn = (date: string) => {
        if (bars[0]!.date > date) return null;
        let hit: number | null = null;
        for (const b of bars) {
          if (b.date > date) break;
          hit = b.close;
        }
        return hit;
      };
      // Year-end P/Es over the last 5 years (annual columns only, positive EPS).
      const months = new Map<string, number>();
      for (const d of a.dates) months.set(d.slice(5, 7), (months.get(d.slice(5, 7)) ?? 0) + 1);
      const main = [...months].sort((x, y) => y[1] - x[1])[0]?.[0];
      const pes: number[] = [];
      a.dates.forEach((d, i) => {
        if (d.slice(5, 7) !== main) return;
        const e = a.eps[i];
        if (e == null || e <= 0) return;
        const p = priceOn(d);
        if (p != null) pes.push(p / e);
      });
      const hist = pes.slice(-VAL.years);
      if (hist.length < VAL.minYears) return null;
      const sorted = [...hist].sort((x, y) => x - y);
      const med = sorted.length % 2 ? sorted[sorted.length >> 1]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
      // Today's EPS: last 4 quarters, else latest annual.
      const qs = (loadCachedQuartersSeries(r.t) ?? []).filter((q) => q.eps != null).sort((x, y) => x.date.localeCompare(y.date)).slice(-4);
      const ttm = qs.length === 4 ? qs.reduce((s, q) => s + (q.eps as number), 0) : null;
      const lastAnnual = [...a.eps].reverse().find((e) => e != null) ?? null;
      const epsNow = ttm ?? lastAnnual;
      if (epsNow == null || epsNow <= 0 || med <= 0) return null;
      const pe = last.close / epsNow;
      const ratio = pe / med;
      const verdict: ValVerdict = ratio < 1 - VAL.band ? "under" : ratio > 1 + VAL.band ? "over" : "fair";
      return { industry: r.industry, s: { t: r.t, name: r.name, pe: Math.round(pe * 10) / 10, peMedian: Math.round(med * 10) / 10, ratio: Math.round(ratio * 100) / 100, verdict } };
    } catch {
      return null;
    }
  });
  const by = new Map<string, ValSector>();
  for (const r of scan.rows) {
    if (!r.industry) continue;
    const e = by.get(r.industry) ?? { industry: r.industry, n: 0, scored: 0, under: 0, over: 0, under_pct: 0, over_pct: 0, stocks: [] };
    e.n++;
    by.set(r.industry, e);
  }
  for (const p of per) {
    if (!p) continue;
    const e = by.get(p.industry)!;
    e.scored++;
    if (p.s.verdict === "under") e.under++;
    if (p.s.verdict === "over") e.over++;
    e.stocks.push(p.s);
  }
  const rows = [...by.values()].filter((e) => e.scored > 0);
  for (const e of rows) {
    e.under_pct = Math.round((e.under / e.scored) * 1000) / 10;
    e.over_pct = Math.round((e.over / e.scored) * 1000) / 10;
    e.stocks.sort((x, y) => x.ratio - y.ratio);
  }
  const data = { rows, as_of: asOf };
  valCache = { at: Date.now(), data };
  return data;
}
