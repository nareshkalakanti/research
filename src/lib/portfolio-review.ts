import { adjustedShareCount, annualPoints, bookValuePerShare, businessBreak, cagrCheck, ROCE_MIN, roceAverage } from "./napkin/quality-flags";
import { runConcurrent } from "./scrape-pool";
import { buildScannerData } from "./scanner";
import {
  annualCachesFresh,
  cachedAnnualPlBs,
  fetchScreenerAnnual,
  fetchScreenerAnnualBs,
  fetchScreenerAnnualPl,
  clearScreenerStatementCaches,
  ingestCompanyPageHtml,
  ingestRicherCompanyPageHtml,
  seriesStale,
} from "./screener-annual";
import {
  loadCachedQuartersSeries,
  parseScreenerQuarterlyHtml,
  upsertQuartersCache,
} from "./screener-quarters";
import { invalidateQuarterMetricsCache } from "./quarter-metrics-cache";
import {
  fetchScreenerShareholding,
  ingestShareholdingHtml,
  shareholdingFetchedWithin,
} from "./screener-shareholding";
import { fetchScreenerPeers, rememberWarehouseFromHtml, screenerPeerColumnsMissingSince } from "./screener-peers";
import {
  fetchScreenerCompanyHtml,
  markScreenerInteractive,
  screenerPausedUntil,
} from "./screener-fetch";
import { loadHtIvMap } from "./strategy/ht-store";
import { fetchCashDebt } from "./yfinance";
import { trailingYear } from "./ttm";
import { latestAnnualEpsPat, pickCurrentEps } from "./napkin/current-eps";
import { openSqliteNamed } from "./sqlite-utils";
import { roce3yFromAnnual, sales3yFromAnnual } from "./value-legs-math";

/**
 * Portfolio review: your stocks, each with a Fundamental score out of 6
 * (+1 per check passed), from Screener's company page (cached).
 *
 *   Book value growth   10-year CAGR > 10%, per share (book value ÷ equity capital,
 *                       so new share issues don't count as growth)
 *   Sales growth        10-year CAGR > 10%
 *   ROCE                10-year average > 10%
 *   Interest coverage   (PBT + interest) ÷ interest > 5, latest year (no interest = pass)
 *   Capex (net block)   net block more than 2× the previous year
 *   Quality turnover    other income ÷ total revenue (sales + other income) < 10%
 *
 * Stocks are stored in data/portfolio_review.db.
 * Canonical bag is `portfolio` (dedicated Portfolio page). Legacy bags
 * (value / rotation / dashboard) are migrated into it on open.
 */

export {
  PORTFOLIO_BAG,
  parseReviewBag,
  type ReviewBag,
} from "./portfolio-review-types";
import { PORTFOLIO_BAG, type ReviewBag } from "./portfolio-review-types";

export const FUND = { cagr: 10, roce: 10, icr: 5, capexX: 2, otherIncomeMax: 10 } as const;

export type FundCheck = {
  id: string;
  label: string;
  rule: string;
  value: string;
  /** Points from this check (+1 passed · 0 failed; valuation can give −1 or +2) · null no data. */
  points: number | null;
  note?: string;
};
export type ReviewRow = {
  t: string;
  name: string;
  market: string;
  industry: string | null;
  mcap: number | null;
  added_at: string;
  /** Value-page quality legs (when available). */
  sales3y: number | null;
  roce3y: number | null;
  pb: number | null;
  fundamental: number;
  scored: number;
  checks: FundCheck[];
  /** Management score out of 5 (shareholding checks). */
  management: number;
  m_scored: number;
  m_checks: FundCheck[];
  /** Quality = fundamental + management (out of 11). */
  quality: number;
  /** Valuation score, −4 … +6. */
  valuation: number;
  v_scored: number;
  v_checks: FundCheck[];
  /** Quality + valuation, out of 17. */
  total: number;
  total_max: number;
  rating: "Excellent" | "Good" | "Average" | "Poor" | "Incomplete" | "No data";
};

export const MGMT = { pledgeMax: 0, institutionalMin: 1 } as const;
export const VALN = { peerMin: 3, expensive: 2, growthCap: 20 } as const;
/** Final rating on the total (out of 17): Excellent 13+ · Good 9–12 · Average 5–8 · Poor ≤ 4. */
export const RATING = { excellent: 13, good: 9, average: 5 } as const;

/** Per industry: each company's P/B and P/S (the median is taken without the stock itself). */
type PeerVals = Array<{ t: string; v: number }>;
type Peers = { pb: Map<string, PeerVals>; ps: Map<string, PeerVals> };

/**
 * Median of the other companies in the industry — never the stock itself
 * (in a 3-company industry the middle one would always "match" its own
 * median). Needs VALN.peerMin others, else null.
 */
export function peerMedian(vals: PeerVals | undefined, t: string): { m: number; n: number } | null {
  const xs = (vals ?? []).filter((x) => x.t !== t.toUpperCase()).map((x) => x.v).sort((a, b) => a - b);
  if (xs.length < VALN.peerMin) return null;
  const m = xs.length % 2 ? xs[xs.length >> 1]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2;
  return { m, n: xs.length };
}

/** Last 4 quarters, only when the newest is recent (some caches stop years ago). */
function recentQuarters(t: string) {
  // Some caches (Yahoo-sourced) hold rupees, not crores: no Indian company has
  // ₹10 lakh Cr of quarterly sales, so anything that big is in rupees → ÷ 1e7.
  const qs = [...(loadCachedQuartersSeries(t) ?? [])]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((q) =>
      Math.abs(q.revenue ?? 0) > 1e6
        ? {
            ...q,
            revenue: q.revenue == null ? null : q.revenue / 1e7,
            netIncome: q.netIncome == null ? null : q.netIncome / 1e7,
            ebit: q.ebit == null ? null : q.ebit / 1e7,
          }
        : q,
    );
  // 4 consecutive quarters or 2 consecutive half-years (SME filers), recent.
  return trailingYear(qs, Date.now(), (q) => q.revenue != null || q.netIncome != null);
}

