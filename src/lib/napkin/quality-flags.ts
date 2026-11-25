import {
  fetchScreenerAnnual,
  fetchScreenerAnnualBs,
  fetchScreenerAnnualPl,
} from "../screener-annual";
import { DILUTION_LIMIT, recoveryPeak } from "../value-legs-math";
import { loadMetricsMap } from "../metrics";
import { fetchCashDebt } from "../yfinance";
import { fetchScreenerQuarterlyFundamentals } from "../screener-quarters";
import { fetchScreenerShareholding } from "../screener-shareholding";
import { EPS_PICK_LABEL, latestAnnualEpsPat, pickCurrentEps } from "./current-eps";

/**
 * Napkin "Quality checks & red flags" (10-year view), from Screener's company
 * page (cached; a stock is fetched at most once until its cache ages out).
 *
 * Quality checks — pass when:
 *   Book value 10Y CAGR ≥ 10%, EPS 10Y CAGR ≥ 10%, ROCE 10Y average ≥ 10%,
 *   promoter holding steady / rising over 10 years, Sales 10Y CAGR ≥ 10%.
 * Red flags — flagged when:
 *   promoter pledge ≥ 1%, other income ≥ 10% of total revenue (quality of
 *   turnover), interest coverage < 5×.
 */

export const QF_RULES = {
  years: 10,
  /** Fewer than 10 years: use 5, else 3 (newer companies). */
  minYears: 3,
  cagr: 10,
  roceAvg: 10,
  /** Promoter stake may dip this much (pp) from its start and still count as steady. */
  promoterSlackPp: 2,
  pledge: 1,
  turnoverDrop: 10,
  coverage: 5,
} as const;

export type QfVerdict = "pass" | "fail" | "na";
export type QfCheck = {
  id: string;
  label: string;
  rule: string;
  value: string;
  verdict: QfVerdict;
  note?: string;
  /** Sub-conditions (special situations): each must hold. */
  conds?: Array<{ label: string; value: string; ok: boolean | null }>;
};
export type PegBand = "cheap" | "fair" | "expensive" | "na";
export type PegInfo = {
  pe: number | null;
  /** How P/E was read: price ÷ TTM EPS (last 4 quarters) or ÷ latest annual EPS. */
  pe_basis: string;
  cagr3: number | null;
  cagr5: number | null;
  peg3: number | null;
  peg5: number | null;
  /** P/E ÷ the lower of the two growth rates — the cautious read. */
  peg_safe: number | null;
  band3: PegBand;
  band5: PegBand;
  band_safe: PegBand;
  warnings: string[];
};
export type QualityFlags = {
  peg: PegInfo;
  ticker: string;
  quality: QfCheck[];
  flags: QfCheck[];
  /** Special situations: capex story and cash rich (pass = qualifies). */
  special: QfCheck[];
  quality_passed: number;
  quality_scored: number;
  red_flags: number;
  source: string;
  as_of: string | null;
};

