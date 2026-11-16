import { checkPrice, loadPrices, loadSurveillance, type PriceRow } from "./fallen-angels";
import { fetchScreenerAnnualBs } from "./screener-annual";
import { inactiveListingTickers } from "./listing-sync";
import {
  buildStock,
  loadCtx,
  loadCurrent,
  type Ctx,
  type FillResult,
  type NanoStock,
  type Progress,
} from "./nanocap-champs";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Hidden Gems (Trilithon Hidden Gems Scheme, managed by Lotusdew):
 *  1. Trilithon scan — reads each micro-cap / SME company's latest NSE
 *     shareholding filing (XBRL) and records every named holder (> 1%).
 *     Trilithon's confirmed picks come from there; other funds can be tracked
 *     the same way.
 *  2. ATAM-like screen — tiny, profitable-on-record companies that are cheap
 *     against their normal (peak) earnings, often after a bad patch.
 */

export const HG_LIST_KEY = "hiddengems";
export const HG_FUND_MATCH = "TRILITHON";
export const HG_TOP_N = 10;

export const HG_RULES = {
  minMcapCr: 30,
  maxMcapCr: 300,
  /** Market cap ÷ best recent yearly profit. */
  maxPeOnPeak: 12,
  /** Market cap ÷ last-12-month sales. */
  maxPriceToSales: 1.5,
  /** Share of reported periods (3 years) with an operating profit. */
  minProfitableShare: 0.75,
  /** Below this the "best year" was a one-off gain or a units error. */
  minPeOnPeak: 3,
  /** Borrowings ÷ net worth, where known. */
  maxDebtToEquity: 1,
  minIndependentShare: 1 / 3,
  /** Scan universe for named holders (NSE + NSE SME). */
  scanMaxMcapCr: 1000,
} as const;

export type Stake = { holder: string; category: string; pct: number | null; quarter: string };

export type HgStock = NanoStock & {
  pe_on_peak: number | null;
  price_to_sales: number | null;
  profit_vs_peak_pct: number | null;
  profitable_share: number | null;
  from_high_pct: number | null;
  debt_to_equity: number | null;
  trilithon: Stake | null;
  other_funds: string[];
  board_known: boolean;
  score: number | null;
  score_parts: Array<{ label: string; points: number; max: number }>;
};

export type HgPage = {
  basket: "hg";
  holdings: HgStock[];
  trilithon: HgStock[];
  candidates: HgStock[];
  scan: { universe: number; scanned: number; last_at: string | null; holders_found: number };
  shortlist: number;
  price_checked: number;
  rules: typeof HG_RULES;
};

const NSE = (process.env.NSE_ORIGIN || "https://www.nseindia.in").replace(/\/+$/, "");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ---- Named holders from NSE shareholding filings -----------------------------

function withStakeDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS holder_stakes (
      symbol TEXT NOT NULL,
      quarter TEXT NOT NULL,
      holder TEXT NOT NULL,
      category TEXT,
      pct REAL,
      shares REAL,
      PRIMARY KEY (symbol, quarter, holder)
    );
    CREATE TABLE IF NOT EXISTS holder_scan (
      symbol TEXT PRIMARY KEY,
      quarter TEXT,
      scanned_at TEXT NOT NULL,
      ok INTEGER NOT NULL
    )`);
    return fn(db);
  } finally {
    db.close();
  }
}

async function nseJson(path: string): Promise<unknown> {
  const res = await fetch(`${NSE}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: `${NSE}/companies-listing/corporate-filings-shareholding-pattern` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`NSE ${res.status}`);
  return res.json();
}

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};
/** "30-SEP-2026" → "2026-09-30". */
function isoDate(d: string): string {
  const m = /^(\d{1,2})-([A-Z]{3})-(\d{4})$/i.exec(d.trim());
  return m ? `${m[3]}-${MONTHS[m[2]!.toUpperCase()] ?? "01"}-${m[1]!.padStart(2, "0")}` : d;
}