/** Industry medians of P/B and P/S (3+ peers with data), built once per review. */
function loadPeers(): {
  industryOf: Map<string, string | null>;
  peers: Peers;
  price: Map<string, number | null>;
  mcap: Map<string, number | null>;
  htPb: Map<string, number>;
} {
  const scan = buildScannerData().rows;
  const legs = new Map<string, { sales: number | null; bv: number | null }>();
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, annual_json FROM screener_annual_cache`).all() as Array<{ t: string; annual_json: string }>) {
        try {
          const a = JSON.parse(r.annual_json) as { sales: Array<number | null> };
          const sales = [...a.sales].reverse().find((v) => v != null && v > 0) ?? null;
          legs.set(r.t, { sales, bv: null });
        } catch {
          /* skip */
        }
      }
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, bs_json FROM screener_annual_bs_cache`).all() as Array<{ t: string; bs_json: string }>) {
        try {
          const b = JSON.parse(r.bs_json) as { dates: string[]; book_value: Array<number | null> };
          const bv = fullYearBookValue(b.dates, b.book_value);
          legs.set(r.t, { sales: legs.get(r.t)?.sales ?? null, bv });
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
  // Wider P/B coverage: the quality cache's P/B (Yahoo / Screener) for stocks without a balance sheet here.
  const htPb = new Map<string, number>();
  for (const [t, h] of loadHtIvMap()) if (h.pb != null && Number.isFinite(h.pb) && h.pb > 0) htPb.set(t.toUpperCase(), h.pb);
  // Wider P/S coverage: last-4-quarter sales.
  const ttmSales = (t: string) => {
    const q = recentQuarters(t);
    return q && q.every((x) => x.revenue != null) ? q.reduce((a, x) => a + (x.revenue as number), 0) : null;
  };
  const by = new Map<string, { pb: PeerVals; ps: PeerVals }>();
  const industryOf = new Map<string, string | null>();
  const price = new Map<string, number | null>();
  const mcap = new Map<string, number | null>();
  for (const r of scan) {
    industryOf.set(r.t, r.industry);
    price.set(r.t, r.price);
    mcap.set(r.t, r.mcap);
    if (!r.industry || !r.mcap) continue;
    const l = legs.get(r.t);
    const e = by.get(r.industry) ?? { pb: [], ps: [] };
    const pb = l?.bv ? r.mcap / l.bv : htPb.get(r.t) ?? null;
    const key = r.t.toUpperCase();
    if (pb != null && pb > 0) e.pb.push({ t: key, v: pb });
    const sales = l?.sales ?? ttmSales(r.t);
    if (sales && sales > 0) e.ps.push({ t: key, v: r.mcap / sales });
    by.set(r.industry, e);
  }
  const peers: Peers = { pb: new Map(), ps: new Map() };
  for (const [ind, e] of by) {
    peers.pb.set(ind, e.pb);
    peers.ps.set(ind, e.ps);
  }
  return { industryOf, peers, price, mcap, htPb };
}

/** Latest positive book value in the full-year columns (the most common month,
 *  i.e. March), skipping half-year columns Screener appends. */
function fullYearBookValue(dates: string[] | undefined, values: Array<number | null> | undefined): number | null {
  if (!dates?.length || !values?.length) return null;
  const months = new Map<string, number>();
  for (const d of dates) months.set(d.slice(5, 7), (months.get(d.slice(5, 7)) ?? 0) + 1);
  const main = [...months].sort((x, y) => y[1] - x[1])[0]?.[0];
  for (let i = dates.length - 1; i >= 0; i--) {
    const v = values[i];
    if (dates[i]!.slice(5, 7) === main && v != null && v > 0) return v;
  }
  return null;
}

/** Latest full-year book value, sign included (zero / negative = negative equity). */
function latestFullYearBookValue(dates: string[] | undefined, values: Array<number | null> | undefined): number | null {
  if (!dates?.length || !values?.length) return null;
  const months = new Map<string, number>();
  for (const d of dates) months.set(d.slice(5, 7), (months.get(d.slice(5, 7)) ?? 0) + 1);
  const main = [...months].sort((x, y) => y[1] - x[1])[0]?.[0];
  for (let i = dates.length - 1; i >= 0; i--) {
    const v = values[i];
    if (dates[i]!.slice(5, 7) === main && v != null) return v;
  }
  return null;
}

function ensureReviewSchema(db: ReturnType<typeof openSqliteNamed>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS portfolio_review (
    ticker TEXT PRIMARY KEY,
    added_at TEXT NOT NULL
  )`);
  const cols = db.prepare(`PRAGMA table_info(portfolio_review)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "bag")) {
    // One-time: old PK was ticker-only — split Value vs Rotation lists.
    db.exec(`
      ALTER TABLE portfolio_review RENAME TO portfolio_review_legacy;
      CREATE TABLE portfolio_review (
        ticker TEXT NOT NULL,
        bag TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (ticker, bag)
      );
      INSERT INTO portfolio_review (ticker, bag, added_at)
        SELECT ticker, 'value', added_at FROM portfolio_review_legacy;
      DROP TABLE portfolio_review_legacy;
    `);
  }
  // Fold legacy page bags into the dedicated Portfolio list (one ticker once).
  db.exec(`
    INSERT OR IGNORE INTO portfolio_review (ticker, bag, added_at)
    SELECT ticker, 'portfolio', MIN(added_at)
    FROM portfolio_review
    WHERE bag IN ('value', 'rotation', 'dashboard')
    GROUP BY ticker
  `);
  // Finished scores survive server restarts — do not re-hit Screener every load.
  db.exec(`CREATE TABLE IF NOT EXISTS portfolio_scores (
    ticker TEXT PRIMARY KEY,
    scored_at INTEGER NOT NULL,
    ttl_ms INTEGER NOT NULL,
    checks_json TEXT NOT NULL,
    m_json TEXT NOT NULL,
    val_json TEXT NOT NULL
  )`);
}

function withDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("portfolio_review.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    ensureReviewSchema(db);
    return fn(db);
  } finally {
    db.close();
  }
}

const pct = (v: number) => `${v.toFixed(1)}%`;

/** Name, NSE symbol or BSE code → our ticker. */
export function resolveTickers(inputs: string[], fresh = false): { found: string[]; missing: string[] } {
  const rows = buildScannerData({ fresh }).rows;
  const byT = new Map(rows.map((r) => [r.t.toUpperCase(), r.t]));
  const byName = new Map<string, string>();
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(limited|ltd|the)\b\.?/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  for (const r of rows) byName.set(norm(r.name), r.t);
  const bse = new Map<string, string>();
  try {
    const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
    try {
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, scrip_code AS c FROM company_bse_scrip`).all() as Array<{ t: string; c: string }>)
        bse.set(String(r.c).trim(), r.t);
    } finally {
      db.close();
    }
  } catch {
    /* optional */
  }
  const found: string[] = [];
  const missing: string[] = [];
  for (const raw of inputs) {
    const x = raw.trim().replace(/^(NSE|BSE)\s*:\s*/i, "");
    if (!x) continue;
    const hit = byT.get(x.toUpperCase()) ?? (/^\d{6}$/.test(x) ? bse.get(x) : undefined) ?? byName.get(norm(x));
    if (hit && byT.has(hit.toUpperCase())) found.push(byT.get(hit.toUpperCase())!);
    else missing.push(raw.trim());
  }
  // The stock list is cached for 10 min: a listing added since then (e.g. a
  // new IPO from the ticker search) would read as "not found". Rebuild once.
  if (missing.length && !fresh) {
    const again = resolveTickers(missing, true);
    return { found: [...new Set([...found, ...again.found])], missing: again.missing };
  }
  return { found: [...new Set(found)], missing };
}

export function addToReview(
  tickers: string[],
  bag: ReviewBag = PORTFOLIO_BAG,
): number {
  const now = new Date().toISOString();
  return withDb((db) => {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO portfolio_review (ticker, bag, added_at) VALUES (?, ?, ?)`,
    );
    let n = 0;
    db.transaction(() => {
      for (const t of tickers) {
        const key = t.toUpperCase();
        // Always land on the Portfolio page bag; drop legacy duplicates.
        n += ins.run(key, PORTFOLIO_BAG, now).changes;
        if (bag !== PORTFOLIO_BAG) {
          db.prepare(
            `DELETE FROM portfolio_review WHERE ticker = ? AND bag != ?`,
          ).run(key, PORTFOLIO_BAG);
        }
      }
    })();
    return n;
  });
}

/** Tickers on the Portfolio page (canonical bag). */
export function listReviewTickers(bag: ReviewBag = PORTFOLIO_BAG): string[] {
  return withDb((db) => {
    const target = bag === PORTFOLIO_BAG ? PORTFOLIO_BAG : bag;
    return (
      db
        .prepare(`SELECT ticker FROM portfolio_review WHERE bag = ? ORDER BY ticker`)
        .all(target) as Array<{ ticker: string }>
    ).map((r) => r.ticker.toUpperCase());
  });
}

/** Set of Portfolio tickers — Value / Trend hide these once added. */
export function portfolioReviewTickerSet(): Set<string> {
  return new Set(listReviewTickers(PORTFOLIO_BAG));
}

export function removeFromReview(
  ticker: string | null,
  bag: ReviewBag = PORTFOLIO_BAG,
): void {
  withDb((db) => {
    if (ticker) {
      const key = ticker.toUpperCase();
      // Removing from Portfolio clears every bag for that ticker.
      if (bag === PORTFOLIO_BAG) {
        db.prepare(`DELETE FROM portfolio_review WHERE ticker = ?`).run(key);
      } else {
        db.prepare(`DELETE FROM portfolio_review WHERE ticker = ? AND bag = ?`).run(
          key,
          bag,
        );
      }
    } else if (bag === PORTFOLIO_BAG) {
      db.prepare(`DELETE FROM portfolio_review`).run();
    } else {
      db.prepare(`DELETE FROM portfolio_review WHERE bag = ?`).run(bag);
    }
  });
}

/**
 * One company page fills annual + P&L + BS + shareholding + warehouse id.
 * Old path fanned out 6–10 Screener hits per add and tripped the global pause.
 * Skip when caches are fresh or Screener is paused (scorers use age-expired).
 */