const pct = (v: number | null, d = 1) => (v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "" : ""}${v.toFixed(d)}%`);

/** Year-end (March or calendar) annual points only — drops half-year columns. */
export function annualPoints(dates: string[], vals: Array<number | null>): Array<{ date: string; v: number }> {
  const pts: Array<{ date: string; v: number }> = [];
  dates.forEach((d, i) => {
    const v = vals[i];
    if (v == null || !Number.isFinite(v)) return;
    pts.push({ date: d, v });
  });
  // Keep one point per year: the first column per year-month pattern seen most.
  const months = new Map<string, number>();
  for (const p of pts) months.set(p.date.slice(5, 7), (months.get(p.date.slice(5, 7)) ?? 0) + 1);
  const main = [...months].sort((a, b) => b[1] - a[1])[0]?.[0];
  return pts.filter((p) => p.date.slice(5, 7) === main);
}

/**
 * Book value per share by year: book value ÷ shares, with shares = net profit ÷
 * EPS for the same year. Screener's EPS is bonus/split-adjusted, so a bonus
 * issue does not look like a fall in book value per share (equity capital
 * doubles on a 1:1 bonus — TCS 2018). Fresh issues still dilute, as they should.
 * Shared by Napkin quality checks and the portfolio score: one rule, one number.
 */
export function bookValuePerShare(
  pl: { dates: string[]; pat: Array<number | null>; eps: Array<number | null> } | null | undefined,
  bs: { dates: string[]; book_value: Array<number | null>; equity_capital?: Array<number | null> } | null | undefined,
): Array<number | null> | undefined {
  if (!bs) return undefined;
  const shares = new Map<string, number>();
  if (pl)
    pl.dates.forEach((d, i) => {
      const pat = pl.pat[i];
      const eps = pl.eps[i];
      // Loss years count too: profit ÷ EPS works when both are negative.
      if (pat != null && eps != null && Math.abs(eps) >= 0.01 && Math.abs(pat) >= 0.5 && Math.sign(pat) === Math.sign(eps))
        shares.set(d.slice(0, 7), pat / eps);
    });
  const cap = bs.equity_capital;
  return bs.book_value.map((v, i) => {
    if (v == null) return null;
    const key = bs.dates[i]!.slice(0, 7);
    let sh = shares.get(key);
    // Profit near zero: carry the nearest known year's shares by equity capital (same face value).
    if (!sh && cap?.[i] != null && cap[i]! > 0) {
      let best: { gap: number; sh: number } | null = null;
      bs.dates.forEach((d, k) => {
        const s0 = shares.get(d.slice(0, 7));
        const c0 = cap[k];
        if (!s0 || c0 == null || c0 <= 0) return;
        const gap = Math.abs(k - i);
        if (!best || gap < best.gap) best = { gap, sh: (s0 * cap[i]!) / c0 };
      });
      if (best) sh = (best as { gap: number; sh: number }).sh;
    }
    return sh ? v / sh : null;
  });
}

/**
 * Shares outstanding by year (net profit ÷ EPS, bonus/split-adjusted), for the
 * dilution guard on book value growth. Equity capital is the wrong signal: a
 * 1:1 bonus doubles it with no new shares sold (TCS, Infosys, ITC, BEL), which
 * wrongly marked half the universe "shares issued". Falls back to equity
 * capital when the P&L has no usable EPS.
 */
export function adjustedShareCount(
  pl: { dates: string[]; pat: Array<number | null>; eps: Array<number | null> } | null | undefined,
  bs: { dates: string[]; equity_capital?: Array<number | null> } | null | undefined,
): { dates: string[]; values: Array<number | null> } | undefined {
  if (pl?.dates.length) {
    const values = pl.dates.map((_, i) => {
      const pat = pl.pat[i];
      const eps = pl.eps[i];
      return pat != null && eps != null && Math.abs(eps) >= 0.01 && Math.abs(pat) >= 0.5 && Math.sign(pat) === Math.sign(eps)
        ? pat / eps
        : null;
    });
    if (values.filter((v) => v != null).length >= 2) return { dates: pl.dates, values };
  }
  return bs?.equity_capital ? { dates: bs.dates, values: bs.equity_capital } : undefined;
}

/**
 * Business changed: one year's sales more than 10× the year before (₹10 Cr+),
 * e.g. a shell that took in a demerged business (NIIT MTS: ₹13 Cr → ₹1,132 Cr in
 * FY2022). Growth across that year is not comparable; ROCE counts only after it.
 */
export type BusinessBreak = { date: string; from: number; to: number };
export function businessBreak(dates: string[] | undefined, sales: Array<number | null> | undefined): BusinessBreak | null {
  if (!dates?.length || !sales?.length) return null;
  const pts = annualPoints(dates, sales);
  let out: BusinessBreak | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!.v;
    const b = pts[i]!.v;
    if (a > 0 && b >= 10 && b / a > 10) out = { date: pts[i]!.date, from: a, to: b };
  }
  return out;
}

/** ROCE rule (score and Napkin): average of the last 10 years (else 5, else 3); passes above 10%. */
export const ROCE_MIN = 10;
export function roceAverage(
  annual: { dates: string[]; roce: Array<number | null> } | null | undefined,
  brk?: BusinessBreak | null,
): { avg: number; years: number; from: string; to: string; below: number } | null {
  // After a business change only the new business's years count.
  const all = (annual ? annualPoints(annual.dates, annual.roce) : []).filter((p) => !brk || p.date >= brk.date);
  const pts = all.slice(-(all.length >= 10 ? 10 : all.length >= 5 ? 5 : 3));
  if (pts.length < 3) return null;
  return {
    avg: pts.reduce((a, p) => a + p.v, 0) / pts.length,
    years: pts.length,
    from: pts[0]!.date.slice(0, 4),
    to: pts[pts.length - 1]!.date.slice(0, 4),
    below: pts.filter((p) => p.v <= ROCE_MIN).length,
  };
}

/**
 * CAGR over 10 years when the history allows, else 5, else 3 — chosen by years
 * of history only, never shortened to dodge a weak start. The start is the
 * point exactly that many years back; growth uses the real year count.
 * Strict eligibility (no point, figure still shown):
 *   - start below 60% of an earlier peak → "Recovery from a low base"
 *   - shares outstanding (profit ÷ EPS) up more than 25% → "Not comparable" (when given)
 */
export function cagrCheck(
  id: string,
  label: string,
  dates: string[],
  vals: Array<number | null>,
  opts?: { shareCapital?: { dates: string[]; values: Array<number | null> }; businessBreak?: BusinessBreak | null },
): QfCheck {
  const rule = `≥ ${QF_RULES.cagr}% CAGR`;
  const pts = annualPoints(dates, vals);
  if (pts.length < QF_RULES.minYears + 1) {
    return { id, label, rule, value: "—", verdict: "na", note: `Only ${Math.max(0, pts.length - 1)} years of data` };
  }
  const year = (d: string) => Number(d.slice(0, 4));
  const end = pts[pts.length - 1]!;
  const firstYear = year(pts[0]!.date);
  const avail = year(end.date) - firstYear;
  let startIdx = -1;
  let span = 0;
  for (const want of [QF_RULES.years, 5, 3]) {
    if (avail < want) continue;
    const idx = pts.findIndex((p) => year(p.date) === year(end.date) - want);
    if (idx >= 0) {
      startIdx = idx;
      span = want;
      break;
    }
  }
  if (startIdx < 0) {
    return { id, label, rule, value: "—", verdict: "na", note: "Gaps in the yearly history" };
  }
  const start = pts[startIdx]!;
  const years = `${span} yrs · ${start.date.slice(0, 4)} → ${end.date.slice(0, 4)}`;
  const brk = opts?.businessBreak;
  if (brk && start.date < brk.date) {
    const cr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")} Cr`;
    return {
      id,
      label,
      rule,
      value: start.v > 0 && end.v > 0 ? pct((Math.pow(end.v / start.v, 1 / span) - 1) * 100) : `${start.v.toFixed(2)} → ${end.v.toFixed(2)}`,
      verdict: "na",
      note: `${years} · Not comparable: business changed FY${brk.date.slice(0, 4)} (sales ${cr(brk.from)} → ${cr(brk.to)})`,
    };
  }
  if (start.v <= 0 || end.v <= 0) {
    return {
      id,
      label,
      rule,
      value: `${start.v.toFixed(2)} → ${end.v.toFixed(2)}`,
      // Still ≤ 0 at the end = no real growth. From a loss to a profit = turnaround, not a CAGR.
      verdict: end.v <= 0 ? "fail" : "na",
      note: end.v <= 0 ? "Zero or negative now — no growth" : "Turnaround from a loss — CAGR not meaningful",
    };
  }
  const g = (Math.pow(end.v / start.v, 1 / span) - 1) * 100;
  const peak = recoveryPeak(pts.map((p) => p.v), startIdx);
  if (peak != null) {
    return {
      id,
      label,
      rule,
      value: pct(g),
      verdict: "na",
      note: `${years} · Recovery from a low base (earlier peak ${Math.round(peak).toLocaleString("en-IN")}): not scored`,
    };
  }
  if (opts?.shareCapital) {
    const cap = annualPoints(opts.shareCapital.dates, opts.shareCapital.values);
    const at = (y: number) => cap.find((p) => year(p.date) === y)?.v ?? null;
    const c0 = at(year(start.date));
    const c1 = at(year(end.date));
    if (c0 != null && c1 != null && c0 > 0 && c1 / c0 - 1 > DILUTION_LIMIT) {
      return {
        id,
        label,
        rule,
        value: pct(g),
        verdict: "na",
        note: `${years} · Not comparable: share capital +${Math.round((c1 / c0 - 1) * 100)}% (shares issued)`,
      };
    }
  }
  return { id, label, rule, value: pct(g), verdict: g >= QF_RULES.cagr ? "pass" : "fail", note: years };
}