/** Named shareholders (name, category, % of shares) from a shareholding XBRL file. */
export function parseShpXbrl(xml: string): Array<Omit<Stake, "quarter"> & { shares: number | null }> {
  const out: Array<Omit<Stake, "quarter"> & { shares: number | null }> = [];
  const nameRe = /<in-bse-shp:NameOfTheShareholder[^>]*contextRef="D_([^"]+)"[^>]*>([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(xml))) {
    const ctx = m[1]!;
    const name = m[2]!.replace(/\s+/g, " ").trim();
    const esc = ctx.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pctM = new RegExp(`<in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares[^>]*contextRef="${esc}"[^>]*>([^<]+)<`).exec(xml);
    const shM = new RegExp(`<in-bse-shp:NumberOfShares[^>]*contextRef="${esc}"[^>]*>([^<]+)<`).exec(xml);
    const pct = pctM ? Number(pctM[1]) * 100 : null;
    out.push({
      holder: name,
      category: ctx.replace(/_Context\d+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2"),
      pct: pct != null && Number.isFinite(pct) ? pct : null,
      shares: shM ? Number(shM[1]) : null,
    });
  }
  return out;
}

/** Scan one company: latest filing → named holders saved. Skips a quarter already scanned. */
async function scanOne(symbol: string, market: string, known?: string | null): Promise<boolean> {
  // NSE keeps SME filings under a separate index.
  const index = market === "NSE SME" ? "sme" : "equities";
  const list = (await nseJson(
    `/api/corporate-share-holdings-master?index=${index}&symbol=${encodeURIComponent(symbol)}`,
  )) as Array<{ date?: string; xbrl?: string }>;
  const latest = Array.isArray(list) ? list.find((r) => r.xbrl && r.date) : undefined;
  const now = new Date().toISOString();
  if (!latest) {
    withStakeDb((db) =>
      db.prepare(`INSERT OR REPLACE INTO holder_scan (symbol, quarter, scanned_at, ok) VALUES (?, NULL, ?, 0)`).run(symbol, now),
    );
    return false;
  }
  const quarter = isoDate(latest.date!);
  if (known === quarter) {
    withStakeDb((db) => db.prepare(`UPDATE holder_scan SET scanned_at = ? WHERE symbol = ?`).run(now, symbol));
    return true;
  }
  const res = await fetch(latest.xbrl!, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`XBRL ${res.status}`);
  const holders = parseShpXbrl(await res.text());
  withStakeDb((db) => {
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM holder_stakes WHERE symbol = ? AND quarter = ?`).run(symbol, quarter);
      const ins = db.prepare(
        `INSERT OR REPLACE INTO holder_stakes (symbol, quarter, holder, category, pct, shares) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const h of holders) ins.run(symbol, quarter, h.holder, h.category, h.pct, h.shares);
      db.prepare(`INSERT OR REPLACE INTO holder_scan (symbol, quarter, scanned_at, ok) VALUES (?, ?, ?, 1)`).run(
        symbol,
        quarter,
        now,
      );
    });
    tx();
  });
  return true;
}

function scanUniverse(ctx: Ctx): string[] {
  const inactive = inactiveListingTickers();
  const out: string[] = [];
  for (const [t, co] of ctx.cos) {
    if ((co.market !== "NSE" && co.market !== "NSE SME") || inactive.has(t)) continue;
    const m = ctx.mcap.get(t);
    if (m == null || m > HG_RULES.scanMaxMcapCr) continue;
    out.push(t);
  }
  return out.sort();
}

/** Background job: scan filings (skips companies scanned in the last 20 days). */
export async function runHolderScan(onProgress?: Progress): Promise<FillResult> {
  const ctx = loadCtx();
  const scanned = withStakeDb(
    (db) =>
      new Map(
        (db.prepare(`SELECT symbol, quarter, scanned_at, ok FROM holder_scan`).all() as Array<{
          symbol: string;
          quarter: string | null;
          scanned_at: string;
          ok: number;
        }>).map((r) => [r.symbol, r]),
      ),
  );
  const fresh = Date.now() - 20 * 86_400_000;
  const todo = scanUniverse(ctx).filter((t) => {
    const r = scanned.get(t);
    // Not scanned, empty last time, or older than 20 days.
    return !r || !r.ok || Date.parse(r.scanned_at) < fresh;
  });
  let done = 0;
  let filled = 0;
  onProgress?.(0, todo.length, 0);
  for (let i = 0; i < todo.length; i += 2) {
    const wave = todo.slice(i, i + 2);
    await Promise.all(
      wave.map(async (t) => {
        try {
          if (await scanOne(t, ctx.cos.get(t)?.market ?? "NSE", scanned.get(t)?.quarter)) filled += 1;
        } catch {
          /* skip; retried next run */
        }
        done += 1;
      }),
    );
    onProgress?.(done, todo.length, filled);
    await new Promise((r) => setTimeout(r, 250));
  }
  return { tried: todo.length, filled, left: 0, not_found: todo.length - filled };
}