async function warmScreenerForReview(ticker: string, opts?: { force?: boolean }): Promise<void> {
  const t = ticker.trim().toUpperCase();
  if (!t) return;
  if (screenerPausedUntil()) return;
  const fresh = annualCachesFresh(t);
  const shFresh = shareholdingFetchedWithin(t);
  if (!opts?.force && fresh.annual && fresh.pl && fresh.bs && shFresh) return;
  // Hold the lane so Value/baskets bulk fills do not run on top of this.
  markScreenerInteractive(90_000);
  try {
    const html = await fetchScreenerCompanyHtml(t, { consolidated: true });
    // Forced refresh: the page is in hand, so old statements (possibly another
    // company's) can go before the new ones are saved.
    if (opts?.force) {
      clearScreenerStatementCaches(t);
      // Quarters come from the same page: save them now (no second request).
      const quarters = parseScreenerQuarterlyHtml(html);
      if (quarters.length) upsertQuartersCache(t, quarters);
      invalidateQuarterMetricsCache();
    }
    const got = ingestCompanyPageHtml(t, html);
    ingestShareholdingHtml(t, html);
    rememberWarehouseFromHtml(t, html);
    const cached = await fetchScreenerAnnual(t, { cacheOnly: true });
    const salesN = got.annual
      ? cached.sales.filter((s) => s != null && s > 0).length
      : 0;
    // Short or stale consolidated (demerger: cons stops years ago) → standalone.
    if (salesN < 4 || seriesStale(cached.dates) || !got.pl || !got.bs) {
      try {
        const stand = await fetchScreenerCompanyHtml(t, { consolidated: false });
        ingestRicherCompanyPageHtml(t, stand);
        ingestShareholdingHtml(t, stand);
        rememberWarehouseFromHtml(t, stand);
      } catch {
        /* keep consolidated */
      }
    }
  } catch {
    /* scorers fall back to age-expired cache */
  }
}

function cagrFundCheck(
  id: "bv" | "sales",
  label: string,
  dates: string[] | undefined,
  vals: Array<number | null> | undefined,
  shareCapital: { dates: string[]; values: Array<number | null> } | undefined,
  brk: ReturnType<typeof businessBreak>,
): FundCheck {
  if (!dates?.length || !vals) return { id, label, rule: `> ${FUND.cagr}% CAGR · up to 10 yrs`, value: "—", points: null, note: "No data" } as FundCheck;
  const c = cagrCheck(id, label, dates, vals, { ...(shareCapital ? { shareCapital } : {}), businessBreak: brk });
  // Rule shows the span actually used (10 / 5 / 3), not a fixed "10 yrs".
  const spanNote = c.note?.match(/^(\d+)\s*yrs/)?.[1];
  const spanLabel = spanNote ? `${spanNote} yrs` : "up to 10 yrs";
  return {
    id,
    label,
    rule: `> ${FUND.cagr}% CAGR · ${spanLabel}`,
    value: c.value,
    points: c.verdict === "na" ? null : c.verdict === "pass" ? 1 : 0,
    note: c.note,
  } as FundCheck;
}

/**
 * Book value per share growth (shared rule, see bookValuePerShare). Shares
 * really issued in the window (placements, rights, debt converted) make the
 * per-share history not comparable: marked "not scored". Bonus issues are not
 * dilution (see adjustedShareCount).
 */
function bookValueCheck(
  pl: Parameters<typeof bookValuePerShare>[0],
  bs: (NonNullable<Parameters<typeof bookValuePerShare>[1]> & { dates: string[] }) | null | undefined,
  brk: ReturnType<typeof businessBreak>,
): FundCheck {
  return cagrFundCheck("bv", "Book value growth (per share)", bs?.dates, bookValuePerShare(pl, bs), adjustedShareCount(pl, bs), brk);
}

/** Saved before bonus issues stopped counting as dilution (25 Nov 2026). */
const OLD_BV_DILUTION = /Not comparable: share capital \+\d+% \(shares issued\)/;

/**
 * A saved score whose book value check was skipped by the old share-capital
 * rule: re-derive that one check from the cached statements (no Screener
 * fetch) and save it back. Returns the bundle unchanged otherwise.
 */
function migrateBvCheck(ticker: string, v: ScoreBundle): ScoreBundle {
  const i = v.checks.findIndex((c) => c.id === "bv");
  if (i < 0 || !OLD_BV_DILUTION.test(v.checks[i]!.note ?? "")) return v;
  const { pl, bs } = cachedAnnualPlBs(ticker);
  if (!pl?.dates.length || !bs?.dates.length) return v;
  const checks = [...v.checks];
  checks[i] = bookValueCheck(pl, bs, businessBreak(pl.dates, pl.revenue));
  const next = { ...v, checks };
  writeDiskScore(ticker, next);
  return next;
}

async function scoreFundamental(t: string): Promise<FundCheck[]> {
  const [annual, pl, bs] = await Promise.all([
    fetchScreenerAnnual(t).catch(() => null),
    fetchScreenerAnnualPl(t).catch(() => null),
    fetchScreenerAnnualBs(t).catch(() => null),
  ]);
  const checks: FundCheck[] = [];
  // Business changed in the history (shell took in a new business): growth across it not comparable.
  const brk = businessBreak(pl?.dates.length ? pl.dates : annual?.dates, pl?.dates.length ? pl.revenue : annual?.sales);
  const fromCagr = (
    id: "bv" | "sales",
    label: string,
    dates: string[] | undefined,
    vals: Array<number | null> | undefined,
  ) => cagrFundCheck(id, label, dates, vals, undefined, brk);
  checks.push(bookValueCheck(pl, bs, brk));
  checks.push(
    fromCagr("sales", "Sales growth", pl?.dates.length ? pl.dates : annual?.dates, pl?.dates.length ? pl.revenue : annual?.sales),
  );
  // ROCE 10-year average (shared rule, see roceAverage).
  {
    const r = roceAverage(annual, brk);
    if (r) {
      checks.push({
        id: "roce",
        label: "ROCE",
        rule: `> ${ROCE_MIN}% average · ${r.years} yrs`,
        value: pct(r.avg),
        points: r.avg > ROCE_MIN ? 1 : 0,
        note: `${r.years} yrs average · FY${r.from} → FY${r.to}`,
      });
    } else checks.push({ id: "roce", label: "ROCE", rule: `> ${ROCE_MIN}% average · up to 10 yrs`, value: "—", points: null, note: "Not enough years" });
  }
  // Interest coverage, latest year
  {
    const i = pl ? pl.dates.length - 1 : -1;
    const interest = i >= 0 ? pl!.interest[i] : null;
    const pbt = i >= 0 ? pl!.pbt[i] : null;
    if (interest == null || pbt == null) checks.push({ id: "icr", label: "Interest coverage ratio", rule: `> ${FUND.icr}×`, value: "—", points: null, note: "No P&L" });
    else if (interest <= 0.01) checks.push({ id: "icr", label: "Interest coverage ratio", rule: `> ${FUND.icr}×`, value: "No interest", points: 1, note: `FY ${pl!.dates[i]!.slice(0, 4)}` });
    else {
      const icr = (pbt + interest) / interest;
      checks.push({ id: "icr", label: "Interest coverage ratio", rule: `> ${FUND.icr}×`, value: `${icr.toFixed(1)}×`, points: icr > FUND.icr ? 1 : 0, note: `FY ${pl!.dates[i]!.slice(0, 4)} · (PBT + interest) ÷ interest` });
    }
  }
  // Capex: net block more than 2× the previous year (the "capex story" query).
  {
    const pts = bs ? annualPoints(bs.dates, bs.fixed_assets) : [];
    const rule = `net block > ${FUND.capexX}× previous year`;
    if (pts.length >= 2) {
      const end = pts[pts.length - 1]!;
      const start = pts[pts.length - 2]!;
      const x = start.v > 0 ? end.v / start.v : null;
      checks.push({
        id: "capex",
        label: "Capex (net block)",
        rule,
        value: x == null ? `${start.v.toFixed(0)} → ${end.v.toFixed(0)} Cr` : `${x.toFixed(2)}×`,
        points: x != null && x > FUND.capexX ? 1 : 0,
        note: `₹${Math.round(start.v).toLocaleString("en-IN")} Cr (FY${start.date.slice(0, 4)}) → ₹${Math.round(end.v).toLocaleString("en-IN")} Cr (FY${end.date.slice(0, 4)})`,
      });
    } else checks.push({ id: "capex", label: "Capex (net block)", rule, value: "—", points: null, note: "No balance sheet" });
  }
  // Quality turnover: other income share of total revenue, latest year
  {
    const i = pl ? pl.dates.length - 1 : -1;
    const rev = i >= 0 ? pl!.revenue[i] : null;
    const oi = i >= 0 ? pl!.other_income[i] : null;
    if (rev == null || oi == null || rev + Math.max(0, oi) <= 0)
      checks.push({ id: "turnover", label: "Quality turnover", rule: `other income < ${FUND.otherIncomeMax}% of revenue`, value: "—", points: null, note: "No P&L" });
    else {
      const share = (Math.max(0, oi) / (rev + Math.max(0, oi))) * 100;
      checks.push({
        id: "turnover",
        label: "Quality turnover",
        rule: `other income < ${FUND.otherIncomeMax}% of revenue`,
        value: pct(share),
        points: share < FUND.otherIncomeMax ? 1 : 0,
        note: `FY ${pl!.dates[i]!.slice(0, 4)} · other income ₹${Math.round(oi).toLocaleString("en-IN")} Cr of ₹${Math.round(rev + Math.max(0, oi)).toLocaleString("en-IN")} Cr`,
      });
    }
  }
  return checks;
}