/** Results kept 6 h per stock: reopening a stock in Napkin is instant. */
const QF_TTL_MS = 6 * 3_600_000;
/** A result missing statements or shareholding (Screener paused / slow) is retried after 2 min. */
const QF_PARTIAL_TTL_MS = 2 * 60_000;
const qfMemo = new Map<string, { at: number; ttl: number; v: Promise<QualityFlags> }>();
/** Top-bar Refresh: recompute quality checks from the saved statements. */
export function clearQualityFlagsMemo(): void {
  qfMemo.clear();
}
export function buildQualityFlags(ticker: string): Promise<QualityFlags> {
  const t = ticker.trim().toUpperCase();
  const hit = qfMemo.get(t);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.v;
  const v = buildQualityFlagsRaw(t).catch((e) => {
    qfMemo.delete(t);
    throw e;
  });
  const entry = { at: Date.now(), ttl: QF_TTL_MS, v };
  qfMemo.set(t, entry);
  void v
    .then((r) => {
      const missing =
        r.quality.some((q) => q.note === "No balance sheet" || q.note === "No annual EPS") ||
        r.flags.some((f) => f.id === "promoter_low" && f.verdict === "na");
      if (missing) entry.ttl = QF_PARTIAL_TTL_MS;
    })
    .catch(() => {});
  return v;
}

