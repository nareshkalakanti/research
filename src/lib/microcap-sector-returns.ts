import { boardLinkedCountsForTickers } from "./company-network";
import { loadMetricsMap } from "./metrics";
import { idxOnOrBefore } from "./price-action-rules";
import { cachedRotationCloses } from "./rotation-bars";
import { rotationFetchYears } from "./sector-rotation-series";
import { openSqliteNamed } from "./sqlite-utils";
import { loadStockMaster, masterLabels } from "./stock-master";
import { runConcurrent } from "./scrape-pool";
import {
  loadTickertapeRatiosMap,
  tickertapeDivChecked,
  writeTickertapeRatiosCache,
} from "./tickertape-ratios-cache";
import { tickertapeStockRatios } from "./web-mcap";

/** Microcap board for the sector-return table (≤ this market cap). */
export const MICROCAP_SECTOR_MAX_CR = 1000;

export type MicrocapBoardFilter = "all" | "main" | "sme";

export type MicrocapIndustryReturn = {
  industry: string;
  n: number;
  /** Equal-weight average 12-month return (%). */
  avg_ret_1y: number;
};

export type MicrocapSectorReturn = {
  sector: string;
  n: number;
  avg_ret_1y: number;
  /** Industry with the lowest average return in this sector. */
  low: MicrocapIndustryReturn | null;
  /** Industry with the highest average return in this sector. */
  high: MicrocapIndustryReturn | null;
  industries: MicrocapIndustryReturn[];
};

export type MicrocapSectorBoard = {
  max_mcap_cr: number;
  board: MicrocapBoardFilter;
  /** Min names with a 1Y return for a sector / industry to appear. */
  min_industry_n: number;
  /** Calendar span used for the 1Y window (approx). */
  lookback_days: number;
  sectors: MicrocapSectorReturn[];
  stocks_with_return: number;
  stocks_in_universe: number;
  /** Names that used classifications sector › sub_sector because StockScans was flat. */
  classifications_fallback_n: number;
  as_of: string | null;
};

type ClsRow = { sector: string; industry: string | null; sub_sector: string | null };