/**
 * Management score (out of 5), from Screener's shareholding table (12 quarters):
 *   Shareholder variation   number of shareholders fell over the last year, or since
 *                           listing when younger (stronger hands)
 *   Pledged percentage      promoter pledge is 0%
 *   Holding investor        FII + DII hold 1% or more
 *   Promoter holding, 3 yrs promoter stake higher than 3 years ago (unchanged = 0)
 *   Promoter holding, qtr   promoter stake higher than last quarter (unchanged = 0)
 */
type DatedPoint = { d: string; v: number };
const monthIndex = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));

/**
 * The point about `months` before the latest one, chosen by date (not by
 * column count — Screener has gaps, half-yearly filers and odd extra columns).
 * Within ±`tol` months → exact. Otherwise the earliest point after the target
 * (young listing / short history) → `partial`. Never a point far older than
 * the target.
 */
export function pointMonthsBack(s: DatedPoint[], months: number, tol = 2): { p: DatedPoint; partial: boolean } | null {
  if (s.length < 2) return null;
  const latest = s[s.length - 1]!;
  const target = monthIndex(latest.d) - months;
  let best: DatedPoint | null = null;
  for (const x of s.slice(0, -1)) {
    const gap = Math.abs(monthIndex(x.d) - target);
    if (gap <= tol && (!best || gap < Math.abs(monthIndex(best.d) - target))) best = x;
  }
  if (best) return { p: best, partial: false };
  const after = s.slice(0, -1).find((x) => monthIndex(x.d) > target);
  return after ? { p: after, partial: true } : null;
}

/** Previous filing at least ~2 months before the latest (skips same-quarter extra columns). */
export function previousFiling(s: DatedPoint[]): DatedPoint | null {
  if (s.length < 2) return null;
  const cut = monthIndex(s[s.length - 1]!.d) - 2;
  for (let i = s.length - 2; i >= 0; i--) if (monthIndex(s[i]!.d) <= cut) return s[i]!;
  return null;
}

async function scoreManagement(t: string): Promise<FundCheck[]> {
  const sh = await fetchScreenerShareholding(t).catch(() => null);
  const out: FundCheck[] = [];
  // Screener sometimes adds an off-cycle filing column (e.g. PVRINOX "2026-10-01"
  // one day after the Sep quarter): compare quarter-end filings only, as the
  // reference tool does, when the stock has any.
  const QUARTER_END = /-(03-31|06-30|09-30|12-31)$/;
  const keep = (sh?.dates ?? []).some((d) => QUARTER_END.test(d)) ? (d: string) => QUARTER_END.test(d) : () => true;
  const seq = (vals: Array<number | null> | undefined) =>
    (sh?.dates ?? [])
      .map((d, i) => ({ d, v: vals?.[i] ?? null }))
      .filter((x): x is { d: string; v: number } => x.v != null && keep(x.d));
  const q = (d: string) => d.slice(0, 7);
  // 1) Shareholder variation (latest vs ~1 year back, by date)
  {
    const s = seq(sh?.shareholders);
    const back = pointMonthsBack(s, 12);
    if (back) {
      const now = s[s.length - 1]!;
      const ago = back.p;
      const ch = ((now.v - ago.v) / ago.v) * 100;
      const span = monthIndex(now.d) - monthIndex(ago.d);
      out.push({
        id: "holders",
        label: "Shareholder variation",
        rule: "number of shareholders down over 1 yr",
        value: `${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`,
        points: now.v < ago.v ? 1 : 0,
        note: `${Math.round(ago.v).toLocaleString("en-IN")} (${q(ago.d)}) → ${Math.round(now.v).toLocaleString("en-IN")} (${q(now.d)})${back.partial ? ` · only ${span} months of data` : ""}`,
      });
    } else out.push({ id: "holders", label: "Shareholder variation", rule: "number of shareholders down over 1 yr", value: "—", points: null, note: "No shareholder count" });
  }
  // 2) Pledge
  {
    const p = sh?.pledged_pct ?? null;
    const prom = seq(sh?.promoters).at(-1)?.v ?? null;
    const ofCompany = p != null && prom != null && p > 0 ? (p * prom) / 100 : null;
    out.push({
      id: "pledge",
      label: "Pledged percentage",
      rule: "promoter pledge = 0%",
      value: p == null ? "—" : `${p.toFixed(2)}%`,
      points: p == null ? null : p <= MGMT.pledgeMax ? 1 : 0,
      note:
        ofCompany != null
          ? `of promoter shares · ≈ ${ofCompany.toFixed(1)}% of the company (promoters hold ${prom!.toFixed(1)}%)`
          : p === 0
            ? "no promoter shares pledged"
            : undefined,
    });
  }
  // 3) Holding investor: FII + DII
  {
    const f = seq(sh?.fii).at(-1)?.v ?? null;
    const d = seq(sh?.dii).at(-1)?.v ?? null;
    if (f == null && d == null) out.push({ id: "investor", label: "Holding investor", rule: `FII + DII ≥ ${MGMT.institutionalMin}%`, value: "—", points: null, note: "No shareholding data" });
    else {
      const inst = (f ?? 0) + (d ?? 0);
      out.push({
        id: "investor",
        label: "Holding investor",
        rule: `FII + DII ≥ ${MGMT.institutionalMin}%`,
        value: `${inst.toFixed(2)}%`,
        points: inst >= MGMT.institutionalMin ? 1 : 0,
        note: `FII ${f == null ? "—" : f.toFixed(2) + "%"} · DII ${d == null ? "—" : d.toFixed(2) + "%"}`,
      });
    }
  }
  // 4–5) Promoter holding: 3 years (quarterly + Screener's yearly table, by
  //      date) and vs the previous filing.
  {
    const s = seq(sh?.promoters);
    const yearly = (sh?.yearly_dates ?? [])
      .map((d, i) => ({ d, v: sh?.promoters_yearly?.[i] ?? null }))
      .filter((x): x is DatedPoint => x.v != null);
    const now = s.at(-1) ?? null;
    if (now && s.length >= 2) {
      // Older yearly points extend the quarterly series; the latest stays quarterly.
      const merged = [...yearly.filter((y) => y.d < s[0]!.d), ...s];
      const back = pointMonthsBack(merged, 36, 3);
      if (back) {
        const ago3 = back.p;
        const ch3 = now.v - ago3.v;
        const span = monthIndex(now.d) - monthIndex(ago3.d);
        out.push({
          id: "prom3y",
          label: "Change in promoter holding (3 years)",
          rule: "up vs 3 yrs ago",
          value: `${ch3 >= 0 ? "+" : ""}${ch3.toFixed(2)} pp`,
          points: ch3 > 0 ? 1 : 0,
          note: `${ago3.v.toFixed(2)}% (${q(ago3.d)}) → ${now.v.toFixed(2)}% (${q(now.d)})${back.partial ? ` · only ${span} months of data` : ""}`,
        });
      } else out.push({ id: "prom3y", label: "Change in promoter holding (3 years)", rule: "up vs 3 yrs ago", value: "—", points: null, note: "No promoter history" });
      const prev = previousFiling(s);
      if (prev) {
        const chq = now.v - prev.v;
        const gap = monthIndex(now.d) - monthIndex(prev.d);
        out.push({
          id: "promq",
          label: "Change in promoter holding (quarterly)",
          rule: "up vs last quarter",
          value: `${chq >= 0 ? "+" : ""}${chq.toFixed(2)} pp`,
          points: chq > 0 ? 1 : 0,
          note: `${prev.v.toFixed(2)}% (${q(prev.d)}) → ${now.v.toFixed(2)}% (${q(now.d)})${gap >= 5 ? " · half-yearly filer" : ""}`,
        });
      } else out.push({ id: "promq", label: "Change in promoter holding (quarterly)", rule: "up vs last quarter", value: "—", points: null, note: "Only one filing" });
    } else if (now) {
      // One filing only (new listing): show the holding, nothing to compare yet.
      const note = `promoters hold ${now.v.toFixed(2)}% (${q(now.d)}) · only one filing on Screener, nothing to compare`;
      out.push({ id: "prom3y", label: "Change in promoter holding (3 years)", rule: "up vs 3 yrs ago", value: `${now.v.toFixed(2)}%`, points: null, note });
      out.push({ id: "promq", label: "Change in promoter holding (quarterly)", rule: "up vs last quarter", value: `${now.v.toFixed(2)}%`, points: null, note });
    } else {
      out.push({ id: "prom3y", label: "Change in promoter holding (3 years)", rule: "up vs 3 yrs ago", value: "—", points: null, note: "No promoter history" });
      out.push({ id: "promq", label: "Change in promoter holding (quarterly)", rule: "up vs last quarter", value: "—", points: null, note: "No promoter history" });
    }
  }
  return out;
}

