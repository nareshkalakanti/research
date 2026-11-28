import {
  boardLinkedCountsForTickers,
  independentDirectorCountsForTickers,
  listedVcGovForTickers,
} from "./company-network";
import { BRIDGE_TINY_MAX_CR } from "./gov-score";
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
import { valueLegsForTickers, type ValueNa } from "./value-tools";

/** Microcap board for the sector-return table (≤ this market cap). */
export const MICROCAP_SECTOR_MAX_CR = 1000;

export type MicrocapBoardFilter = "all" | "main" | "sme";

/** Value-style ranks inside the Top/Bot pocket or sector set (lower total = better). */
export type MicrocapValueRanks = {
  /** Names with Sales + ROCE + P/B usable for the Value ranking. */
  n_value: number;
  avg_sales3y: number | null;
  avg_roce3y: number | null;
  avg_pb: number | null;
  gR: number | null;
  rR: number | null;
  pR: number | null;
  /** gR + rR + pR — null when the pocket/sector is not Value-rankable. */
  total: number | null;
};

export type MicrocapIndustryReturn = {
  industry: string;
  n: number;
  /** Equal-weight average 12-month return (%). */
  avg_ret_1y: number;
} & MicrocapValueRanks;

export type MicrocapSectorReturn = {
  sector: string;
  n: number;
  avg_ret_1y: number;
  /** Industry with the best Value total in this sector (named industries only). */
  low: MicrocapIndustryReturn | null;
  /** Industry with the worst Value total in this sector (named industries only). */
  high: MicrocapIndustryReturn | null;
  industries: MicrocapIndustryReturn[];
} & MicrocapValueRanks;