async function buildQualityFlagsRaw(ticker: string): Promise<QualityFlags> {
  const t = ticker.trim().toUpperCase();
  // Yahoo cash / debt runs alongside the Screener reads.
  const cashP = fetchCashDebt(t, loadMetricsMap().get(t)?.market ?? "NSE").catch(() => ({ cash_cr: null, debt_cr: null, symbol: null }));
  const [annual, pl, bs0, quarters] = await Promise.all([
    fetchScreenerAnnual(t).catch(() => null),
    fetchScreenerAnnualPl(t).catch(() => null),
    fetchScreenerAnnualBs(t).catch(() => null),
    fetchScreenerQuarterlyFundamentals(t).catch(() => []),
  ]);
  // Older cached balance sheets have no CWIP row — refetch once.
  let bs = bs0;
  if (bs && bs.dates.length && bs.cwip === undefined) bs = await fetchScreenerAnnualBs(t, { force: true }).catch(() => bs0);
  let sh = await fetchScreenerShareholding(t).catch(() => null);
  // Old cache rows predate the yearly table — refetch once to get 10 years.
  if (sh && sh.yearly_dates === undefined) sh = await fetchScreenerShareholding(t, { force: true }).catch(() => sh);

  const quality: QfCheck[] = [];
  // Business changed in the history (shell took in a new business): growth across it not comparable.
  const brk = businessBreak(pl?.dates.length ? pl.dates : annual?.dates, pl?.dates.length ? pl.revenue : annual?.sales);
  // 1) Book value per share (same rule as the portfolio score)
  {
    const bvps = bookValuePerShare(pl, bs);
    quality.push(
      bs?.dates.length && bvps
        ? cagrCheck("bv", "Book value growth (per share)", bs.dates, bvps, {
            shareCapital: adjustedShareCount(pl, bs),
            businessBreak: brk,
          })
        : { id: "bv", label: "Book value growth (per share)", rule: `≥ ${QF_RULES.cagr}% CAGR`, value: "—", verdict: "na", note: "No balance sheet" },
    );
  }
  // 2) EPS
  const epsDates = pl?.dates.length ? pl.dates : annual?.dates ?? [];
  const epsVals = pl?.dates.length ? pl.eps : annual?.eps ?? [];
  quality.push(
    epsDates.length
      ? cagrCheck("eps", "EPS growth", epsDates, epsVals, { businessBreak: brk })
      : { id: "eps", label: "EPS growth", rule: `≥ ${QF_RULES.cagr}% CAGR`, value: "—", verdict: "na", note: "No annual EPS" },
  );
  // 3) ROCE — 10-year average, same rule as the portfolio score.
  {
    const r = roceAverage(annual, brk);
    const rule = `> ${ROCE_MIN}% average`;
    quality.push(
      r
        ? {
            id: "roce",
            label: "ROCE",
            rule,
            value: pct(r.avg),
            verdict: r.avg > ROCE_MIN ? "pass" : "fail",
            note: `${r.years} yrs average · FY${r.from} → FY${r.to} · ${r.below ? `${r.below} yr${r.below > 1 ? "s" : ""} at or below ${ROCE_MIN}%` : `never below ${ROCE_MIN}%`}`,
          }
        : { id: "roce", label: "ROCE", rule, value: "—", verdict: "na", note: "Not enough years" },
    );
  }
  // 4) Promoter holding steady / rising
  {
    // Yearly table when it has 3+ years, else the quarterly one (newer listings).
    const useYearly = (sh?.yearly_dates?.length ?? 0) >= 3;
    const yd = useYearly ? sh!.yearly_dates! : sh?.dates ?? [];
    const yv = useYearly ? sh!.promoters_yearly ?? [] : sh?.promoters ?? [];
    const pts = yd.map((d, i) => ({ d, v: yv[i] })).filter((p): p is { d: string; v: number } => p.v != null).slice(-(QF_RULES.years + 1));
    if (pts.length >= 2) {
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      const change = last.v - first.v;
      const peak = Math.max(...pts.map((p) => p.v));
      const ok = change >= -QF_RULES.promoterSlackPp;
      quality.push({
        id: "promoter",
        label: "Promoter holding",
        rule: "Steady / rising",
        value: `${first.v.toFixed(1)}% → ${last.v.toFixed(1)}%`,
        verdict: ok ? "pass" : "fail",
        note: `${first.d.slice(0, 4)}–${last.d.slice(0, 4)} · ${change >= 0 ? "+" : ""}${change.toFixed(1)} pp${peak - last.v > 3 ? ` · ${(peak - last.v).toFixed(1)} pp below peak` : ""}`,
      });
    } else {
      quality.push({ id: "promoter", label: "Promoter holding", rule: "Steady / rising", value: "—", verdict: "na", note: "No shareholding history" });
    }
  }
  // 5) Sales
  {
    const d = pl?.dates.length ? pl.dates : annual?.dates ?? [];
    const v = pl?.dates.length ? pl.revenue : annual?.sales ?? [];
    quality.push(
      d.length
        ? cagrCheck("sales", "Sales growth", d, v, { businessBreak: brk })
        : { id: "sales", label: "Sales growth", rule: `≥ ${QF_RULES.cagr}% CAGR`, value: "—", verdict: "na", note: "No annual sales" },
    );
  }

  const flags: QfCheck[] = [];
  // 6) Pledge — "fail" here means the red flag is raised.
  {
    const p = sh?.pledged_pct ?? null;
    const prom = sh ? [...sh.promoters].reverse().find((v) => v != null) ?? null : null;
    // Screener reports pledge as a share of the promoters' own holding.
    const ofCompany = p != null && prom != null && p > 0 ? (p * prom) / 100 : null;
    flags.push({
      id: "pledge",
      label: "Promoter pledging",
      rule: `< ${QF_RULES.pledge}%`,
      value: p == null ? "—" : `${pct(p, 1)} of promoter shares`,
      verdict: p == null ? "na" : p >= QF_RULES.pledge ? "fail" : "pass",
      note: ofCompany != null ? `≈ ${ofCompany.toFixed(1)}% of the company (promoters hold ${prom!.toFixed(1)}%)` : undefined,
    });
  }
  // 6b) Low promoter holding: owners with little skin in the game.
  {
    const promNow = sh ? [...sh.promoters].reverse().find((v) => v != null) ?? null : null;
    flags.push({
      id: "promoter_low",
      label: "Promoter holding",
      rule: "≥ 20%",
      value: promNow == null ? "—" : `${promNow.toFixed(1)}%`,
      verdict: promNow == null ? "na" : promNow < 20 ? "fail" : "pass",
      note: promNow != null && promNow < 20 ? "Low skin in the game" : undefined,
    });
  }
  // 7) Quality turnover: other income ÷ total revenue (sales + other income), latest year.
  {
    const i = pl ? pl.dates.length - 1 : -1;
    const rev = i >= 0 ? pl!.revenue[i] : null;
    const oi = i >= 0 ? pl!.other_income[i] : null;
    if (rev == null || oi == null || rev + Math.max(0, oi) <= 0) {
      flags.push({ id: "turnover", label: "Quality turnover", rule: "other income < 10% of revenue", value: "—", verdict: "na", note: "No P&L" });
    } else {
      const share = (Math.max(0, oi) / (rev + Math.max(0, oi))) * 100;
      flags.push({
        id: "turnover",
        label: "Quality turnover",
        rule: "other income < 10% of revenue",
        value: `${share.toFixed(1)}%`,
        verdict: share >= 10 ? "fail" : "pass",
        note: `FY ${pl!.dates[i]!.slice(0, 4)} · other income ₹${Math.round(Math.max(0, oi)).toLocaleString("en-IN")} Cr of ₹${Math.round(rev + Math.max(0, oi)).toLocaleString("en-IN")} Cr`,
      });
    }
  }
  // 8) Interest coverage, latest year: (PBT + interest) / interest
  {
    const i = pl ? pl.dates.length - 1 : -1;
    const interest = i >= 0 ? pl!.interest[i] : null;
    const pbt = i >= 0 ? pl!.pbt[i] : null;
    if (interest != null && pbt != null) {
      if (interest <= 0.01) {
        flags.push({ id: "icr", label: "Interest coverage", rule: `> ${QF_RULES.coverage}×`, value: "No interest", verdict: "pass", note: pl!.dates[i]!.slice(0, 4) });
      } else {
        const icr = (pbt + interest) / interest;
        flags.push({
          id: "icr",
          label: "Interest coverage",
          rule: `> ${QF_RULES.coverage}×`,
          value: `${icr.toFixed(1)}×`,
          verdict: icr < QF_RULES.coverage ? "fail" : "pass",
          note: `FY ${pl!.dates[i]!.slice(0, 4)} · (PBT + interest) ÷ interest`,
        });
      }
    } else {
      flags.push({ id: "icr", label: "Interest coverage", rule: `> ${QF_RULES.coverage}×`, value: "—", verdict: "na", note: "No P&L" });
    }
  }

  const yearNow = latestAnnualEpsPat(pl);
  const peg = buildPeg(t, pl?.dates.length ? pl.dates : annual?.dates ?? [], pl?.dates.length ? pl.eps : annual?.eps ?? [], quarters ?? [], yearNow);

  const scored = quality.filter((q) => q.verdict !== "na");
  return {
    peg,
    ticker: t,
    quality,
    flags,
    special: await buildSpecial(t, bs, sh, cashP),
    quality_passed: scored.filter((q) => q.verdict === "pass").length,
    quality_scored: scored.length,
    red_flags: flags.filter((f) => f.verdict === "fail").length,
    source: "Screener (consolidated)",
    as_of: pl?.dates.at(-1) ?? annual?.dates.at(-1) ?? null,
  };
}