/**
 * Valuation score (−4 … +6):
 *   P/B peer valuation   P/B ≤ industry median +1 · > 2× median −1
 *   P/S peer valuation   P/S ≤ industry median +1 · > 2× median −1
 *                        (Screener's peer table + Median row when logged in, else
 *                        our industry's median)
 *   Graham analysis      price < √(22.5 × EPS × book value per share) +1 · > 2× −1
 *   Intrinsic value      price < EPS × (8.5 + 2g), g = 5-yr EPS growth capped 0–20 % +1 · > 2× −1
 *   Cash rich rating     cash − debt > market cap +2 (cash: Yahoo, debt: Yahoo else Screener)
 */
async function scoreValuation(
  t: string,
  market: string,
  ctx: ReturnType<typeof loadPeers>,
): Promise<FundCheck[]> {
  const [annual, pl, bs, sp] = await Promise.all([
    fetchScreenerAnnual(t).catch(() => null),
    fetchScreenerAnnualPl(t).catch(() => null),
    fetchScreenerAnnualBs(t).catch(() => null),
    // Screener's own peer table (its industry + Median row) — preferred for P/B, P/S.
    fetchScreenerPeers(t).catch(() => null),
  ]);
  const out: FundCheck[] = [];
  const mcap = ctx.mcap.get(t) ?? null;
  const price = ctx.price.get(t) ?? null;
  const ind = ctx.industryOf.get(t) ?? null;
  const last = <T,>(xs: Array<T | null> | undefined) => (xs ? [...xs].reverse().find((v) => v != null) ?? null : null);
  // Last full-year (March) book value — same as the Value page and the peer
  // medians; the newest column is often a half-year one (e.g. Sep).
  const bv = bs ? fullYearBookValue(bs.dates, bs.book_value) : null;
  const sales = last(pl?.revenue ?? annual?.sales);
  const band = (ratio: number) => (ratio <= 1 ? 1 : ratio > VALN.expensive ? -1 : 0) as 1 | 0 | -1;
  const pts = (v: 1 | 0 | -1) => v;
  // Screener's median needs as many peers as ours (VALN.peerMin) to count.
  const spOk = (sp?.n ?? 0) >= VALN.peerMin;
  const spNote = (what: string) => `Screener peer median ${what}${sp?.n ? ` (${sp.n} cos)` : ""}${sp?.industry ? ` · ${sp.industry}` : ""}`;
  // P/B peers: Screener's own P/B vs its peer median; else our industry median.
  const pbMine = mcap && bv && bv > 0 ? mcap / bv : ctx.htPb.get(t) ?? null;
  const pbUse = sp?.pb_own ?? pbMine;
  const bvNow = bs ? latestFullYearBookValue(bs.dates, bs.book_value) : null;
  if (bvNow != null && bvNow <= 0) {
    // Negative equity: any P/B from Yahoo / Screener is meaningless. Score as expensive.
    out.push({ id: "pb", label: "P/B peer valuation", rule: "≤ industry median +1 · > 2× −1", value: "Negative equity", points: -1, note: `book value ₹${Math.round(bvNow).toLocaleString("en-IN")} Cr (last full year): no P/B` });
  } else if (pbUse != null && pbUse > 0 && spOk && sp?.pb_median != null && sp.pb_median > 0) {
    out.push({ id: "pb", label: "P/B peer valuation", rule: "≤ industry median +1 · > 2× −1", value: `${pbUse.toFixed(2)} vs ${sp.pb_median.toFixed(2)}`, points: pts(band(pbUse / sp.pb_median)), note: spNote("P/B") });
  } else {
    const pm = ind ? peerMedian(ctx.peers.pb.get(ind), t) : null;
    const pbOwn = mcap && bv && bv > 0 ? mcap / bv : ctx.htPb.get(t) ?? null;
    if (pbOwn != null && pbOwn > 0 && pm) {
      const pb = pbOwn;
      out.push({ id: "pb", label: "P/B peer valuation", rule: "≤ industry median +1 · > 2× −1", value: `${pb.toFixed(2)} vs ${pm.m.toFixed(2)}`, points: pts(band(pb / pm.m)), note: `median P/B of ${pm.n} other companies · ${ind}` });
    } else out.push({ id: "pb", label: "P/B peer valuation", rule: "≤ industry median +1 · > 2× −1", value: "—", points: null, note: pm ? "No book value" : `Fewer than ${VALN.peerMin} other companies with data${ind ? ` · ${ind}` : ""}` });
  }
  // P/S peers: Screener first, as for P/B.
  const psMine = mcap && sales && sales > 0 ? mcap / sales : null;
  const psUse = sp?.ps_own ?? psMine;
  if (psUse != null && psUse > 0 && spOk && sp?.ps_median != null && sp.ps_median > 0) {
    out.push({ id: "ps", label: "P/S peer valuation", rule: "≤ industry median +1 · > 2× −1", value: `${psUse.toFixed(2)} vs ${sp.ps_median.toFixed(2)}`, points: pts(band(psUse / sp.ps_median)), note: spNote("P/S") });
  } else {
    const pm = ind ? peerMedian(ctx.peers.ps.get(ind), t) : null;
    const q4 = recentQuarters(t);
    const salesUse = sales ?? (q4 && q4.every((x) => x.revenue != null) ? q4.reduce((a, x) => a + (x.revenue as number), 0) : null);
    if (mcap && salesUse && salesUse > 0 && pm) {
      const ps = mcap / salesUse;
      out.push({ id: "ps", label: "P/S peer valuation", rule: "≤ industry median +1 · > 2× −1", value: `${ps.toFixed(2)} vs ${pm.m.toFixed(2)}`, points: pts(band(ps / pm.m)), note: `median P/S of ${pm.n} other companies · ${ind}` });
    } else out.push({ id: "ps", label: "P/S peer valuation", rule: "≤ industry median +1 · > 2× −1", value: "—", points: null, note: pm ? "No sales" : `Fewer than ${VALN.peerMin} other companies with data${ind ? ` · ${ind}` : ""}` });
  }
  // EPS (TTM from quarters, else latest annual) and book value per share
  const shares = mcap && price ? mcap / price : null; // crore shares
  // EPS: one rule with Napkin's headline P/E (pickCurrentEps) — quarter EPS,
  // else last 12 months' profit ÷ shares implied by the annual report (so
  // minority interest cancels: Reliance ₹60.7, not ₹70.7), else annual EPS.
  const yearNow = latestAnnualEpsPat(pl);
  const eps = pickCurrentEps({
    quarters: loadCachedQuartersSeries(t) ?? [],
    annualEps: yearNow.eps ?? last(annual?.eps),
    annualPat: yearNow.pat,
  }).eps;
  const bvps = bv && shares ? bv / shares : null;
  // Graham number
  if (price && eps != null && bvps != null) {
    if (eps <= 0 || bvps <= 0) out.push({ id: "graham", label: "Graham analysis", rule: "price < Graham number +1 · > 2× −1", value: "Loss", points: 0, note: "Needs positive EPS and book value" });
    else {
      const g = Math.sqrt(22.5 * eps * bvps);
      out.push({ id: "graham", label: "Graham analysis", rule: "price < Graham number +1 · > 2× −1", value: `₹${price.toFixed(0)} vs ₹${g.toFixed(0)}`, points: pts(band(price / g)), note: `√(22.5 × EPS ${eps.toFixed(2)} × BVPS ${bvps.toFixed(2)})` });
    }
  } else out.push({ id: "graham", label: "Graham analysis", rule: "price < Graham number +1 · > 2× −1", value: "—", points: null, note: "No EPS / book value" });
  // Intrinsic value (Graham growth formula)
  {
    const ap = pl?.dates.length ? annualPoints(pl.dates, pl.eps) : annual ? annualPoints(annual.dates, annual.eps) : [];
    const e5 = ap.length >= 6 ? ap[ap.length - 6]!.v : null;
    const eN = ap.at(-1)?.v ?? null;
    const g = e5 != null && eN != null && e5 > 0 && eN > 0 ? Math.min(VALN.growthCap, Math.max(0, (Math.pow(eN / e5, 1 / 5) - 1) * 100)) : 0;
    if (price && eps != null) {
      if (eps <= 0) out.push({ id: "iv", label: "Intrinsic value analysis", rule: "price < EPS × (8.5 + 2g) +1 · > 2× −1", value: "Loss", points: 0, note: "Needs positive EPS" });
      else {
        const iv = eps * (8.5 + 2 * g);
        // Under 6 years of EPS there is no 5-year growth: not scored, rather than
        // assuming 0% growth and marking a young company expensive.
        // A loss in the start or latest year gives no 5-year growth either
        // (Safari: FY2021 COVID loss): not scored, rather than g = 0% and −1.
        const short = e5 == null || eN == null || e5 <= 0 || eN <= 0;
        out.push({ id: "iv", label: "Intrinsic value analysis", rule: "price < EPS × (8.5 + 2g) +1 · > 2× −1", value: `₹${price.toFixed(0)} vs ₹${iv.toFixed(0)}`, points: short ? null : pts(band(price / iv)), note:
            e5 == null || eN == null
              ? "Not scored: needs 6 years of EPS history (value shown at g = 0%)"
              : e5 <= 0 || eN <= 0
                ? `Not scored: loss in the ${e5 <= 0 ? `start year (FY${ap[ap.length - 6]!.date.slice(0, 4)})` : "latest year"}, no 5-year growth (value shown at g = 0%)`
                : `g = ${g.toFixed(1)}% (5-yr EPS growth, capped ${VALN.growthCap}%)`,
        });
      }
    } else out.push({ id: "iv", label: "Intrinsic value analysis", rule: "price < EPS × (8.5 + 2g) +1 · > 2× −1", value: "—", points: null, note: "No EPS / price" });
  }
  // Cash rich — Yahoo cash first; else Screener BS cash & bank (same page as debt).
  {
    const cd = await fetchCashDebt(t, market).catch(() => ({ cash_cr: null, debt_cr: null, symbol: null }));
    let bsForCash = bs;
    // Only re-hit Screener when an older BS cache predates the cash field.
    if (cd.cash_cr == null && bs && bs.cash === undefined) {
      bsForCash = await fetchScreenerAnnualBs(t, { force: true }).catch(() => bs);
    }
    const bsCash = bsForCash?.cash?.length
      ? fullYearBookValue(bsForCash.dates, bsForCash.cash)
      : null;
    const cashCr = cd.cash_cr ?? (bsCash != null && bsCash > 0 ? bsCash : null);
    const debt = cd.debt_cr ?? last(bsForCash?.borrowings) ?? last(bs?.borrowings) ?? null;
    const cashSrc = cd.cash_cr != null ? "Yahoo" : bsCash != null && bsCash > 0 ? "Screener BS" : null;
    if (cashCr == null || mcap == null) {
      out.push({
        id: "cash",
        label: "Cash rich rating",
        rule: "cash − debt > market cap +2",
        value: "—",
        points: null,
        note: "No cash figure (Yahoo / Screener BS)",
      });
    } else {
      const net = cashCr - (debt ?? 0);
      const p = net > mcap ? 2 : 0;
      out.push({
        id: "cash",
        label: "Cash rich rating",
        rule: "cash − debt > market cap +2",
        value: `${net >= 0 ? "+" : "−"}₹${Math.abs(Math.round(net)).toLocaleString("en-IN")} Cr`,
        points: p,
        note: `cash ₹${Math.round(cashCr).toLocaleString("en-IN")} Cr − debt ₹${Math.round(debt ?? 0).toLocaleString("en-IN")} Cr vs market cap ₹${Math.round(mcap).toLocaleString("en-IN")} Cr · ${cashSrc}`,
      });
    }
  }
  return out;
}