export type MicrocapSectorBoard = {
  min_mcap_cr: number;
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
 * StockScans when structured; else classifications.db sector › sub_sector.
 * Screener.in labels stay in screener_industries.db until explicitly wired in.
 */
function resolveSectorIndustry(
  ticker: string,
  ss: { sector: string | null; industry: string | null } | undefined,
  cls: Map<string, ClsRow>,
): { sector: string; industry: string; usedCls: boolean } | null {
  const t = ticker.toUpperCase();
  const ssSector = ss?.sector?.trim() || null;
  const ssInd = ss?.industry?.trim() || null;

  if (ssSector && !stockscansIsFlat(ssSector, ssInd)) {
    return { sector: ssSector, industry: ssInd || "", usedCls: false };
  }

  const c = cls.get(t);
  if (c?.sector) {
    const leaf = c.sub_sector || c.industry || "";
    return { sector: c.sector, industry: leaf, usedCls: true };
  }

  if (ssSector) return { sector: ssSector, industry: ssInd || "", usedCls: false };
  return null;
}

type ValueAgg = {
  rets: number[];
  sales: number[];
  roce: number[];
  pb: number[];
  /** Recoveries counted in sales avg but flagged for pocket-level growth ranking. */
  recovery_n: number;
};

function emptyAgg(): ValueAgg {
  return { rets: [], sales: [], roce: [], pb: [], recovery_n: 0 };
}

function valueRanksFromAgg(a: ValueAgg): MicrocapValueRanks {
  // sales/roce/pb only get a push when the stock has a full triple.
  return {
    n_value: a.sales.length,
    avg_sales3y: mean(a.sales),
    avg_roce3y: mean(a.roce),
    avg_pb: mean(a.pb),
    gR: null,
    rR: null,
    pR: null,
    total: null,
  };
}

/** Rank items like Value: Sales ↑ · ROCE ↑ · P/B ↓ · total = sum of ranks (lower better). */
function applyValueRanks<T extends MicrocapValueRanks>(
  rows: T[],
  opts: {
    sales: (r: T) => number;
    roce: (r: T) => number;
    pb: (r: T) => number;
    /** True → ranked last on the growth leg (recovery-heavy pocket). */
    recovery?: (r: T) => boolean;
  },
): void {
  const work = rows.filter((r) => r.n_value > 0 && r.avg_sales3y != null && r.avg_roce3y != null && r.avg_pb != null);
  const rankBy = (vals: Array<[T, number]>, desc: boolean) => {
    const s = [...vals].sort((a, b) => (desc ? b[1] - a[1] : a[1] - b[1]));
    const out = new Map<T, number>();
    s.forEach(([row, v], i) => out.set(row, i > 0 && v === s[i - 1]![1] ? out.get(s[i - 1]![0])! : i + 1));
    return out;
  };
  const g = rankBy(
    work.map((r) => [r, opts.recovery?.(r) ? Number.NEGATIVE_INFINITY : opts.sales(r)] as [T, number]),
    true,
  );
  const o = rankBy(
    work.map((r) => [r, opts.roce(r)] as [T, number]),
    true,
  );
  const p = rankBy(
    work.map((r) => [r, opts.pb(r)] as [T, number]),
    false,
  );
  for (const r of work) {
    const gR = g.get(r)!;
    const rR = o.get(r)!;
    const pR = p.get(r)!;
    r.gR = gR;
    r.rR = rR;
    r.pR = pR;
    r.total = gR + rR + pR;
  }
}

/** Inclusive mcap band in ₹ Cr (min 0 = no floor). */
function inMcapBand(mcap: number, minMcap: number, maxMcap: number): boolean {
  if (!(mcap > 0) || !Number.isFinite(mcap)) return false;
  if (mcap > maxMcap) return false;
  if (minMcap > 0 && mcap < minMcap) return false;
  return true;
}

/**
 * For names in the mcap band: equal-weight avg 12-month return by sector › industry,
 * plus Value-style Sales / ROCE / P/B ranks (same legs as the ranking tool).
 * StockScans first; classifications sector › sub_sector when StockScans is flat.
 */
export function buildMicrocapSectorReturns(opts?: {
  maxMcapCr?: number;
  /** Inclusive floor in ₹ Cr (0 = no floor). */
  minMcapCr?: number;
  board?: MicrocapBoardFilter;
  /** Min names with a 1Y return before an industry is ranked. */
  minIndustryN?: number;
}): MicrocapSectorBoard {
  const maxMcap = opts?.maxMcapCr ?? MICROCAP_SECTOR_MAX_CR;
  const minMcap = Math.max(0, opts?.minMcapCr ?? 0);
  const board = opts?.board ?? "all";
  const minInd = Math.max(1, opts?.minIndustryN ?? 2);
  const years = rotationFetchYears();
  const labels = masterLabels();
  const cls = loadClassificationsMap();
  const metrics = loadMetricsMap();

  type Hit = {
    ticker: string;
    sector: string;
    industry: string;
    mcap_cr: number;
    ret_1y: number;
  };
  const hits: Hit[] = [];
  let withRet = 0;
  let universe = 0;
  let clsFallback = 0;
  let asOf: string | null = null;

  for (const [ticker, row] of metrics) {
    const mcap = row.market_cap_cr;
    if (mcap == null || !inMcapBand(mcap, minMcap, maxMcap)) continue;
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
    hits.push({
      ticker: ticker.toUpperCase(),
      sector,
      industry,
      mcap_cr: mcap,
      ret_1y: ret,
    });
  }

  const legs = valueLegsForTickers(
    hits.map((h) => h.ticker),
    new Map(hits.map((h) => [h.ticker, h.mcap_cr] as const)),
  );

  const bySector = new Map<string, ValueAgg>();
  /** Industry key "" = labeled sector but blank industry. */
  const byInd = new Map<string, Map<string, ValueAgg>>();

  for (const h of hits) {
    const push = (a: ValueAgg) => {
      a.rets.push(h.ret_1y);
      const leg = legs.get(h.ticker);
      // Pocket/sector Value avg needs a real P/B (skip negative-equity names here).
      if (!leg || leg.sales3y == null || leg.roce3y == null || leg.pb == null || !(leg.pb > 0)) return;
      a.sales.push(leg.sales3y);
      a.roce.push(leg.roce3y);
      a.pb.push(leg.pb);
      if (leg.sales_recovery) a.recovery_n += 1;
    };

    const s = bySector.get(h.sector) ?? emptyAgg();
    push(s);
    bySector.set(h.sector, s);

    const indMap = byInd.get(h.sector) ?? new Map<string, ValueAgg>();
    const i = indMap.get(h.industry) ?? emptyAgg();
    push(i);
    indMap.set(h.industry, i);
    byInd.set(h.sector, indMap);
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
        agg: a,
      }));
      const pluralityN = raw.reduce((m, x) => Math.max(m, x.n), 0);

      const kept: MicrocapIndustryReturn[] = [];
      const otherAgg = emptyAgg();

      const foldIntoOther = (a: ValueAgg) => {
        otherAgg.rets.push(...a.rets);
        otherAgg.sales.push(...a.sales);
        otherAgg.roce.push(...a.roce);
        otherAgg.pb.push(...a.pb);
        otherAgg.recovery_n += a.recovery_n;
      };

      for (const x of raw) {
        if (!x.industry) {
          foldIntoOther(x.agg);
          continue;
        }
        const ik = x.industry.toLowerCase();
        const crossTag = ik !== sectorKey && sectorNames.has(ik) && x.n < pluralityN;
        if (crossTag || x.n < minInd) {
          foldIntoOther(x.agg);
          continue;
        }
        const vr = valueRanksFromAgg(x.agg);
        vr.n_value = x.agg.sales.length;
        const row: MicrocapIndustryReturn & { _recovery?: boolean } = {
          industry: x.industry,
          n: x.n,
          avg_ret_1y: x.avg_ret_1y,
          ...vr,
        };
        row._recovery = x.agg.sales.length > 0 && x.agg.recovery_n > x.agg.sales.length / 2;
        kept.push(row);
      }

      if (otherAgg.rets.length) {
        const vr = valueRanksFromAgg(otherAgg);
        vr.n_value = otherAgg.sales.length;
        const row: MicrocapIndustryReturn & { _recovery?: boolean } = {
          industry: "Other",
          n: otherAgg.rets.length,
          avg_ret_1y: mean(otherAgg.rets)!,
          ...vr,
        };
        row._recovery = otherAgg.sales.length > 0 && otherAgg.recovery_n > otherAgg.sales.length / 2;
        kept.push(row);
      }

      const secVr = valueRanksFromAgg(agg);
      secVr.n_value = agg.sales.length;
      const secRow: MicrocapSectorReturn & { _recovery?: boolean } = {
        sector,
        n: agg.rets.length,
        avg_ret_1y: avg,
        low: null,
        high: null,
        industries: kept,
        ...secVr,
      };
      secRow._recovery = agg.sales.length > 0 && agg.recovery_n > agg.sales.length / 2;
      return secRow;
    })
    .filter((s) => s.n >= minInd);

  // Value-rank named pockets across the board (mutate industry objects in place).
  type PocketRef = MicrocapIndustryReturn & { _recovery?: boolean };
  const allPockets: PocketRef[] = [];
  for (const s of sectors) {
    for (const ind of s.industries) {
      if (ind.industry === "Other") continue;
      if (ind.n_value < minInd) continue;
      allPockets.push(ind as PocketRef);
    }
  }
  applyValueRanks(allPockets, {
    sales: (r) => r.avg_sales3y!,
    roce: (r) => r.avg_roce3y!,
    pb: (r) => r.avg_pb!,
    recovery: (r) => !!r._recovery,
  });

  type SectorRef = MicrocapSectorReturn & { _recovery?: boolean };
  const rankableSectors = (sectors as SectorRef[]).filter((s) => s.n_value >= minInd);
  applyValueRanks(rankableSectors, {
    sales: (r) => r.avg_sales3y!,
    roce: (r) => r.avg_roce3y!,
    pb: (r) => r.avg_pb!,
    recovery: (r) => !!r._recovery,
  });

  for (const s of sectors) {
    delete (s as { _recovery?: boolean })._recovery;
    for (const ind of s.industries) {
      delete (ind as { _recovery?: boolean })._recovery;
    }
    // Board lists: best → worst 12M return (matches the % shown on each row).
    s.industries.sort(
      (a, b) =>
        b.avg_ret_1y - a.avg_ret_1y ||
        a.industry.localeCompare(b.industry),
    );
    // High / Low only when ≥2 named pockets — otherwise they would be the same row.
    const named = s.industries.filter((x) => x.industry !== "Other");
    const byRet = [...named].sort(
      (a, b) => b.avg_ret_1y - a.avg_ret_1y || a.industry.localeCompare(b.industry),
    );
    if (byRet.length >= 2) {
      s.high = byRet[0]!;
      s.low = byRet[byRet.length - 1]!;
    } else {
      s.high = null;
      s.low = null;
    }
  }

  // Columns ordered by the 12M return printed on the header (best first).
  sectors.sort(
    (a, b) =>
      b.avg_ret_1y - a.avg_ret_1y ||
      a.sector.localeCompare(b.sector),
  );

  return {
    min_mcap_cr: minMcap,
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
  /** Independent directors on this board (0 when none / unknown). */
  independent_n: number;
  /** Listed-VC gov: not family-heavy + ≥1 really-small board link. */
  gov_pass: boolean;
  /** Continuous Listed-VC gov score (higher better). */
  gov_score: number;
  family_n: number;
  board_n: number;
  /** Linked listed boards with mcap ≤ ₹500 Cr. */
  small_link_n: number;
  /** Gov rank among passers (1 = best; null = filtered / unscored). */
  govR: number | null;
  /** Value legs (same sources as Value / Intrinsic Value). */
  sales3y: number | null;
  roce3y: number | null;
  pb: number | null;
  na: ValueNa | null;
  sales_recovery: boolean;
  /** Rank of each leg inside this pocket/sector list (null = not rankable). */
  gR: number | null;
  rR: number | null;
  pR: number | null;
  /** gR + rR + pR — lower is better (null = not rankable / missing data). */
  total: number | null;
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
  /** Inclusive floor in ₹ Cr (0 = no floor). */
  minMcapCr?: number;
  board?: MicrocapBoardFilter;
  minIndustryN?: number;
}): MicrocapStockList {
  const maxMcap = opts.maxMcapCr ?? MICROCAP_SECTOR_MAX_CR;
  const minMcap = Math.min(Math.max(0, opts.minMcapCr ?? 0), maxMcap);
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
    if (mcap == null || !inMcapBand(mcap, minMcap, maxMcap)) continue;
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

  const tickers = filtered.map((h) => h.ticker);
  const linkCounts = boardLinkedCountsForTickers(tickers);
  const indCounts = independentDirectorCountsForTickers(tickers);
  const mcapBy = new Map(filtered.map((h) => [h.ticker, h.mcap_cr] as const));
  const legs = valueLegsForTickers(tickers, mcapBy);

  const stocks: MicrocapStockRow[] = filtered.map((h) => {
    const leg = legs.get(h.ticker);
    return {
      ticker: h.ticker,
      name: master.get(h.ticker)?.name?.trim() || h.ticker,
      market: h.market,
      mcap_cr: h.mcap_cr,
      ret_1y: h.ret_1y,
      sector: h.sector,
      industry: h.industry || "—",
      div_yield_pct: divYieldPct(tape.get(h.ticker)?.div_yield ?? null),
      board_links: linkCounts.get(h.ticker) ?? 0,
      independent_n: indCounts.get(h.ticker) ?? 0,
      gov_pass: false,
      gov_score: 0,
      family_n: 0,
      board_n: 0,
      small_link_n: 0,
      govR: null,
      sales3y: leg?.sales3y ?? null,
      roce3y: leg?.roce3y ?? null,
      pb: leg?.pb ?? null,
      na: leg?.na ?? null,
      sales_recovery: !!leg?.sales_recovery,
      gR: null,
      rR: null,
      pR: null,
      total: null,
    };
  });

  // Same ranking as Value: Sales ↑ · ROCE ↑ · P/B ↓ inside this pocket / sector list.
  const rankable = stocks.filter(
    (r) => r.sales3y != null && r.roce3y != null && ((r.pb != null && r.pb > 0) || r.na === "negative_equity"),
  );
  const rankBy = (vals: Array<[string, number]>, desc: boolean) => {
    const s = [...vals].sort((a, b) => (desc ? b[1] - a[1] : a[1] - b[1]));
    const out = new Map<string, number>();
    s.forEach(([t, v], i) => out.set(t, i > 0 && v === s[i - 1]![1] ? out.get(s[i - 1]![0])! : i + 1));
    return out;
  };
  const g = rankBy(
    rankable.map((r) => [r.ticker, r.sales_recovery ? Number.NEGATIVE_INFINITY : r.sales3y!] as [string, number]),
    true,
  );
  const o = rankBy(
    rankable.map((r) => [r.ticker, r.roce3y!] as [string, number]),
    true,
  );
  const p = rankBy(
    rankable.map((r) => [r.ticker, r.pb != null && r.pb > 0 ? r.pb : Number.POSITIVE_INFINITY] as [string, number]),
    false,
  );
  for (const r of stocks) {
    const gR = g.get(r.ticker);
    const rR = o.get(r.ticker);
    const pR = p.get(r.ticker);
    if (gR == null || rR == null || pR == null) continue;
    r.gR = gR;
    r.rR = rR;
    r.pR = pR;
    r.total = gR + rR + pR;
  }

  // Ranked first (lower total better), then by 12M return for the rest / ties.
  stocks.sort(
    (a, b) =>
      (a.total == null ? 1 : 0) - (b.total == null ? 1 : 0) ||
      (a.total ?? 0) - (b.total ?? 0) ||
      b.ret_1y - a.ret_1y ||
      a.name.localeCompare(b.name),
  );

  return {
    sector: wantSector,
    industry: wantInd,
    max_mcap_cr: maxMcap,
    board,
    stocks,
  };
}