/** Latest-quarter named holders per symbol. */
function loadStakes(): Map<string, Stake[]> {
  return withStakeDb((db) => {
    const rows = db
      .prepare(
        `SELECT h.symbol, h.quarter, h.holder, h.category, h.pct FROM holder_stakes h
         JOIN holder_scan s ON s.symbol = h.symbol AND s.quarter = h.quarter`,
      )
      .all() as Array<{ symbol: string; quarter: string; holder: string; category: string; pct: number | null }>;
    const out = new Map<string, Stake[]>();
    for (const r of rows) {
      const list = out.get(r.symbol) ?? [];
      list.push({ holder: r.holder, category: r.category, pct: r.pct, quarter: r.quarter });
      out.set(r.symbol, list);
    }
    return out;
  });
}

/** Institutional categories in the filing (not individuals, NRIs or companies). */
const FUND_CATS =
  /alternative investment|mutual funds?|foreign portfolio investor|insurance compan|venture capital|other institutions|sovereign|pension/i;

// ---- ATAM-like screen ---------------------------------------------------------

/** Latest borrowings ÷ net worth from the cached Screener balance sheet. */
function loadDebtToEquity(): Map<string, number> {
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const out = new Map<string, number>();
    for (const r of db.prepare(`SELECT ticker, bs_json FROM screener_annual_bs_cache`).all() as Array<{
      ticker: string;
      bs_json: string;
    }>) {
      try {
        const bs = JSON.parse(r.bs_json) as { borrowings?: Array<number | null>; book_value?: Array<number | null> };
        const debt = bs.borrowings?.at(-1);
        const nw = bs.book_value?.at(-1);
        if (debt != null && nw != null && nw > 0) out.set(r.ticker.toUpperCase(), debt / nw);
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return new Map();
  } finally {
    db.close();
  }
}

type Q = { date: string; revenue: number | null; netIncome: number | null; ebit: number | null };
const mIdx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));

/**
 * Yearly figures from quarterly or half-yearly periods: last-12-month sales
 * and profit, best 12-month profit in the last 3 years, and the share of
 * periods with an operating profit. Values in rupees are scaled to ₹ Cr.
 */