function isSmeMarket(market: string | null | undefined): boolean {
  const m = (market || "").toUpperCase();
  return m.includes("SME") || m.includes("EMERGE");
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Close ≈1 year before the tip; null when history is too short. */
function ret1yPct(closes: Array<{ date: string; close: number }>): number | null {
  if (closes.length < 40) return null;
  const last = closes[closes.length - 1]!;
  if (!(last.close > 0)) return null;
  const tip = new Date(`${last.date}T12:00:00Z`);
  tip.setUTCDate(tip.getUTCDate() - 365);
  const want = tip.toISOString().slice(0, 10);
  const i = idxOnOrBefore(closes, want);
  if (i < 0) return null;
  const start = closes[i]!;
  if (!(start.close > 0)) return null;
  // Need a real ~1Y span (allow holidays / thin history).
  const days = (Date.parse(`${last.date}T12:00:00Z`) - Date.parse(`${start.date}T12:00:00Z`)) / 86_400_000;
  if (days < 300) return null;
  return (last.close / start.close - 1) * 100;
}

/** StockScans gives no real breakout when industry is blank or equals the sector. */
function stockscansIsFlat(sector: string | null, industry: string | null): boolean {
  if (!sector?.trim()) return true;
  const ind = industry?.trim() || "";
  if (!ind) return true;
  return ind.toLowerCase() === sector.trim().toLowerCase();
}

/** Old classifications.db: sector › industry › sub_sector (5.5k rows). */
function loadClassificationsMap(): Map<string, ClsRow> {
  const out = new Map<string, ClsRow>();
  try {
    const db = openSqliteNamed("classifications.db", { readonly: true, wal: true });
    try {
      const rows = db
        .prepare(`SELECT UPPER(ticker) AS t, sector, industry, sub_sector FROM classifications`)
        .all() as Array<{ t: string; sector: string | null; industry: string | null; sub_sector: string | null }>;
      for (const r of rows) {
        const sector = r.sector?.trim() || "";
        if (!r.t || !sector) continue;
        out.set(r.t, {
          sector,
          industry: r.industry?.trim() || null,
          sub_sector: r.sub_sector?.trim() || null,
        });
      }
    } finally {
      db.close();
    }
  } catch {
    // classifications.db optional on some machines
  }
  return out;
}

/**
 * Prefer StockScans sector › industry when it has structure.
 * If StockScans is flat (Trading/Trading, Cement/Cement, blank industry), use
 * classifications sector › sub_sector (then industry) when present.
 */
function resolveSectorIndustry(
  ticker: string,
  ss: { sector: string | null; industry: string | null } | undefined,
  cls: Map<string, ClsRow>,
): { sector: string; industry: string; usedCls: boolean } | null {
  const ssSector = ss?.sector?.trim() || null;
  const ssInd = ss?.industry?.trim() || null;

  if (ssSector && !stockscansIsFlat(ssSector, ssInd)) {
    return { sector: ssSector, industry: ssInd || "", usedCls: false };
  }

  const c = cls.get(ticker.toUpperCase());
  if (c?.sector) {
    const leaf = c.sub_sector || c.industry || "";
    return { sector: c.sector, industry: leaf, usedCls: true };
  }

  if (ssSector) return { sector: ssSector, industry: ssInd || "", usedCls: false };
  return null;
}

/**
 * For names ≤ ₹maxMcap Cr: equal-weight avg 12-month return by sector › industry.
 * StockScans first; classifications sector › sub_sector when StockScans is flat.
 */
export function buildMicrocapSectorReturns(opts?: {
  maxMcapCr?: number;
  board?: MicrocapBoardFilter;
  /** Min names with a 1Y return before an industry is ranked. */
  minIndustryN?: number;
}): MicrocapSectorBoard {
  const maxMcap = opts?.maxMcapCr ?? MICROCAP_SECTOR_MAX_CR;
  const board = opts?.board ?? "all";
  const minInd = Math.max(1, opts?.minIndustryN ?? 2);
  const years = rotationFetchYears();
  const labels = masterLabels();
  const cls = loadClassificationsMap();
  const metrics = loadMetricsMap();

  type Agg = { rets: number[] };
  const bySector = new Map<string, Agg>();
  /** Industry key "" = labeled sector but blank industry. */
  const byInd = new Map<string, Map<string, Agg>>();
  let withRet = 0;
  let universe = 0;
  let clsFallback = 0;
  let asOf: string | null = null;

  for (const [ticker, row] of metrics) {
    const mcap = row.market_cap_cr;
    if (mcap == null || !(mcap > 0) || mcap > maxMcap) continue;
    const sme = isSmeMarket(row.market);
    if (board === "main" && sme) continue;
    if (board === "sme" && !sme) continue;

    const resolved = resolveSectorIndustry(ticker, labels.get(ticker.toUpperCase()), cls);
    if (!resolved) continue;
    const { sector, industry, usedCls } = resolved;
    universe++;
    if (usedCls) clsFallback++;
    if (!asOf || row.fetched_at > asOf) asOf = row.fetched_at;

    const closes = cachedRotationCloses(ticker, row.market, years);
    const ret = ret1yPct(closes);
    if (ret == null || !Number.isFinite(ret)) continue;
    withRet++;

    const s = bySector.get(sector) ?? { rets: [] };
    s.rets.push(ret);
    bySector.set(sector, s);

    const indMap = byInd.get(sector) ?? new Map<string, Agg>();
    const i = indMap.get(industry) ?? { rets: [] };
    i.rets.push(ret);
    indMap.set(industry, i);
    byInd.set(sector, indMap);
  }

  // Industry name that is another sector on this board (e.g. Trading under Plastics) —
  // keep when it is the plurality tag here; otherwise fold into Other.
  const sectorNames = new Set([...bySector.keys()].map((s) => s.toLowerCase()));

  const sectors: MicrocapSectorReturn[] = [...bySector.entries()]
    .map(([sector, agg]) => {
      const avg = mean(agg.rets)!;
      const sectorKey = sector.toLowerCase();
      const raw = [...(byInd.get(sector)?.entries() ?? [])].map(([industry, a]) => ({
        industry,
        n: a.rets.length,
        avg_ret_1y: mean(a.rets)!,
        rets: a.rets,
      }));
      const pluralityN = raw.reduce((m, x) => Math.max(m, x.n), 0);

      const kept: MicrocapIndustryReturn[] = [];
      const otherRets: number[] = [];

      for (const x of raw) {
        if (!x.industry) {
          otherRets.push(...x.rets);
          continue;
        }
        const ik = x.industry.toLowerCase();
        const crossTag = ik !== sectorKey && sectorNames.has(ik) && x.n < pluralityN;
        if (crossTag || x.n < minInd) {
          otherRets.push(...x.rets);
          continue;
        }
        kept.push({ industry: x.industry, n: x.n, avg_ret_1y: x.avg_ret_1y });
      }

      if (otherRets.length) {
        kept.push({ industry: "Other", n: otherRets.length, avg_ret_1y: mean(otherRets)! });
      }

      const industries = kept.sort(
        (a, b) => b.avg_ret_1y - a.avg_ret_1y || a.industry.localeCompare(b.industry),
      );
      const named = industries.filter((x) => x.industry !== "Other");
      const forSpread = named.length ? named : industries;
      const high = forSpread[0] ?? null;
      const low = forSpread.length ? forSpread[forSpread.length - 1]! : null;
      return {
        sector,
        n: agg.rets.length,
        avg_ret_1y: avg,
        low,
        high,
        industries,
      };
    })
    .filter((s) => s.n >= minInd)
    .sort((a, b) => b.avg_ret_1y - a.avg_ret_1y || a.sector.localeCompare(b.sector));

  return {
    max_mcap_cr: maxMcap,
    board,
    min_industry_n: minInd,
    lookback_days: 365,
    sectors,
    stocks_with_return: withRet,
    stocks_in_universe: universe,
    classifications_fallback_n: clsFallback,
    as_of: asOf,
  };
}

export type MicrocapStockRow = {
  ticker: string;
  name: string;
  market: string | null;
  mcap_cr: number | null;
  ret_1y: number;
  sector: string;
  /** Resolved leaf before Other folding. */
  industry: string;
  /** Dividend yield in percent points when cached (Tickertape). */
  div_yield_pct: number | null;
  /** Other listed boards sharing ≥1 director (gov board map). */
  board_links: number;
};

export type MicrocapStockList = {
  sector: string;
  /** null = whole sector; "Other" = residual bucket. */
  industry: string | null;
  max_mcap_cr: number;
  board: MicrocapBoardFilter;
  stocks: MicrocapStockRow[];
};

/** Tickertape stores yield as ratio or percent points — normalize to percent points. */
function divYieldPct(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw < 0) return null;
  if (raw > 0 && raw < 0.05) return raw * 100; // ratio e.g. 0.012 → 1.2%
  return raw; // already percent points (0.5, 1.2, …)
}