/** In-memory score TTL (same process). */
const SCORE_TTL_MS = 6 * 3_600_000;
/** Disk score TTL — already-scored stocks skip Screener across reloads/restarts. */
const SCORE_DISK_TTL_MS = 7 * 24 * 3_600_000;
/** A stock with nothing scored is retried after this. */
const EMPTY_SCORE_TTL_MS = 5 * 60_000;

type ScoreBundle = { at: number; ttl: number; checks: FundCheck[]; m: FundCheck[]; val: FundCheck[] };
const scoreMemo = new Map<string, ScoreBundle>();

/**
 * Scores saved before the last rule change are recalculated on next use.
 * Bump when a check's rule changes (2026-11-24: intrinsic value not scored
 * without 6 years of EPS; negative equity scores P/B −1; growth from a trough
 * or across heavy share issuance is not scored. 21:45: peer median without
 * the stock itself; growth across a business change not scored; book value
 * per share keeps loss years; intrinsic value not scored after a loss year).
 */
const RULES_CHANGED_AT = Date.parse("2026-11-24T21:46:00Z");

/** stale: also return a saved score past its refresh time (pages show saved scores; only "Score now" refreshes). */
function readDiskScore(ticker: string, stale = false): ScoreBundle | null {
  return withDb((db) => {
    const row = db
      .prepare(
        `SELECT scored_at, ttl_ms, checks_json, m_json, val_json FROM portfolio_scores WHERE ticker = ?`,
      )
      .get(ticker.toUpperCase()) as
      | { scored_at: number; ttl_ms: number; checks_json: string; m_json: string; val_json: string }
      | undefined;
    if (!row) return null;
    if (!stale && Date.now() - row.scored_at >= row.ttl_ms) return null;
    if (row.scored_at < RULES_CHANGED_AT) return null;
    try {
      return {
        at: row.scored_at,
        ttl: row.ttl_ms,
        checks: JSON.parse(row.checks_json) as FundCheck[],
        m: JSON.parse(row.m_json) as FundCheck[],
        val: JSON.parse(row.val_json) as FundCheck[],
      };
    } catch {
      return null;
    }
  });
}