/** Default cohort size for Top / Mid / Bot pocket → company Ranking. */
const RANK_POCKET_N = 20;

export type MicrocapPocketSide = "top" | "mid" | "bot" | "all";

export type MicrocapRankedRow = MicrocapStockRow & {
  /** 1-based Value rank inside this list (null = not rankable / no data). */
  rank: number | null;
};

export type MicrocapRanking = {
  min_mcap_cr: number;
  max_mcap_cr: number;
  board: MicrocapBoardFilter;
  min_industry_n: number;
  /** Which Value-pocket cohort names were drawn from. */
  pocket_side: MicrocapPocketSide;
  /** Cohort size (Top/Mid/Bot N); 0 when pocket_side is all. */
  from_pockets: number;
  pocket_keys: string[];
  /** Dropped by Listed-VC gov hard filter (family-heavy or no small-board link). */
  gov_dropped: number;
  ranked: number;
  no_data: number;
  not_rankable: number;
  stocks: MicrocapRankedRow[];
};

function pickPocketCohort<T extends { key: string; total: number }>(
  all: T[],
  side: MicrocapPocketSide,
  n: number,
): T[] {
  if (side === "all" || n <= 0) return all;
  const sortedAsc = [...all].sort((a, b) => a.total - b.total || a.key.localeCompare(b.key));
  if (side === "top") return sortedAsc.slice(0, n);
  if (side === "bot") return [...sortedAsc].reverse().slice(0, n);
  // Mid: drop Top N and Bot N, then take N around the median (worst → best).
  const topKeys = new Set(sortedAsc.slice(0, n).map((p) => p.key));
  const botKeys = new Set([...sortedAsc].reverse().slice(0, n).map((p) => p.key));
  const rest = sortedAsc.filter((p) => !topKeys.has(p.key) && !botKeys.has(p.key));
  if (rest.length <= n) return rest;
  const start = Math.max(0, Math.floor((rest.length - n) / 2));
  return rest.slice(start, start + n);
}