/**
 * Stocks behind a sector or pocket (same universe / label rules as the board).
 * `industry: "Other"` returns names folded into the residual bucket.
 */
export function listMicrocapStocks(opts: {
  sector: string;
  industry?: string | null;
  maxMcapCr?: number;
  board?: MicrocapBoardFilter;
  minIndustryN?: number;
}): MicrocapStockList {
  const maxMcap = opts.maxMcapCr ?? MICROCAP_SECTOR_MAX_CR;
  const board = opts.board ?? "all";
  const minInd = Math.max(1, opts.minIndustryN ?? 2);
  const wantSector = opts.sector.trim();
  const wantInd = opts.industry == null || opts.industry === "" ? null : opts.industry.trim();
  const years = rotationFetchYears();
  const labels = masterLabels();
  const cls = loadClassificationsMap();
  const metrics = loadMetricsMap();
  const master = loadStockMaster();
  const tape = loadTickertapeRatiosMap();

  type Hit = {
    ticker: string;
    market: string | null;
    mcap_cr: number | null;
    ret_1y: number;
    sector: string;
    industry: string;
  };
  const hits: Hit[] = [];
  const bySectorInd = new Map<string, Map<string, number>>();

  for (const [ticker, row] of metrics) {
    const mcap = row.market_cap_cr;
    if (mcap == null || !(mcap > 0) || mcap > maxMcap) continue;
    const sme = isSmeMarket(row.market);
    if (board === "main" && sme) continue;
    if (board === "sme" && !sme) continue;
    const resolved = resolveSectorIndustry(ticker, labels.get(ticker.toUpperCase()), cls);
    if (!resolved) continue;

    const secMap = bySectorInd.get(resolved.sector) ?? new Map<string, number>();
    const closes = cachedRotationCloses(ticker, row.market, years);
    const ret = ret1yPct(closes);
    if (ret == null || !Number.isFinite(ret)) continue;

    secMap.set(resolved.industry, (secMap.get(resolved.industry) ?? 0) + 1);
    bySectorInd.set(resolved.sector, secMap);

    if (resolved.sector !== wantSector) continue;
    hits.push({
      ticker: ticker.toUpperCase(),
      market: row.market,
      mcap_cr: mcap,
      ret_1y: ret,
      sector: resolved.sector,
      industry: resolved.industry,
    });
  }

  const sectorNames = new Set([...bySectorInd.keys()].map((s) => s.toLowerCase()));
  const raw = [...(bySectorInd.get(wantSector)?.entries() ?? [])].map(([industry, n]) => ({ industry, n }));
  const pluralityN = raw.reduce((m, x) => Math.max(m, x.n), 0);
  const sectorKey = wantSector.toLowerCase();
  const otherIndustries = new Set<string>();
  for (const x of raw) {
    if (!x.industry) {
      otherIndustries.add("");
      continue;
    }
    const ik = x.industry.toLowerCase();
    const crossTag = ik !== sectorKey && sectorNames.has(ik) && x.n < pluralityN;
    if (crossTag || x.n < minInd) otherIndustries.add(x.industry);
  }

  const filtered =
    wantInd == null
      ? hits
      : wantInd === "Other"
        ? hits.filter((h) => otherIndustries.has(h.industry))
        : hits.filter((h) => h.industry === wantInd);

  const linkCounts = boardLinkedCountsForTickers(filtered.map((h) => h.ticker));
  const stocks: MicrocapStockRow[] = filtered.map((h) => ({
    ticker: h.ticker,
    name: master.get(h.ticker)?.name?.trim() || h.ticker,
    market: h.market,
    mcap_cr: h.mcap_cr,
    ret_1y: h.ret_1y,
    sector: h.sector,
    industry: h.industry || "—",
    div_yield_pct: divYieldPct(tape.get(h.ticker)?.div_yield ?? null),
    board_links: linkCounts.get(h.ticker) ?? 0,
  }));

  stocks.sort((a, b) => b.ret_1y - a.ret_1y || a.name.localeCompare(b.name));

  return {
    sector: wantSector,
    industry: wantInd,
    max_mcap_cr: maxMcap,
    board,
    stocks,
  };
}