function writeDiskScore(ticker: string, v: ScoreBundle): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO portfolio_scores (ticker, scored_at, ttl_ms, checks_json, m_json, val_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET
         scored_at = excluded.scored_at,
         ttl_ms = excluded.ttl_ms,
         checks_json = excluded.checks_json,
         m_json = excluded.m_json,
         val_json = excluded.val_json`,
    ).run(
      ticker.toUpperCase(),
      v.at,
      v.ttl,
      JSON.stringify(v.checks),
      JSON.stringify(v.m),
      JSON.stringify(v.val),
    );
  });
}

/** Memory first, then disk — only then hit Screener. `stale`: accept a saved score past its refresh time. */
function lookupScore(ticker: string, opts?: { stale?: boolean }): ScoreBundle | null {
  const key = ticker.toUpperCase();
  const mem = scoreMemo.get(key);
  if (mem && (opts?.stale || Date.now() - mem.at < mem.ttl) && mem.at >= RULES_CHANGED_AT) {
    const m = migrateBvCheck(key, mem);
    if (m !== mem) scoreMemo.set(key, m);
    return m;
  }
  const disk = readDiskScore(key, !!opts?.stale);
  if (disk) {
    const d = migrateBvCheck(key, disk);
    scoreMemo.set(key, d);
    return d;
  }
  return null;
}

/** Tickers without a current score (never scored, or past their refresh time): what "Score now" would fetch. */
export function tickersNeedingScore(tickers: string[]): string[] {
  return [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))].filter((t) => !lookupScore(t));
}

async function cachedScore(
  t: string,
  market: string,
  ctx: () => ReturnType<typeof loadPeers>,
  opts?: { force?: boolean },
): Promise<{ checks: FundCheck[]; m: FundCheck[]; val: FundCheck[] }> {
  const hit = opts?.force ? null : lookupScore(t);
  if (hit) return hit;
  // One (maybe two) Screener company page(s) → all statement caches, then score.
  await warmScreenerForReview(t, { force: opts?.force });
  const [checks, m, val] = await Promise.all([
    scoreFundamental(t),
    scoreManagement(t),
    scoreValuation(t, market, ctx()),
  ]);
  // Nothing scored usually means Screener was paused or slow: keep that only
  // briefly so the stock is retried, instead of showing "No data" for 6 h.
  // A section with nothing scored (Screener paused, shareholding missing) is
  // kept only as briefly too, and never saved: the next open retries it.
  const empty =
    !checks.some((c) => c.points != null) || !m.some((c) => c.points != null) || !val.some((c) => c.points != null);
  const v: ScoreBundle = {
    at: Date.now(),
    ttl: empty ? EMPTY_SCORE_TTL_MS : SCORE_DISK_TTL_MS,
    checks,
    m,
    val,
  };
  scoreMemo.set(t.toUpperCase(), { ...v, ttl: empty ? EMPTY_SCORE_TTL_MS : SCORE_TTL_MS });
  if (!empty) writeDiskScore(t, v);
  return v;
}

/** Forget every kept score (app Refresh button). */
export function clearReviewScores(): void {
  scoreMemo.clear();
  withDb((db) => {
    db.prepare(`DELETE FROM portfolio_scores`).run();
  });
}

type ScanRow = {
  t: string;
  name: string;
  market: string;
  industry: string | null;
  mcap: number | null;
};

type ValueLegs = { sales3y: number | null; roce3y: number | null; pb: number | null };

function rowFromScores(
  ticker: string,
  added_at: string,
  s: ScanRow | undefined,
  checks: FundCheck[],
  m: FundCheck[],
  val: FundCheck[],
  legs?: ValueLegs | null,
): ReviewRow {
  const scored = checks.filter((c) => c.points != null).length;
  const fundamental = checks.reduce((a, c) => a + (c.points ?? 0), 0);
  const mScored = m.filter((c) => c.points != null).length;
  const management = m.reduce((a, c) => a + (c.points ?? 0), 0);
  const vScored = val.filter((c) => c.points != null).length;
  const valuation = val.reduce((a, c) => a + (c.points ?? 0), 0);
  const quality = fundamental + management;
  const total = quality + valuation;
  // A whole section with nothing scored (shareholding or statements not
  // loaded) would rate the stock on part of the 17 points: say so instead.
  const rating: ReviewRow["rating"] =
    !scored && !mScored
      ? "No data"
      : !scored || !mScored || !vScored
        ? "Incomplete"
        : total >= RATING.excellent
        ? "Excellent"
        : total >= RATING.good
          ? "Good"
          : total >= RATING.average
            ? "Average"
            : "Poor";
  return {
    t: ticker,
    name: s?.name ?? ticker,
    market: s?.market ?? "NSE",
    industry: s?.industry ?? null,
    mcap: s?.mcap ?? null,
    added_at,
    sales3y: legs?.sales3y ?? null,
    roce3y: legs?.roce3y ?? null,
    pb: legs?.pb ?? null,
    fundamental,
    scored,
    checks,
    management,
    m_scored: mScored,
    m_checks: m,
    quality,
    valuation,
    v_scored: vScored,
    v_checks: val,
    total,
    total_max: 17,
    rating,
  };
}

function pendingRow(
  ticker: string,
  added_at: string,
  s: ScanRow | undefined,
  legs?: ValueLegs | null,
): ReviewRow {
  return {
    t: ticker,
    name: s?.name ?? ticker,
    market: s?.market ?? "NSE",
    industry: s?.industry ?? null,
    mcap: s?.mcap ?? null,
    added_at,
    sales3y: legs?.sales3y ?? null,
    roce3y: legs?.roce3y ?? null,
    pb: legs?.pb ?? null,
    fundamental: 0,
    scored: -1,
    checks: [],
    management: 0,
    m_scored: 0,
    m_checks: [],
    quality: 0,
    valuation: 0,
    v_scored: 0,
    v_checks: [],
    total: 0,
    total_max: 0,
    rating: "No data",
  };
}

/** In-flight Screener scoring per bag — list paints first, scores fill in. */
const scoreJobs = new Map<ReviewBag, Promise<void>>();

function kickScoreJob(
  bag: ReviewBag,
  need: Array<{ ticker: string; market: string }>,
): void {
  if (!need.length || scoreJobs.has(bag)) return;
  const job = (async () => {
    let peerCtx: ReturnType<typeof loadPeers> | null = null;
    const ctx = () => {
      if (!peerCtx) peerCtx = loadPeers();
      return peerCtx;
    };
    await runConcurrent(need, 6, async ({ ticker, market }) => {
      try {
        await cachedScore(ticker, market, ctx);
      } catch {
        /* next poll retries via empty TTL */
      }
    });
  })().finally(() => {
    if (scoreJobs.get(bag) === job) scoreJobs.delete(bag);
  });
  scoreJobs.set(bag, job);
}

/**
 * Score one ticker with the Portfolio review model (fund / mgmt / valuation).
 * Used by Napkin — does not require the ticker to be on a review bag.
 */
export async function scoreReviewTicker(
  ticker: string,
  opts?: { fresh?: boolean },
): Promise<ReviewRow> {
  const key = ticker.trim().toUpperCase();
  if (!key) return pendingRow("", new Date().toISOString(), undefined);
  if (opts?.fresh) {
    scoreMemo.delete(key);
    withDb((db) => {
      try {
        db.prepare(`DELETE FROM portfolio_scores WHERE ticker = ?`).run(key);
      } catch {
        /* no table yet */
      }
    });
  }
  const scan = buildScannerData().rows.find((r) => r.t.toUpperCase() === key);
  const s: ScanRow | undefined = scan
    ? {
        t: scan.t,
        name: scan.name,
        market: scan.market,
        industry: scan.industry ?? null,
        mcap: scan.mcap ?? null,
      }
    : undefined;
  const hit = lookupScore(key);
  if (hit && !opts?.fresh) {
    return rowFromScores(key, new Date().toISOString(), s, hit.checks, hit.m, hit.val);
  }
  let peerCtx: ReturnType<typeof loadPeers> | null = null;
  const { checks, m, val } = await cachedScore(
    key,
    s?.market ?? "NSE",
    () => {
      if (!peerCtx) peerCtx = loadPeers();
      return peerCtx;
    },
    // Napkin "fresh": re-read Screener even when the saved statements look current.
    { force: opts?.fresh },
  );
  return rowFromScores(key, new Date().toISOString(), s, checks, m, val);
}

/**
 * Build the review table. Cached scores return at once; uncached tickers show
 * as "Scoring…" (`scored: -1`) while Screener work runs in the background.
 * `fresh: true` clears the memo and waits for a full rescore (Refresh).
 */
export async function buildReview(opts?: {
  fresh?: boolean;
  bag?: ReviewBag;
}): Promise<{
  rows: ReviewRow[];
  pending: number;
  /** A "Score now" job is running for this list. */
  scoring?: boolean;
  /** Saved scores past their refresh time (shown as they are until scored again). */
  stale?: number;
  screener_paused_until: string | null;
  /** Screener's peer table lacks P/B / P/S columns: peer valuation uses our industry medians. */
  peer_columns_missing: boolean;
}> {
  if (opts?.fresh) scoreMemo.clear();
  const bag = opts?.bag ?? PORTFOLIO_BAG;
  const list = withDb(
    (db) =>
      db
        .prepare(
          `SELECT ticker, added_at FROM portfolio_review WHERE bag = ? ORDER BY added_at, ticker`,
        )
        .all(bag) as Array<{ ticker: string; added_at: string }>,
  );
  const scan = new Map(
    buildScannerData().rows.map((r) => [
      r.t.toUpperCase(),
      {
        t: r.t,
        name: r.name,
        market: r.market,
        industry: r.industry ?? null,
        mcap: r.mcap ?? null,
      } satisfies ScanRow,
    ]),
  );

  // Value-page legs (Sales 3Y / ROCE 3Y / P/B) from the same caches Value uses.
  const valueLegs = new Map<string, ValueLegs>();
  try {
    const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
    try {
      for (const r of db
        .prepare(
          `SELECT UPPER(ticker) AS t, sales_growth_3y AS sales3y, roce_3y AS roce3y, pb
           FROM ht_iv_cache WHERE status IN ('ok', 'partial')`,
        )
        .all() as Array<{
        t: string;
        sales3y: number | null;
        roce3y: number | null;
        pb: number | null;
      }>) {
        valueLegs.set(r.t, {
          sales3y: r.sales3y,
          roce3y: r.roce3y,
          pb: r.pb != null && r.pb > 0 ? r.pb : null,
        });
      }
    } finally {
      db.close();
    }
  } catch {
    /* optional */
  }
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      for (const r of db
        .prepare(`SELECT UPPER(ticker) AS t, annual_json FROM screener_annual_cache`)
        .all() as Array<{ t: string; annual_json: string }>) {
        try {
          const a = JSON.parse(r.annual_json) as {
            dates: string[];
            sales: Array<number | null>;
            roce: Array<number | null>;
          };
          const months = new Map<string, number>();
          for (const d of a.dates) months.set(d.slice(5, 7), (months.get(d.slice(5, 7)) ?? 0) + 1);
          const main = [...months].sort((x, y) => y[1] - x[1])[0]?.[0];
          const idx = a.dates.map((d, i) => (d.slice(5, 7) === main ? i : -1)).filter((i) => i >= 0);
          const sales = idx.map((i) => a.sales[i] ?? null);
          const roce = idx.map((i) => a.roce[i] ?? null);
          const sales3y = sales3yFromAnnual(sales);
          const roce3y = roce3yFromAnnual(roce);
          const prev = valueLegs.get(r.t) ?? { sales3y: null, roce3y: null, pb: null };
          valueLegs.set(r.t, {
            sales3y: sales3y ?? prev.sales3y,
            roce3y: roce3y ?? prev.roce3y,
            pb: prev.pb,
          });
        } catch {
          /* skip */
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* optional */
  }

  const need: Array<{ ticker: string; market: string }> = [];
  const rows: ReviewRow[] = [];
  for (const { ticker, added_at } of list) {
    const key = ticker.toUpperCase();
    const s = scan.get(key);
    const legs = valueLegs.get(key) ?? null;
    const hit = lookupScore(key, { stale: true });
    if (hit) {
      rows.push(rowFromScores(key, added_at, s, hit.checks, hit.m, hit.val, legs));
    } else {
      need.push({ ticker: key, market: s?.market ?? "NSE" });
      rows.push(pendingRow(key, added_at, s, legs));
    }
  }

  if (opts?.fresh && need.length) {
    let peerCtx: ReturnType<typeof loadPeers> | null = null;
    const ctx = () => {
      if (!peerCtx) peerCtx = loadPeers();
      return peerCtx;
    };
    const scored = await runConcurrent(need, 6, async ({ ticker, market }) => {
      const { checks, m, val } = await cachedScore(ticker, market, ctx);
      const item = list.find((x) => x.ticker.toUpperCase() === ticker);
      return rowFromScores(
        ticker,
        item?.added_at ?? "",
        scan.get(ticker),
        checks,
        m,
        val,
        valueLegs.get(ticker) ?? null,
      );
    });
    const byT = new Map(scored.filter((r): r is ReviewRow => !!r).map((r) => [r.t, r]));
    return {
      rows: rows.map((r) => byT.get(r.t) ?? r),
      pending: 0,
      screener_paused_until: screenerPausedUntil(),
      peer_columns_missing: !!screenerPeerColumnsMissingSince(),
    };
  }

  // Opening the page never fetches: scoring starts only from "Score now" (startReviewScoring).
  return {
    rows,
    pending: need.length,
    scoring: scoreJobs.has(bag),
    stale: tickersNeedingScore(list.map((x) => x.ticker)).length - need.length,
    screener_paused_until: screenerPausedUntil(),
    peer_columns_missing: !!screenerPeerColumnsMissingSince(),
  };
}

/**
 * "Score now" on a review list: score, in the background, every stock without a current score
 * (never scored or past its refresh time). Saved to portfolio_scores as each finishes.
 */
export function startReviewScoring(bag: ReviewBag = PORTFOLIO_BAG): { started: number; running: boolean } {
  const scan = new Map(buildScannerData().rows.map((r) => [r.t.toUpperCase(), r.market]));
  const need = tickersNeedingScore(listReviewTickers(bag)).map((t) => ({ ticker: t, market: scan.get(t) ?? "NSE" }));
  kickScoreJob(bag, need);
  return { started: need.length, running: scoreJobs.has(bag) };
}

/* ------------------------------------------------------------------ */
/* Slow background scoring (Watchlist lists)                           */
/* ------------------------------------------------------------------ */

/**
 * Watchlist stocks get the same Portfolio review scores, but filled slowly so
 * Screener isn't hammered: one stock at a time, 20–30 s apart, stopping when
 * Screener pauses us and waiting while Portfolio review scores its own list.
 */
export type SlowScoreJob = {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  current: string | null;
  paused_until: string | null;
  started_at: string;
  finished_at: string | null;
};

const SLOW_GAP_MS = 20_000;
const SLOW_JITTER_MS = 10_000;
/** A stock that couldn't be scored isn't retried for this long. */
const SLOW_RETRY_MS = 6 * 3_600_000;
const SLOW_KEY = Symbol.for("research.holdingsSlowScoreJob");
const SLOW_TRIED = Symbol.for("research.holdingsSlowScoreTried");
type SlowHolder = { [SLOW_KEY]?: SlowScoreJob; [SLOW_TRIED]?: Map<string, number> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function holdingsScoreJob(): SlowScoreJob | null {
  return (globalThis as SlowHolder)[SLOW_KEY] ?? null;
}

/** Saved scores only (never fetches): ticker → row. Missing = not scored yet. */
export function savedReviewRows(tickers: string[]): Map<string, ReviewRow> {
  const scan = new Map(buildScannerData().rows.map((r) => [r.t.toUpperCase(), r]));
  const out = new Map<string, ReviewRow>();
  for (const raw of tickers) {
    const t = raw.trim().toUpperCase();
    if (!t) continue;
    const hit = lookupScore(t, { stale: true });
    if (!hit) continue;
    const s = scan.get(t);
    out.set(
      t,
      rowFromScores(
        t,
        new Date(hit.at).toISOString(),
        s ? { t: s.t, name: s.name, market: s.market, industry: s.industry ?? null, mcap: s.mcap ?? null } : undefined,
        hit.checks,
        hit.m,
        hit.val,
      ),
    );
  }
  return out;
}

const SLOW_QUEUE = Symbol.for("research.watchlistSlowScoreQueue");
type QueueHolder = { [SLOW_QUEUE]?: string[] };

/**
 * Queue the tickers that have no saved score and make sure the slow job runs.
 * The list just opened goes to the front, so the chip you're looking at fills
 * first; anything already queued stays behind it. Returns the job.
 */
export function startHoldingsSlowScoring(
  tickers: string[],
  opts?: { /** Queue these at the back (everything else on the Watchlist); `tickers` go to the front. */ later?: string[] },
): SlowScoreJob | null {
  const holder = globalThis as SlowHolder & QueueHolder;
  const tried = (holder[SLOW_TRIED] ??= new Map());
  const queue = (holder[SLOW_QUEUE] ??= []);
  const now = Date.now();
  const missing = (list: string[]) =>
    [...new Set(list.map((t) => t.trim().toUpperCase()).filter(Boolean))].filter(
      (t) => !lookupScore(t) && now - (tried.get(t) ?? 0) > SLOW_RETRY_MS,
    );
  const need = missing(tickers);
  if (need.length) {
    const front = new Set(need);
    const rest = queue.filter((t) => !front.has(t));
    queue.splice(0, queue.length, ...need, ...rest);
  }
  const queued = new Set(queue);
  for (const t of missing(opts?.later ?? [])) if (!queued.has(t)) queue.push(t);
  const cur = holder[SLOW_KEY];
  if (cur?.running) {
    cur.total = cur.done + queue.length + (cur.current ? 1 : 0);
    return cur;
  }
  if (!queue.length) return cur ?? null;
  const paused = screenerPausedUntil();
  if (paused) return { ...(cur ?? emptySlowJob()), running: false, paused_until: paused };
  const job: SlowScoreJob = { ...emptySlowJob(), running: true, total: queue.length };
  holder[SLOW_KEY] = job;
  const scan = new Map(buildScannerData().rows.map((r) => [r.t.toUpperCase(), r]));
  void (async () => {
    let peerCtx: ReturnType<typeof loadPeers> | null = null;
    const ctx = () => (peerCtx ??= loadPeers());
    try {
      while (queue.length) {
        const until = screenerPausedUntil();
        if (until) {
          job.paused_until = until;
          break;
        }
        // Portfolio review is scoring its own list: let it go first.
        while (scoreJobs.size > 0) await sleep(10_000);
        const t = queue.shift()!;
        if (lookupScore(t)) {
          job.done++;
          continue;
        }
        job.current = t;
        tried.set(t, Date.now());
        try {
          await cachedScore(t, scan.get(t)?.market ?? "NSE", ctx);
          if (!lookupScore(t)) job.failed++; // partial (Screener slow / no data): retried later
        } catch {
          job.failed++;
        }
        job.done++;
        job.current = null;
        job.total = job.done + queue.length;
        await sleep(SLOW_GAP_MS + Math.random() * SLOW_JITTER_MS);
      }
    } finally {
      job.running = false;
      job.current = null;
      job.finished_at = new Date().toISOString();
    }
  })();
  return job;
}

function emptySlowJob(): SlowScoreJob {
  return {
    running: false,
    total: 0,
    done: 0,
    failed: 0,
    current: null,
    paused_until: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
}