function periodStats(raw: Q[] | undefined) {
  if (!raw || raw.length < 4) return null;
  const qs = [...raw].sort((a, b) => a.date.localeCompare(b.date));
  const gaps = qs.slice(1).map((q, i) => mIdx(q.date) - mIdx(qs[i]!.date));
  const gap = gaps.filter((g) => g === 6).length > gaps.length / 2 ? 6 : 3;
  const per = 12 / gap;
  const revs = qs.map((q) => Math.abs(q.revenue ?? 0)).sort((a, b) => a - b);
  const scale = (revs[Math.floor(revs.length / 2)] ?? 0) > 1e5 ? 1e-7 : 1;
  const last3y = qs.filter((q) => mIdx(q.date) > mIdx(qs.at(-1)!.date) - 36);
  const ttm = (end: number, key: "revenue" | "netIncome") => {
    const w = qs.slice(Math.max(0, end - per + 1), end + 1);
    if (w.length < per || w.some((q) => q[key] == null)) return null;
    return w.reduce((s, q) => s + (q[key] as number), 0) * scale;
  };
  const n = qs.length - 1;
  const ttmRev = ttm(n, "revenue");
  const ttmNp = ttm(n, "netIncome");
  let peak: number | null = null;
  for (let i = n; i >= 0 && mIdx(qs[i]!.date) > mIdx(qs[n]!.date) - 36; i--) {
    const v = ttm(i, "netIncome");
    if (v != null && (peak == null || v > peak)) peak = v;
  }
  const withEbit = last3y.filter((q) => q.ebit != null);
  const profitableShare = withEbit.length ? withEbit.filter((q) => (q.ebit as number) > 0).length / withEbit.length : null;
  return { ttmRev, ttmNp, peak, profitableShare, latest: qs[n]!.date };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const ramp = (x: number | null | undefined, a: number, b: number, max: number) =>
  x == null || !Number.isFinite(x) ? 0 : Math.round(clamp((x - a) / (b - a), 0, 1) * max);

function toHg(
  t: string,
  ctx: Ctx,
  stakes: Map<string, Stake[]>,
  price?: PriceRow,
  de?: Map<string, number>,
): HgStock {
  const s = buildStock(t, ctx);
  const ps = periodStats(ctx.quarters.get(t) as Q[] | undefined);
  const mcap = s.mcap_cr;
  const peOnPeak = ps?.peak && ps.peak > 0 && mcap ? mcap / ps.peak : null;
  const pToS = ps?.ttmRev && ps.ttmRev > 0 && mcap ? mcap / ps.ttmRev : null;
  const vsPeak = ps?.peak && ps.peak > 0 && ps.ttmNp != null ? (ps.ttmNp / ps.peak - 1) * 100 : null;
  const list = stakes.get(t) ?? [];
  const tri = list.find((x) => x.holder.toUpperCase().includes(HG_FUND_MATCH)) ?? null;
  const funds = list
    .filter((x) => FUND_CATS.test(x.category) && !x.holder.toUpperCase().includes(HG_FUND_MATCH))
    .map((x) => x.holder);
  const boardKnown = s.board >= 4 && s.independent > 0 && s.independent < s.board;
  const hg: HgStock = {
    ...s,
    latest_quarter: ps?.latest ?? s.latest_quarter,
    pe_on_peak: peOnPeak,
    price_to_sales: pToS,
    profit_vs_peak_pct: vsPeak,
    profitable_share: ps?.profitableShare ?? null,
    from_high_pct: price?.fromHigh ?? null,
    debt_to_equity: de?.get(t) ?? null,
    trilithon: tri,
    other_funds: funds,
    board_known: boardKnown,
    score: null,
    score_parts: [],
  };
  const parts = [
    // Cheap against normal earnings — 40
    { label: "P/E on best year", points: peOnPeak != null && peOnPeak > 0 ? ramp(12 - peOnPeak, 0, 8, 25) : 0, max: 25 },
    { label: "Price to sales", points: pToS != null ? ramp(1.5 - pToS, 0, 1, 15) : 0, max: 15 },
    // A real business on record — 25
    { label: "Profitable record", points: ramp(hg.profitable_share, 0.75, 1, 15), max: 15 },
    { label: "Best-year profit margin", points: ps?.peak && ps.ttmRev ? ramp((ps.peak / ps.ttmRev) * 100, 3, 12, 10) : 0, max: 10 },
    // Bought in a bad patch — 20
    { label: "Profit below its best", points: ramp(-(vsPeak ?? 0), 0, 60, 10), max: 10 },
    { label: "Price below its high", points: ramp(-(price?.fromHigh ?? 0), 20, 60, 10), max: 10 },
    // Governance — 15
    { label: "Independent board", points: boardKnown ? ramp(s.independent / s.board, 1 / 3, 2 / 3, 10) : 0, max: 10 },
    { label: "Well-connected directors", points: ramp(s.linked_boards, 0, 5, 5), max: 5 },
  ];
  hg.score = parts.reduce((n, p) => n + p.points, 0);
  hg.score_parts = parts;
  return hg;
}

function screenShortlist(
  ctx: Ctx,
  exclude: Set<string>,
  ibc: Set<string> = new Set(),
  de: Map<string, number> = new Map(),
): string[] {
  const inactive = inactiveListingTickers();
  const out: string[] = [];
  for (const [t, co] of ctx.cos) {
    if (!["NSE", "NSE SME", "BSE SME"].includes(co.market) || inactive.has(t) || exclude.has(t)) continue;
    const m = ctx.mcap.get(t);
    if (m == null || m < HG_RULES.minMcapCr || m > HG_RULES.maxMcapCr) continue;
    const ps = periodStats(ctx.quarters.get(t) as Q[] | undefined);
    if (!ps || ps.peak == null || ps.peak <= 0 || ps.ttmRev == null || ps.ttmRev <= 0) continue;
    if (ibc.has(t)) continue;
    if (m / ps.peak > HG_RULES.maxPeOnPeak || m / ps.peak < HG_RULES.minPeOnPeak) continue;
    // Still profitable today — a dip, not a collapse.
    if (ps.ttmNp == null || ps.ttmNp <= 0) continue;
    const d = de.get(t);
    if (d != null && d > HG_RULES.maxDebtToEquity) continue;
    if (m / ps.ttmRev > HG_RULES.maxPriceToSales) continue;
    if (ps.profitableShare == null || ps.profitableShare < HG_RULES.minProfitableShare) continue;
    const s = buildStock(t, ctx);
    // Board: required where known; SME boards are often missing, so unknown passes (flagged).
    const known = s.board >= 4 && s.independent > 0 && s.independent < s.board;
    if (known && s.independent / s.board < HG_RULES.minIndependentShare) continue;
    out.push(t);
  }
  return out;
}

/** Companies in insolvency (IBC) per NSE's surveillance list. */
async function ibcSet(): Promise<Set<string>> {
  try {
    const { map } = await loadSurveillance();
    return new Set([...map].filter(([, v]) => /ibc|insolvency/i.test(`${v.stage} ${v.desc}`)).map(([k]) => k));
  } catch {
    return new Set();
  }
}

export async function buildHgPage(): Promise<HgPage> {
  const ctx = loadCtx();
  const stakes = loadStakes();
  const prices = loadPrices();
  const de = loadDebtToEquity();
  const ibc = await ibcSet();
  const holdingsT = loadCurrent(HG_LIST_KEY);
  const holdSet = new Set(holdingsT);

  const holdings: HgStock[] = [];
  for (const t of holdingsT) holdings.push(toHg(t, ctx, stakes, await checkPrice(t), de));

  const triTickers = [...stakes.entries()]
    .filter(([, list]) => list.some((x) => x.holder.toUpperCase().includes(HG_FUND_MATCH)))
    .map(([t]) => t);
  const trilithon = triTickers
    .map((t) => toHg(t, ctx, stakes, prices.get(t), de))
    .sort((a, b) => (b.trilithon?.pct ?? 0) - (a.trilithon?.pct ?? 0));

  const triSet = new Set(triTickers);
  const short = screenShortlist(ctx, new Set([...holdSet, ...triSet]), ibc, de);
  const fresh = (t: string) => {
    const p = prices.get(t);
    return p && Date.now() - Date.parse(p.at) < 3 * 86_400_000 ? p : undefined;
  };
  const candidates = short
    .map((t) => toHg(t, ctx, stakes, fresh(t), de))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, HG_TOP_N);

  const scanInfo = withStakeDb((db) => {
    const r = db.prepare(`SELECT COUNT(*) AS n, MAX(scanned_at) AS at FROM holder_scan`).get() as { n: number; at: string | null };
    const h = db.prepare(`SELECT COUNT(DISTINCT holder) AS n FROM holder_stakes`).get() as { n: number };
    return { scanned: r.n, last_at: r.at, holders_found: h.n };
  });

  return {
    basket: "hg",
    holdings,
    trilithon,
    candidates,
    scan: { universe: scanUniverse(ctx).length, ...scanInfo },
    shortlist: short.length,
    price_checked: short.filter((t) => fresh(t)).length,
    rules: HG_RULES,
  };
}

