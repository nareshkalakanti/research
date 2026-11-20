import { annualPoints, cagrCheck } from "./napkin/quality-flags";
import { runConcurrent } from "./scrape-pool";
import { buildScannerData } from "./scanner";
import { fetchScreenerAnnual, fetchScreenerAnnualBs, fetchScreenerAnnualPl } from "./screener-annual";
import { loadCachedQuartersSeries } from "./screener-quarters";
import { fetchScreenerShareholding } from "./screener-shareholding";
import { loadHtIvMap } from "./strategy/ht-store";
import { fetchCashDebt } from "./yfinance";
import { openSqliteNamed } from "./sqlite-utils";

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
 */

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
  rating: "Excellent" | "Good" | "Average" | "Poor" | "No data";
};

export const MGMT = { pledgeMax: 0, institutionalMin: 1 } as const;
export const VALN = { peerMin: 3, expensive: 2, growthCap: 20 } as const;
/** Final rating on the total (out of 17): Excellent 13+ · Good 9–12 · Average 5–8 · Poor ≤ 4. */
export const RATING = { excellent: 13, good: 9, average: 5 } as const;

type Peers = { pb: Map<string, number>; ps: Map<string, number> };

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
  const last4 = qs.slice(-4);
  const newest = last4.at(-1)?.date;
  if (last4.length < 4 || !newest || Date.now() - Date.parse(`${newest}T00:00:00Z`) > 270 * 86_400_000) return null;
  return last4;
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
          const b = JSON.parse(r.bs_json) as { book_value: Array<number | null> };
          const bv = [...b.book_value].reverse().find((v) => v != null && v > 0) ?? null;
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
  const by = new Map<string, { pb: number[]; ps: number[] }>();
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
    if (pb != null && pb > 0) e.pb.push(pb);
    const sales = l?.sales ?? ttmSales(r.t);
    if (sales && sales > 0) e.ps.push(r.mcap / sales);
    by.set(r.industry, e);
  }
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
  };
  const peers: Peers = { pb: new Map(), ps: new Map() };
  for (const [ind, e] of by) {
    if (e.pb.length >= VALN.peerMin) peers.pb.set(ind, med(e.pb));
    if (e.ps.length >= VALN.peerMin) peers.ps.set(ind, med(e.ps));
  }
  return { industryOf, peers, price, mcap, htPb };
}

function withDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("portfolio_review.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS portfolio_review (
      ticker TEXT PRIMARY KEY,
      added_at TEXT NOT NULL
    )`);
    return fn(db);
  } finally {
    db.close();
  }
}

const pct = (v: number) => `${v.toFixed(1)}%`;

/** Name, NSE symbol or BSE code → our ticker. */
export function resolveTickers(inputs: string[]): { found: string[]; missing: string[] } {
  const rows = buildScannerData().rows;
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
  return { found: [...new Set(found)], missing };
}

export function addToReview(tickers: string[]): number {
  const now = new Date().toISOString();
  return withDb((db) => {
    const ins = db.prepare(`INSERT OR IGNORE INTO portfolio_review (ticker, added_at) VALUES (?, ?)`);
    let n = 0;
    db.transaction(() => {
      for (const t of tickers) n += ins.run(t.toUpperCase(), now).changes;
    })();
    return n;
  });
}

export function removeFromReview(ticker: string | null): void {
  withDb((db) => {
    if (ticker) db.prepare(`DELETE FROM portfolio_review WHERE ticker = ?`).run(ticker.toUpperCase());
    else db.prepare(`DELETE FROM portfolio_review`).run();
  });
}

async function scoreFundamental(t: string): Promise<FundCheck[]> {
  const [annual, pl, bs] = await Promise.all([
    fetchScreenerAnnual(t).catch(() => null),
    fetchScreenerAnnualPl(t).catch(() => null),
    fetchScreenerAnnualBs(t).catch(() => null),
  ]);
  const checks: FundCheck[] = [];
  const fromCagr = (id: "bv" | "sales", label: string, dates: string[] | undefined, vals: Array<number | null> | undefined) => {
    if (!dates?.length || !vals) return { id, label, rule: `> ${FUND.cagr}% CAGR · 10 yrs`, value: "—", points: null, note: "No data" } as FundCheck;
    const c = cagrCheck(id, label, dates, vals);
    return {
      id,
      label,
      rule: `> ${FUND.cagr}% CAGR · 10 yrs`,
      value: c.value,
      points: c.verdict === "na" ? null : c.verdict === "pass" ? 1 : 0,
      note: c.note,
    } as FundCheck;
  };
  // Per share: book value ÷ equity capital (bonus issues scale both; fresh
  // issues dilute — that is not growth for an existing shareholder).
  const bvps = bs ? bs.book_value.map((v, i) => (v != null && bs.equity_capital[i] ? v / bs.equity_capital[i]! : null)) : undefined;
  {
    const c = fromCagr("bv", "Book value growth (per share)", bs?.dates, bvps);
    checks.push(c);
  }
  checks.push(
    fromCagr("sales", "Sales growth", pl?.dates.length ? pl.dates : annual?.dates, pl?.dates.length ? pl.revenue : annual?.sales),
  );
  // ROCE 10-year average
  {
    const all = annual ? annualPoints(annual.dates, annual.roce) : [];
    const pts = all.slice(-(all.length >= 10 ? 10 : all.length >= 5 ? 5 : 3));
    if (pts.length >= 3) {
      const avg = pts.reduce((a, p) => a + p.v, 0) / pts.length;
      checks.push({ id: "roce", label: "ROCE", rule: `> ${FUND.roce}% average · 10 yrs`, value: pct(avg), points: avg > FUND.roce ? 1 : 0, note: `${pts.length} yrs average` });
    } else checks.push({ id: "roce", label: "ROCE", rule: `> ${FUND.roce}% average · 10 yrs`, value: "—", points: null, note: "Not enough years" });
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
async function scoreManagement(t: string): Promise<FundCheck[]> {
  const sh = await fetchScreenerShareholding(t).catch(() => null);
  const out: FundCheck[] = [];
  const seq = (vals: Array<number | null> | undefined) =>
    (sh?.dates ?? []).map((d, i) => ({ d, v: vals?.[i] ?? null })).filter((x): x is { d: string; v: number } => x.v != null);
  const q = (d: string) => d.slice(0, 7);
  // 1) Shareholder variation (latest vs 4 quarters back)
  {
    const s = seq(sh?.shareholders);
    if (s.length >= 2) {
      const now = s[s.length - 1]!;
      const ago = s[Math.max(0, s.length - 5)]!;
      const ch = ((now.v - ago.v) / ago.v) * 100;
      out.push({
        id: "holders",
        label: "Shareholder variation",
        rule: "number of shareholders down over 1 yr",
        value: `${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`,
        points: now.v < ago.v ? 1 : 0,
        note: `${Math.round(ago.v).toLocaleString("en-IN")} (${q(ago.d)}) → ${Math.round(now.v).toLocaleString("en-IN")} (${q(now.d)})${s.length < 5 ? ` · since listing (${s.length} quarters)` : ""}`,
      });
    } else out.push({ id: "holders", label: "Shareholder variation", rule: "number of shareholders down over 1 yr", value: "—", points: null, note: "No shareholder count" });
  }
  // 2) Pledge
  {
    const p = sh?.pledged_pct ?? null;
    out.push({
      id: "pledge",
      label: "Pledged percentage",
      rule: "promoter pledge = 0%",
      value: p == null ? "—" : `${p.toFixed(2)}%`,
      points: p == null ? null : p <= MGMT.pledgeMax ? 1 : 0,
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
  // 4–5) Promoter holding: 3 years and quarterly
  {
    const s = seq(sh?.promoters);
    if (s.length >= 2) {
      const now = s[s.length - 1]!;
      const ago3 = s[Math.max(0, s.length - 13)]!;
      const prev = s[s.length - 2]!;
      const ch3 = now.v - ago3.v;
      const chq = now.v - prev.v;
      out.push({
        id: "prom3y",
        label: "Change in promoter holding (3 years)",
        rule: "up vs 3 yrs ago",
        value: `${ch3 >= 0 ? "+" : ""}${ch3.toFixed(2)} pp`,
        points: ch3 > 0 ? 1 : 0,
        note: `${ago3.v.toFixed(2)}% (${q(ago3.d)}) → ${now.v.toFixed(2)}% (${q(now.d)})${s.length < 13 ? ` · only ${s.length} quarters` : ""}`,
      });
      out.push({
        id: "promq",
        label: "Change in promoter holding (quarterly)",
        rule: "up vs last quarter",
        value: `${chq >= 0 ? "+" : ""}${chq.toFixed(2)} pp`,
        points: chq > 0 ? 1 : 0,
        note: `${prev.v.toFixed(2)}% (${q(prev.d)}) → ${now.v.toFixed(2)}% (${q(now.d)})`,
      });
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
 *   Graham analysis      price < √(22.5 × EPS × book value per share) +1 · > 2× −1
 *   Intrinsic value      price < EPS × (8.5 + 2g), g = 5-yr EPS growth capped 0–20 % +1 · > 2× −1
 *   Cash rich rating     cash − debt > market cap +2 (cash: Yahoo, debt: Yahoo else Screener)
 */
async function scoreValuation(
  t: string,
  market: string,
  ctx: ReturnType<typeof loadPeers>,
): Promise<FundCheck[]> {
  const [annual, pl, bs] = await Promise.all([
    fetchScreenerAnnual(t).catch(() => null),
    fetchScreenerAnnualPl(t).catch(() => null),
    fetchScreenerAnnualBs(t).catch(() => null),
  ]);
  const out: FundCheck[] = [];
  const mcap = ctx.mcap.get(t) ?? null;
  const price = ctx.price.get(t) ?? null;
  const ind = ctx.industryOf.get(t) ?? null;
  const last = <T,>(xs: Array<T | null> | undefined) => (xs ? [...xs].reverse().find((v) => v != null) ?? null : null);
  const bv = last(bs?.book_value);
  const sales = last(pl?.revenue ?? annual?.sales);
  const band = (ratio: number) => (ratio <= 1 ? 1 : ratio > VALN.expensive ? -1 : 0) as 1 | 0 | -1;
  const pts = (v: 1 | 0 | -1) => v;
  // P/B peers
  {
    const m = ind ? ctx.peers.pb.get(ind) : undefined;
    const pbOwn = mcap && bv && bv > 0 ? mcap / bv : ctx.htPb.get(t) ?? null;
    if (pbOwn != null && pbOwn > 0 && m) {
      const pb = pbOwn;
      out.push({ id: "pb", label: "P/B peer valuation", rule: "≤ industry median +1 · > 2× −1", value: `${pb.toFixed(2)} vs ${m.toFixed(2)}`, points: pts(band(pb / m)), note: `industry median P/B · ${ind}` });
    } else out.push({ id: "pb", label: "P/B peer valuation", rule: "≤ industry median +1 · > 2× −1", value: "—", points: null, note: m ? "No book value" : "Fewer than 3 peers with data" });
  }
  // P/S peers
  {
    const m = ind ? ctx.peers.ps.get(ind) : undefined;
    const q4 = recentQuarters(t);
    const salesUse = sales ?? (q4 && q4.every((x) => x.revenue != null) ? q4.reduce((a, x) => a + (x.revenue as number), 0) : null);
    if (mcap && salesUse && salesUse > 0 && m) {
      const ps = mcap / salesUse;
      out.push({ id: "ps", label: "P/S peer valuation", rule: "≤ industry median +1 · > 2× −1", value: `${ps.toFixed(2)} vs ${m.toFixed(2)}`, points: pts(band(ps / m)), note: `industry median P/S · ${ind}` });
    } else out.push({ id: "ps", label: "P/S peer valuation", rule: "≤ industry median +1 · > 2× −1", value: "—", points: null, note: m ? "No sales" : "Fewer than 3 peers with data" });
  }
  // EPS (TTM from quarters, else latest annual) and book value per share
  const shares = mcap && price ? mcap / price : null; // crore shares
  // EPS: last 4 quarters' net profit ÷ shares (quarterly EPS rows are unreliable), else latest annual EPS.
  const qs = recentQuarters(t);
  const ttmNi = qs && qs.every((q) => q.netIncome != null) ? qs.reduce((a, q) => a + (q.netIncome as number), 0) : null;
  const eps = ttmNi != null && shares ? ttmNi / shares : last(pl?.eps ?? annual?.eps);
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
        out.push({ id: "iv", label: "Intrinsic value analysis", rule: "price < EPS × (8.5 + 2g) +1 · > 2× −1", value: `₹${price.toFixed(0)} vs ₹${iv.toFixed(0)}`, points: pts(band(price / iv)), note: `g = ${g.toFixed(1)}% (5-yr EPS growth, capped ${VALN.growthCap}%)` });
      }
    } else out.push({ id: "iv", label: "Intrinsic value analysis", rule: "price < EPS × (8.5 + 2g) +1 · > 2× −1", value: "—", points: null, note: "No EPS / price" });
  }
  // Cash rich
  {
    const cd = await fetchCashDebt(t, market).catch(() => ({ cash_cr: null, debt_cr: null, symbol: null }));
    const debt = cd.debt_cr ?? last(bs?.borrowings) ?? null;
    if (cd.cash_cr == null || mcap == null) out.push({ id: "cash", label: "Cash rich rating", rule: "cash − debt > market cap +2", value: "—", points: null, note: "No cash figure" });
    else {
      const net = cd.cash_cr - (debt ?? 0);
      const p = net > mcap ? 2 : 0;
      out.push({
        id: "cash",
        label: "Cash rich rating",
        rule: "cash − debt > market cap +2",
        value: `${net >= 0 ? "+" : "−"}₹${Math.abs(Math.round(net)).toLocaleString("en-IN")} Cr`,
        points: p,
        note: `cash ₹${Math.round(cd.cash_cr).toLocaleString("en-IN")} Cr − debt ₹${Math.round(debt ?? 0).toLocaleString("en-IN")} Cr vs market cap ₹${Math.round(mcap).toLocaleString("en-IN")} Cr`,
      });
    }
  }
  return out;
}

/** Scores kept per stock for 6 h: reloads are instant and never re-hit Screener. */
const SCORE_TTL_MS = 6 * 3_600_000;
const scoreMemo = new Map<string, { at: number; checks: FundCheck[]; m: FundCheck[]; val: FundCheck[] }>();
async function cachedScore(
  t: string,
  market: string,
  ctx: () => ReturnType<typeof loadPeers>,
): Promise<{ checks: FundCheck[]; m: FundCheck[]; val: FundCheck[] }> {
  const hit = scoreMemo.get(t);
  if (hit && Date.now() - hit.at < SCORE_TTL_MS) return hit;
  // The three scores are independent — run them together.
  // The three scores are independent — run them together.
  const [checks, m, val] = await Promise.all([scoreFundamental(t), scoreManagement(t), scoreValuation(t, market, ctx())]);
  const v = { at: Date.now(), checks, m, val };
  scoreMemo.set(t, v);
  return v;
}

export async function buildReview(opts?: { fresh?: boolean }): Promise<{ rows: ReviewRow[] }> {
  if (opts?.fresh) scoreMemo.clear();
  const list = withDb((db) => db.prepare(`SELECT ticker, added_at FROM portfolio_review ORDER BY added_at, ticker`).all() as Array<{ ticker: string; added_at: string }>);
  const scan = new Map(buildScannerData().rows.map((r) => [r.t.toUpperCase(), r]));
  let peerCtx: ReturnType<typeof loadPeers> | null = null;
  const ctx = () => {
    if (!peerCtx) {
      peerCtx = loadPeers();
    }
    return peerCtx;
  };
  const rows = await runConcurrent(list, 6, async ({ ticker, added_at }) => {
    const s = scan.get(ticker);
    const { checks, m, val } = await cachedScore(ticker, s?.market ?? "NSE", ctx);
    const scored = checks.filter((c) => c.points != null).length;
    const fundamental = checks.reduce((a, c) => a + (c.points ?? 0), 0);
    const mScored = m.filter((c) => c.points != null).length;
    const management = m.reduce((a, c) => a + (c.points ?? 0), 0);
    const vScored = val.filter((c) => c.points != null).length;
    const valuation = val.reduce((a, c) => a + (c.points ?? 0), 0);
    const quality = fundamental + management;
    const total = quality + valuation;
    const totalMax = 17;
    const rating: ReviewRow["rating"] =
      !scored && !mScored
        ? "No data"
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
      total_max: totalMax,
      rating,
    } satisfies ReviewRow;
  });
  return { rows: rows.filter((r): r is ReviewRow => !!r) };
}