/**
 * Value-style company ranking (Sales ↑ · ROCE ↑ · P/B ↓ → total, lower better).
 * Default: names in the Top 20 Value pockets; `pocketSide` switches Mid / Bot / All.
 */
export function listMicrocapRanking(opts?: {
  maxMcapCr?: number;
  /** Inclusive floor in ₹ Cr (0 = no floor). */
  minMcapCr?: number;
  board?: MicrocapBoardFilter;
  minIndustryN?: number;
  /** Top / Mid / Bot Value-pocket cohort, or all pockets on the board. */
  pocketSide?: MicrocapPocketSide;
  /** Cohort size for Top / Mid / Bot (ignored when pocketSide is all). */
  pocketN?: number;
  /** When set, keep only these industry / sub_sector names (exact match). */
  industries?: string[];
}): MicrocapRanking {
  const maxMcap = opts?.maxMcapCr ?? MICROCAP_SECTOR_MAX_CR;
  const minMcapRaw = Math.max(0, opts?.minMcapCr ?? 0);
  const minMcap = Math.min(minMcapRaw, maxMcap);
  const board = opts?.board ?? "all";
  const minInd = Math.max(1, opts?.minIndustryN ?? 2);
  const pocketSide: MicrocapPocketSide = opts?.pocketSide ?? "top";
  const pocketN = Math.max(0, opts?.pocketN ?? RANK_POCKET_N);
  const industryWant = new Set(
    (opts?.industries ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
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
  for (const [ticker, row] of metrics) {
    const mcap = row.market_cap_cr;
    if (mcap == null || !inMcapBand(mcap, minMcap, maxMcap)) continue;
    const sme = isSmeMarket(row.market);
    if (board === "main" && sme) continue;
    if (board === "sme" && !sme) continue;
    const resolved = resolveSectorIndustry(ticker, labels.get(ticker.toUpperCase()), cls);
    if (!resolved) continue;
    const closes = cachedRotationCloses(ticker, row.market, years);
    const ret = ret1yPct(closes);
    if (ret == null || !Number.isFinite(ret)) continue;
    hits.push({
      ticker: ticker.toUpperCase(),
      market: row.market,
      mcap_cr: mcap,
      ret_1y: ret,
      sector: resolved.sector,
      industry: resolved.industry || "—",
    });
  }

  let pocketKeys: string[] = [];
  let pool = hits;
  if (pocketSide !== "all") {
    const boardData = buildMicrocapSectorReturns({
      maxMcapCr: maxMcap,
      minMcapCr: minMcap,
      board,
      minIndustryN: minInd,
    });
    const allPockets = boardData.sectors.flatMap((s) =>
      s.industries
        .filter((i) => i.industry !== "Other" && i.total != null)
        .map((i) => ({
          key: `${s.sector}/${i.industry}`,
          sector: s.sector,
          industry: i.industry,
          total: i.total!,
        })),
    );
    const pockets = pickPocketCohort(allPockets, pocketSide, pocketN);
    pocketKeys = pockets.map((p) => p.key);
    const want = new Set(pockets.map((p) => `${p.sector}\u0000${p.industry}`));
    pool = hits.filter((h) => want.has(`${h.sector}\u0000${h.industry}`));
  }

  if (industryWant.size) {
    pool = pool.filter((h) => industryWant.has(h.industry.toLowerCase()));
  }

  // Listed-VC Gov C: hard-filter family-heavy / no really-small board link, then score.
  const preGovN = pool.length;
  const govMap = listedVcGovForTickers(
    pool.map((h) => h.ticker),
    { smallMaxCr: BRIDGE_TINY_MAX_CR },
  );
  pool = pool.filter((h) => govMap.get(h.ticker)?.pass === true);
  const gov_dropped = preGovN - pool.length;

  const poolTickers = pool.map((h) => h.ticker);
  const linkCounts = boardLinkedCountsForTickers(poolTickers);
  const indCounts = independentDirectorCountsForTickers(poolTickers);
  const mcapBy = new Map(pool.map((h) => [h.ticker, h.mcap_cr] as const));
  const legs = valueLegsForTickers(poolTickers, mcapBy);

  const stocks: MicrocapRankedRow[] = pool.map((h) => {
    const leg = legs.get(h.ticker);
    const gov = govMap.get(h.ticker);
    return {
      ticker: h.ticker,
      name: master.get(h.ticker)?.name?.trim() || h.ticker,
      market: h.market,
      mcap_cr: h.mcap_cr,
      ret_1y: h.ret_1y,
      sector: h.sector,
      industry: h.industry,
      div_yield_pct: divYieldPct(tape.get(h.ticker)?.div_yield ?? null),
      board_links: linkCounts.get(h.ticker) ?? 0,
      independent_n: indCounts.get(h.ticker) ?? 0,
      gov_pass: true,
      gov_score: gov?.score ?? 0,
      family_n: gov?.family_n ?? 0,
      board_n: gov?.board_n ?? 0,
      small_link_n: gov?.small_link_n ?? 0,
      govR: null,
      sales3y: leg?.sales3y ?? null,
      roce3y: leg?.roce3y ?? null,
      pb: leg?.pb ?? null,
      na: leg?.na ?? null,
      sales_recovery: !!leg?.sales_recovery,
      gR: null,
      rR: null,
      pR: null,
      total: null,
      rank: null,
    };
  });

  // Gov rank among passers (higher continuous score → better → lower govR).
  {
    const byScore = [...stocks].sort(
      (a, b) =>
        b.gov_score - a.gov_score ||
        b.small_link_n - a.small_link_n ||
        a.family_n - b.family_n ||
        a.name.localeCompare(b.name),
    );
    let prevScore: number | null = null;
    let prevRank = 0;
    byScore.forEach((r, i) => {
      const rank =
        prevScore != null && r.gov_score === prevScore ? prevRank : i + 1;
      r.govR = rank;
      prevScore = r.gov_score;
      prevRank = rank;
    });
  }

  const rankable = stocks.filter(
    (r) => r.sales3y != null && r.roce3y != null && ((r.pb != null && r.pb > 0) || r.na === "negative_equity"),
  );
  const rankBy = (vals: Array<[string, number]>, desc: boolean) => {
    const s = [...vals].sort((a, b) => (desc ? b[1] - a[1] : a[1] - b[1]));
    const out = new Map<string, number>();
    s.forEach(([t, v], i) => out.set(t, i > 0 && v === s[i - 1]![1] ? out.get(s[i - 1]![0])! : i + 1));
    return out;
  };
  const g = rankBy(
    rankable.map((r) => [r.ticker, r.sales_recovery ? Number.NEGATIVE_INFINITY : r.sales3y!] as [string, number]),
    true,
  );
  const o = rankBy(
    rankable.map((r) => [r.ticker, r.roce3y!] as [string, number]),
    true,
  );
  const p = rankBy(
    rankable.map((r) => [r.ticker, r.pb != null && r.pb > 0 ? r.pb : Number.POSITIVE_INFINITY] as [string, number]),
    false,
  );
  for (const r of rankable) {
    const gR = g.get(r.ticker)!;
    const rR = o.get(r.ticker)!;
    const pR = p.get(r.ticker)!;
    r.gR = gR;
    r.rR = rR;
    r.pR = pR;
    r.total = gR + rR + pR;
  }

  const ordered = [...rankable].sort(
    (a, b) =>
      (a.total ?? 0) - (b.total ?? 0) ||
      (a.gR ?? 0) - (b.gR ?? 0) ||
      (a.rR ?? 0) - (b.rR ?? 0) ||
      (a.pR ?? 0) - (b.pR ?? 0) ||
      a.name.localeCompare(b.name),
  );
  ordered.forEach((r, i) => {
    r.rank = i + 1;
  });

  const unranked = stocks.filter((r) => r.rank == null);
  unranked.sort((a, b) => a.name.localeCompare(b.name));
  const out = [...ordered, ...unranked];

  const not_rankable = unranked.filter((r) => r.na != null && r.na !== "negative_equity").length;
  const no_data = unranked.length - not_rankable;

  return {
    min_mcap_cr: minMcap,
    max_mcap_cr: maxMcap,
    board,
    min_industry_n: minInd,
    pocket_side: pocketSide,
    from_pockets: pocketSide === "all" ? 0 : pocketN,
    pocket_keys: pocketKeys,
    gov_dropped,
    ranked: ordered.length,
    no_data,
    not_rankable,
    stocks: out,
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
  minMcapCr?: number;
  board?: MicrocapBoardFilter;
}): MicrocapMissingDivList {
  const maxMcap = opts?.maxMcapCr ?? MICROCAP_SECTOR_MAX_CR;
  const minMcap = Math.min(Math.max(0, opts?.minMcapCr ?? 0), maxMcap);
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
    if (mcap == null || !inMcapBand(mcap, minMcap, maxMcap)) continue;
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