export type MicrocapMissingDivRow = { ticker: string; name: string };

export type MicrocapMissingDivList = {
  max_mcap_cr: number;
  board: MicrocapBoardFilter;
  universe_with_ret: number;
  missing: MicrocapMissingDivRow[];
};

/**
 * Board-wide names (same mcap / board / 1Y filter as Micro Monopolies) still missing
 * a cached Tickertape dividend yield.
 */
export function listMicrocapMissingDivYields(opts?: {
  maxMcapCr?: number;
  board?: MicrocapBoardFilter;
}): MicrocapMissingDivList {
  const maxMcap = opts?.maxMcapCr ?? MICROCAP_SECTOR_MAX_CR;
  const board = opts?.board ?? "all";
  const years = rotationFetchYears();
  const labels = masterLabels();
  const cls = loadClassificationsMap();
  const metrics = loadMetricsMap();
  const master = loadStockMaster();
  const tape = loadTickertapeRatiosMap();

  const missing: MicrocapMissingDivRow[] = [];
  let universe_with_ret = 0;

  for (const [ticker, row] of metrics) {
    const mcap = row.market_cap_cr;
    if (mcap == null || !(mcap > 0) || mcap > maxMcap) continue;
    const sme = isSmeMarket(row.market);
    if (board === "main" && sme) continue;
    if (board === "sme" && !sme) continue;
    const resolved = resolveSectorIndustry(ticker, labels.get(ticker.toUpperCase()), cls);
    if (!resolved) continue;
    const closes = cachedRotationCloses(ticker, row.market, years);
    const ret = ret1yPct(closes);
    if (ret == null || !Number.isFinite(ret)) continue;
    universe_with_ret += 1;
    const t = ticker.toUpperCase();
    const tapeRow = tape.get(t);
    const y = divYieldPct(tapeRow?.div_yield ?? null);
    if (y != null) continue;
    // Already asked Tickertape for yield (blank is a real answer) — don't keep re-filling.
    if (tickertapeDivChecked(tapeRow)) continue;
    missing.push({ ticker: t, name: master.get(t)?.name?.trim() || t });
  }

  missing.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return { max_mcap_cr: maxMcap, board, universe_with_ret, missing };
}

export type MicrocapDivFillResult = {
  tried: number;
  filled: number; // got a numeric div yield
  failed: number; // no Tickertape hit / error
  still_missing: number; // fetched but yield blank
};

/**
 * Pull Tickertape ratios for names missing div yield and cache them.
 * Concurrency kept low to avoid hammering Tickertape.
 */
export async function fillMicrocapDivYields(
  items: Array<{ ticker: string; name?: string | null }>,
): Promise<MicrocapDivFillResult> {
  const byTicker = new Map<string, string>();
  for (const it of items) {
    const t = it.ticker.trim().toUpperCase();
    if (!t) continue;
    if (!byTicker.has(t)) byTicker.set(t, (it.name || t).trim() || t);
  }
  const list = [...byTicker.entries()].map(([ticker, name]) => ({ ticker, name }));
  let filled = 0;
  let failed = 0;
  let still_missing = 0;

  const emptyTape = {
    roe: null,
    roce: null,
    pe: null,
    ttm_pe: null,
    eps: null,
    price: null,
    mcap_cr: null,
    high_52w: null,
    low_52w: null,
    div_yield: null,
  };

  await runConcurrent(list, 3, async ({ ticker, name }) => {
    try {
      const tape = await tickertapeStockRatios(ticker, name);
      if (!tape) {
        writeTickertapeRatiosCache(ticker, emptyTape, { divChecked: true });
        failed += 1;
        return;
      }
      writeTickertapeRatiosCache(ticker, tape, { divChecked: true });
      if (tape.div_yield != null && Number.isFinite(tape.div_yield)) filled += 1;
      else still_missing += 1;
    } catch {
      writeTickertapeRatiosCache(ticker, emptyTape, { divChecked: true });
      failed += 1;
    }
  });

  return { tried: list.length, filled, failed, still_missing };
}