// ---- PEG with trap checks ------------------------------------------------------------

/** < 1 cheap for its growth · 1–2 fair · > 2 expensive · no / negative growth = n/a. */
export function pegBand(v: number | null): PegBand {
  if (v == null || !Number.isFinite(v) || v <= 0) return "na";
  return v < 1 ? "cheap" : v <= 2 ? "fair" : "expensive";
}

function buildPeg(
  ticker: string,
  dates: string[],
  eps: Array<number | null>,
  quarters: Array<{ date: string; eps: number | null; netIncome?: number | null; revenue?: number | null }>,
  year: { eps: number | null; pat: number | null } = { eps: null, pat: null },
): PegInfo {
  const warnings: string[] = [];
  const pts = annualPoints(dates, eps);
  const price = loadMetricsMap().get(ticker)?.price ?? null;

  // P/E: price ÷ current EPS — the same rule as Napkin's headline P/E.
  const lastFy = pts.at(-1)?.v ?? null;
  const pick = pickCurrentEps({ quarters, annualEps: year.eps ?? lastFy, annualPat: year.pat });
  const epsNow = pick.eps;
  const pe = price != null && epsNow != null && epsNow > 0 ? price / epsNow : null;
  const peBasis = `price ÷ ${pick.source ? EPS_PICK_LABEL[pick.source] : "latest annual EPS"}`;
  if (price != null && epsNow != null && epsNow <= 0) warnings.push("Loss-making on current earnings — P/E and PEG not meaningful.");

  const growth = (years: number): { g: number | null; start: number | null; startYear: string | null } => {
    if (pts.length < years + 1) return { g: null, start: null, startYear: null };
    const end = pts[pts.length - 1]!;
    const start = pts[pts.length - 1 - years]!;
    if (start.v <= 0 || end.v <= 0) return { g: null, start: start.v, startYear: start.date.slice(0, 4) };
    return { g: (Math.pow(end.v / start.v, 1 / years) - 1) * 100, start: start.v, startYear: start.date.slice(0, 4) };
  };
  const g3 = growth(3);
  const g5 = growth(5);
  const peg = (g: number | null) => (pe != null && g != null && g > 0 ? pe / g : null);
  const peg3 = peg(g3.g);
  const peg5 = peg(g5.g);

  // Trap 1: low base — the start year's EPS was far below the company's usual EPS.
  const typical = (() => {
    const xs = pts.slice(-10).map((p) => p.v).sort((a, b) => a - b);
    return xs.length ? xs[xs.length >> 1]! : null;
  })();
  for (const [lbl, g] of [["3Y", g3], ["5Y", g5]] as const) {
    if (g.start == null || g.startYear == null) continue;
    if (g.start <= 0) warnings.push(`${lbl}: EPS was a loss in FY${g.startYear} — growth from a loss can't give a PEG.`);
    else if (typical != null && typical > 0 && g.start < typical * 0.5)
      warnings.push(
        `${lbl}: low base — FY${g.startYear} EPS (${g.start.toFixed(1)}) was under half the usual ${typical.toFixed(1)}, so growth looks inflated and PEG too low.`,
      );
  }
  // Trap 2: unstable — 3Y and 5Y PEG tell different stories.
  if (peg3 != null && peg5 != null && Math.max(peg3, peg5) / Math.min(peg3, peg5) >= 2)
    warnings.push(`Unstable: PEG is ${peg3.toFixed(2)} on 3Y growth but ${peg5.toFixed(2)} on 5Y — it depends on the years picked.`);
  // Trap 3: falling earnings.
  if ((g3.g != null && g3.g <= 0) || (g5.g != null && g5.g <= 0)) warnings.push("EPS has not grown over the period — PEG is not meaningful.");

  const known = [g3.g, g5.g].filter((g): g is number => g != null);
  // Cautious read: the lower growth rate; if EPS fell over either period, no PEG.
  const pegSafe = pe != null && known.length && known.every((g) => g > 0) ? pe / Math.min(...known) : null;
  const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
  return {
    pe: r2(pe),
    pe_basis: peBasis,
    cagr3: r2(g3.g),
    cagr5: r2(g5.g),
    peg3: r2(peg3),
    peg5: r2(peg5),
    peg_safe: r2(pegSafe),
    band3: pegBand(peg3),
    band5: pegBand(peg5),
    band_safe: pegBand(pegSafe),
    warnings,
  };
}