/** Background job: price check (fall from 3-year high) and debt for the screen's shortlist. */
export async function runHgPriceCheck(onProgress?: Progress): Promise<FillResult> {
  const ctx = loadCtx();
  const prices = loadPrices();
  const de = loadDebtToEquity();
  const short = screenShortlist(ctx, new Set(), await ibcSet());
  const todo = short.filter((t) => {
    const p = prices.get(t);
    return !p || Date.now() - Date.parse(p.at) >= 86_400_000;
  });
  const needDebt = short.filter((t) => !de.has(t));
  const total = todo.length + needDebt.length;
  let done = 0;
  let filled = 0;
  onProgress?.(0, total, 0);
  for (let i = 0; i < todo.length; i += 4) {
    const wave = await Promise.all(todo.slice(i, i + 4).map((t) => checkPrice(t)));
    for (const r of wave) {
      done += 1;
      if (r.fromHigh != null) filled += 1;
    }
    onProgress?.(done, total, filled);
  }
  // Debt from Screener's annual balance sheet (throttled, one at a time).
  for (const t of needDebt) {
    try {
      const bs = await fetchScreenerAnnualBs(t);
      if (bs.dates.length) filled += 1;
    } catch (e) {
      if (String(e).toLowerCase().includes("paused")) break;
    }
    done += 1;
    onProgress?.(done, total, filled);
  }
  return { tried: total, filled, left: 0, not_found: total - filled };
}
