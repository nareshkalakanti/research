import {
  fetchScreenerAnnual,
  fetchScreenerAnnualBs,
  fetchScreenerAnnualPl,
} from "../screener-annual";
import { loadMetricsMap } from "../metrics";
import { fetchCashDebt } from "../yfinance";
import { fetchScreenerQuarterlyFundamentals } from "../screener-quarters";
import { fetchScreenerShareholding } from "../screener-shareholding";
import { trailingYear } from "../ttm";

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

/** CAGR over up to `years` years using the last point and the point that many years back. */
export function cagrCheck(
  id: string,
  label: string,
  dates: string[],
  vals: Array<number | null>,
): QfCheck {
  const rule = `≥ ${QF_RULES.cagr}% CAGR`;
  const pts = annualPoints(dates, vals);
  if (pts.length < QF_RULES.minYears + 1) {
    return { id, label, rule, value: "—", verdict: "na", note: `Only ${Math.max(0, pts.length - 1)} years of data` };
  }
  // 10 years when available, else 5, else 3.
  const avail = pts.length - 1;
  const span = avail >= QF_RULES.years ? QF_RULES.years : avail >= 5 ? 5 : 3;
  const end = pts[pts.length - 1]!;
  const start = pts[pts.length - 1 - span]!;
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
  return {
    id,
    label,
    rule,
    value: pct(g),
    verdict: g >= QF_RULES.cagr ? "pass" : "fail",
    note: `${span} yrs · ${start.date.slice(0, 4)} → ${end.date.slice(0, 4)}`,
  };
}

/** Results kept 6 h per stock: reopening a stock in Napkin is instant. */
const QF_TTL_MS = 6 * 3_600_000;
const qfMemo = new Map<string, { at: number; v: Promise<QualityFlags> }>();
export function buildQualityFlags(ticker: string): Promise<QualityFlags> {
  const t = ticker.trim().toUpperCase();
  const hit = qfMemo.get(t);
  if (hit && Date.now() - hit.at < QF_TTL_MS) return hit.v;
  const v = buildQualityFlagsRaw(t).catch((e) => {
    qfMemo.delete(t);
    throw e;
  });
  qfMemo.set(t, { at: Date.now(), v });
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
  // 1) Book value
  quality.push(
    bs?.dates.length
      ? cagrCheck("bv", "Book value growth", bs.dates, bs.book_value)
      : { id: "bv", label: "Book value growth", rule: `≥ ${QF_RULES.cagr}% CAGR`, value: "—", verdict: "na", note: "No balance sheet" },
  );
  // 2) EPS
  const epsDates = pl?.dates.length ? pl.dates : annual?.dates ?? [];
  const epsVals = pl?.dates.length ? pl.eps : annual?.eps ?? [];
  quality.push(
    epsDates.length
      ? cagrCheck("eps", "EPS growth", epsDates, epsVals)
      : { id: "eps", label: "EPS growth", rule: `≥ ${QF_RULES.cagr}% CAGR`, value: "—", verdict: "na", note: "No annual EPS" },
  );
  // 3) ROCE average
  {
    const pts = annual ? annualPoints(annual.dates, annual.roce) : [];
    const last = pts.slice(-(pts.length >= QF_RULES.years ? QF_RULES.years : pts.length >= 5 ? 5 : 3));
    if (last.length >= QF_RULES.minYears) {
      const avg = last.reduce((a, p) => a + p.v, 0) / last.length;
      const below = last.filter((p) => p.v < QF_RULES.roceAvg).length;
      quality.push({
        id: "roce",
        label: "ROCE",
        rule: `≥ ${QF_RULES.roceAvg}% average`,
        value: pct(avg),
        verdict: avg >= QF_RULES.roceAvg ? "pass" : "fail",
        note: `${last.length} yrs avg · ${below ? `${below} yr${below > 1 ? "s" : ""} below ${QF_RULES.roceAvg}%` : `never below ${QF_RULES.roceAvg}%`}`,
      });
    } else {
      quality.push({ id: "roce", label: "ROCE", rule: `≥ ${QF_RULES.roceAvg}% average`, value: "—", verdict: "na", note: "Not enough years" });
    }
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
        ? cagrCheck("sales", "Sales growth", d, v)
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

  const peg = buildPeg(t, pl?.dates.length ? pl.dates : annual?.dates ?? [], pl?.dates.length ? pl.eps : annual?.eps ?? [], quarters ?? []);

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
  quarters: Array<{ date: string; eps: number | null }>,
): PegInfo {
  const warnings: string[] = [];
  const pts = annualPoints(dates, eps);
  const price = loadMetricsMap().get(ticker)?.price ?? null;

  // P/E: price ÷ TTM EPS (last 4 quarters), else latest annual EPS.
  const qs = trailingYear(quarters, Date.now(), (q) => q.eps != null);
  const ttm = qs ? qs.reduce((a, q) => a + (q.eps as number), 0) : null;
  const lastFy = pts.at(-1)?.v ?? null;
  const epsNow = ttm ?? lastFy;
  const pe = price != null && epsNow != null && epsNow > 0 ? price / epsNow : null;
  const peBasis = ttm != null ? "price ÷ TTM EPS (last 12 months)" : "price ÷ latest annual EPS";
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
  {
    const cd = await cashP;
    const debt = cd.debt_cr ?? (bs ? [...bs.borrowings].reverse().find((v) => v != null) ?? null : null);
    if (cd.cash_cr == null || mcap == null) {
      out.push({
        id: "cash",
        label: "Cash rich",
        rule: `cash − debt > market cap · promoter > ${SPECIAL.cashPromoter}% · pledge 0%`,
        value: "—",
        verdict: "na",
        note: "No cash figure for this stock (Yahoo)",
      });
    } else {
      const net = cd.cash_cr - (debt ?? 0);
      const ok = net > mcap && prom != null && prom > SPECIAL.cashPromoter && (pledge ?? 0) === 0;
      out.push({
        id: "cash",
        label: "Cash rich",
        rule: `cash − debt > market cap · promoter > ${SPECIAL.cashPromoter}% · pledge 0%`,
        value: `${net >= 0 ? "" : "−"}${cr(Math.abs(net))} vs ${cr(mcap)}`,
        verdict: ok ? "pass" : "fail",
        conds: [
          { label: "Cash − debt > market cap", value: `${cr(cd.cash_cr)} − ${cr(debt ?? 0)} = ${net >= 0 ? "" : "−"}${cr(Math.abs(net))} vs ${cr(mcap)}`, ok: net > mcap },
          { label: `Promoter > ${SPECIAL.cashPromoter}%`, value: prom == null ? "—" : `${prom.toFixed(1)}%`, ok: prom == null ? null : prom > SPECIAL.cashPromoter },
          { label: "Pledge = 0%", value: pledge == null ? "—" : `${pledge}%`, ok: pledge == null ? null : pledge === 0 },
        ],
        note: `cash ${cr(cd.cash_cr)} − debt ${cr(debt ?? 0)} · ${((net / mcap) * 100).toFixed(0)}% of mcap · promoter ${prom == null ? "—" : `${prom.toFixed(1)}%`} · pledge ${pledge == null ? "—" : `${pledge}%`}`,
      });
    }
  }
  return out;
}