// ---- Special situations: capex story, cash rich ----------------------------------------

export const SPECIAL = { capexX: 2, capexPromoter: 40, capexMcap: 150, cashPromoter: 45 } as const;

async function buildSpecial(
  t: string,
  bs: Awaited<ReturnType<typeof fetchScreenerAnnualBs>> | null,
  sh: Awaited<ReturnType<typeof fetchScreenerShareholding>> | null,
  cashP: Promise<{ cash_cr: number | null; debt_cr: number | null }>,
): Promise<QfCheck[]> {
  const out: QfCheck[] = [];
  const m = loadMetricsMap().get(t);
  const mcap = m?.market_cap_cr ?? null;
  const prom = sh ? [...sh.promoters].reverse().find((v) => v != null) ?? null : null;
  const pledge = sh?.pledged_pct ?? null;
  const cr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")} Cr`;

  // 1) Capex story: net block (and net block + CWIP) > 2× the year before,
  //    promoter > 40%, market cap > ₹150 Cr.
  {
    const pts = bs ? annualPoints(bs.dates, bs.fixed_assets) : [];
    const cw = bs?.cwip ? annualPoints(bs.dates, bs.cwip) : [];
    const cwAt = (d: string) => cw.find((x) => x.date === d)?.v ?? 0;
    if (pts.length >= 2) {
      const cur = pts[pts.length - 1]!;
      const prev = pts[pts.length - 2]!;
      const xNb = prev.v > 0 ? cur.v / prev.v : null;
      const curT = cur.v + cwAt(cur.date);
      const prevT = prev.v + cwAt(prev.date);
      const xT = prevT > 0 ? curT / prevT : null;
      const grew = (xNb != null && xNb > SPECIAL.capexX) || (xT != null && xT > SPECIAL.capexX);
      const promOk = prom != null && prom > SPECIAL.capexPromoter;
      const capOk = mcap != null && mcap > SPECIAL.capexMcap;
      const missing = prom == null || mcap == null;
      out.push({
        id: "capex",
        label: "Capex story",
        rule: `net block > ${SPECIAL.capexX}× last year · promoter > ${SPECIAL.capexPromoter}% · mcap > ₹${SPECIAL.capexMcap} Cr`,
        value: `${xNb == null ? "—" : `${xNb.toFixed(2)}×`}${cw.length ? ` · with CWIP ${xT == null ? "—" : `${xT.toFixed(2)}×`}` : ""}`,
        verdict: grew && promOk && capOk ? "pass" : !grew ? "fail" : missing ? "na" : "fail",
        conds: [
          {
            label: `Net block > ${SPECIAL.capexX}× last year`,
            value: `${cr(prev.v)} → ${cr(cur.v)} (${xNb == null ? "—" : `${xNb.toFixed(2)}×`})`,
            ok: xNb == null ? null : xNb > SPECIAL.capexX,
          },
          ...(cw.length
            ? [
                {
                  label: `or net block + CWIP > ${SPECIAL.capexX}×`,
                  value: `${cr(prevT)} → ${cr(curT)} (${xT == null ? "—" : `${xT.toFixed(2)}×`})`,
                  ok: xT == null ? null : xT > SPECIAL.capexX,
                },
              ]
            : []),
          { label: `Promoter > ${SPECIAL.capexPromoter}%`, value: prom == null ? "—" : `${prom.toFixed(1)}%`, ok: prom == null ? null : promOk },
          { label: `Market cap > ₹${SPECIAL.capexMcap} Cr`, value: mcap == null ? "—" : cr(mcap), ok: mcap == null ? null : capOk },
        ],
        note:
          `Net block ${cr(prev.v)} (FY${prev.date.slice(0, 4)}) → ${cr(cur.v)} (FY${cur.date.slice(0, 4)})` +
          (cw.length ? ` · CWIP ${cr(cwAt(prev.date))} → ${cr(cwAt(cur.date))}` : "") +
          ` · promoter ${prom == null ? "—" : `${prom.toFixed(1)}%`} · mcap ${mcap == null ? "—" : cr(mcap)}`,
      });
    } else out.push({ id: "capex", label: "Capex story", rule: `net block > ${SPECIAL.capexX}× last year`, value: "—", verdict: "na", note: "No balance sheet" });
  }

  // 2) Cash rich: cash − debt > market cap, promoter > 45%, pledge = 0.
  // Yahoo cash first; else Screener BS cash & bank (same page as borrowings).
  {
    const cd = await cashP;
    let bsForCash = bs;
    // Only re-hit Screener when an older BS cache predates the cash field.
    if (cd.cash_cr == null && bs && bs.cash === undefined) {
      bsForCash = await fetchScreenerAnnualBs(t, { force: true }).catch(() => bs);
    }
    const bsCashPts = bsForCash?.cash?.length ? annualPoints(bsForCash.dates, bsForCash.cash) : [];
    const bsCash = bsCashPts.at(-1)?.v ?? null;
    const cashCr = cd.cash_cr ?? (bsCash != null && bsCash > 0 ? bsCash : null);
    const cashSrc = cd.cash_cr != null ? "Yahoo" : bsCash != null && bsCash > 0 ? "Screener BS" : null;
    const debt =
      cd.debt_cr ??
      (bsForCash ? [...bsForCash.borrowings].reverse().find((v) => v != null) ?? null : null) ??
      (bs ? [...bs.borrowings].reverse().find((v) => v != null) ?? null : null);
    if (cashCr == null || mcap == null) {
      out.push({
        id: "cash",
        label: "Cash rich",
        rule: `cash − debt > market cap · promoter > ${SPECIAL.cashPromoter}% · pledge 0%`,
        value: "—",
        verdict: "na",
        note: "No cash figure (Yahoo / Screener BS)",
      });
    } else {
      const net = cashCr - (debt ?? 0);
      const ok = net > mcap && prom != null && prom > SPECIAL.cashPromoter && (pledge ?? 0) === 0;
      out.push({
        id: "cash",
        label: "Cash rich",
        rule: `cash − debt > market cap · promoter > ${SPECIAL.cashPromoter}% · pledge 0%`,
        value: `${net >= 0 ? "" : "−"}${cr(Math.abs(net))} vs ${cr(mcap)}`,
        verdict: ok ? "pass" : "fail",
        conds: [
          { label: "Cash − debt > market cap", value: `${cr(cashCr)} − ${cr(debt ?? 0)} = ${net >= 0 ? "" : "−"}${cr(Math.abs(net))} vs ${cr(mcap)}`, ok: net > mcap },
          { label: `Promoter > ${SPECIAL.cashPromoter}%`, value: prom == null ? "—" : `${prom.toFixed(1)}%`, ok: prom == null ? null : prom > SPECIAL.cashPromoter },
          { label: "Pledge = 0%", value: pledge == null ? "—" : `${pledge}%`, ok: pledge == null ? null : pledge === 0 },
        ],
        note: `cash ${cr(cashCr)} − debt ${cr(debt ?? 0)} · ${((net / mcap) * 100).toFixed(0)}% of mcap · promoter ${prom == null ? "—" : `${prom.toFixed(1)}%`} · pledge ${pledge == null ? "—" : `${pledge}%`} · ${cashSrc}`,
      });
    }
  }
  return out;
}
