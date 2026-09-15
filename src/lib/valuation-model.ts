/**
 * Valuation Tool — annual P&L model helpers (estimates + CAGR).
 * Facts come from Screener / metrics; never invent historicals.
 */

export type ValuationScenario = "base" | "bull" | "bear";

export type ValuationYearKind = "hist" | "est";

export type ValuationColumn = {
  key: string;
  label: string;
  kind: ValuationYearKind;
  /** ISO-ish date for hist, or estimate year end YYYY-MM-DD */
  date: string;
};

/** Per-year editable estimate inputs (stored). */
export type ValuationEstimateInput = {
  revenue_growth_pct: number | null;
  opm_pct: number | null;
  other_income: number | null;
  interest: number | null;
  depreciation: number | null;
  tax_pct: number | null;
  shares_cr: number | null;
  /** Optional absolute revenue override (₹ Cr). */
  revenue: number | null;
};

export type ValuationHistSeries = {
  dates: string[];
  revenue: Array<number | null>;
  expenses: Array<number | null>;
  operating_profit: Array<number | null>;
  other_income: Array<number | null>;
  interest: Array<number | null>;
  depreciation: Array<number | null>;
  pbt: Array<number | null>;
  tax_pct: Array<number | null>;
  pat: Array<number | null>;
  shares_cr: Array<number | null>;
  eps: Array<number | null>;
};

export type ValuationRowId =
  | "revenue"
  | "revenue_growth"
  | "expenses"
  | "operating_profit"
  | "opm"
  | "other_income"
  | "interest"
  | "depreciation"
  | "pbt"
  | "tax_pct"
  | "pat"
  | "pat_growth"
  | "shares_cr"
  | "eps"
  | "forward_pe";

export const VALUATION_ROWS: Array<{
  id: ValuationRowId;
  label: string;
  editableEst?: boolean;
  bold?: boolean;
  accent?: "opm" | "pe";
}> = [
  { id: "revenue", label: "Revenue Cr", bold: true },
  { id: "revenue_growth", label: "Revenue Growth %", editableEst: true },
  { id: "expenses", label: "Expenses Cr" },
  { id: "operating_profit", label: "Operating Profit Cr", bold: true },
  { id: "opm", label: "OPM %", editableEst: true, accent: "opm" },
  { id: "other_income", label: "Other Income Cr", editableEst: true },
  { id: "interest", label: "Interest Expense Cr", editableEst: true },
  { id: "depreciation", label: "Depreciation Cr", editableEst: true },
  { id: "pbt", label: "PBT Cr", bold: true },
  { id: "tax_pct", label: "Tax %", editableEst: true },
  { id: "pat", label: "PAT Cr", bold: true },
  { id: "pat_growth", label: "PAT Growth %" },
  { id: "shares_cr", label: "Number of Shares Cr", editableEst: true },
  { id: "eps", label: "EPS ₹", bold: true },
  { id: "forward_pe", label: "Forward PE x", accent: "pe" },
];

const STORAGE_PREFIX = "research.valuation.v1.";

export function emptyEstimateInput(): ValuationEstimateInput {
  return {
    revenue_growth_pct: null,
    opm_pct: null,
    other_income: null,
    interest: null,
    depreciation: null,
    tax_pct: null,
    shares_cr: null,
    revenue: null,
  };
}

export function pctChange(
  cur: number | null,
  prev: number | null,
): number | null {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) {
    return null;
  }
  if (prev === 0) return null;
  return Math.round(((cur / prev) - 1) * 1000) / 10;
}

export function fmtValNum(
  v: number | null | undefined,
  decimals = 0,
): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-IN", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals > 0 ? Math.min(decimals, 1) : 0,
  });
}

export function fmtValPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

/** Last N historical years + forward estimate years. */
export function buildValuationColumns(
  histDates: string[],
  estimateYears = 4,
  histKeep = 5,
): ValuationColumn[] {
  const hist = histDates.filter(Boolean);
  const slice = hist.slice(Math.max(0, hist.length - histKeep));
  const cols: ValuationColumn[] = slice.map((d) => {
    const m = d.match(/^(\d{4})-(\d{2})/);
    const label = m
      ? `${monthLabel(m[2]!)} ${m[1]}`
      : d.slice(0, 7);
    return { key: `h:${d}`, label, kind: "hist" as const, date: d };
  });

  let lastYear = 0;
  let lastMonth = "03";
  if (slice.length) {
    const last = slice[slice.length - 1]!;
    const m = last.match(/^(\d{4})-(\d{2})/);
    if (m) {
      lastYear = Number(m[1]);
      lastMonth = m[2]!;
    }
  }
  if (!lastYear) {
    lastYear = new Date().getFullYear();
  }

  for (let i = 1; i <= estimateYears; i++) {
    const y = lastYear + i;
    const date = `${y}-${lastMonth}-01`;
    cols.push({
      key: `e:${date}`,
      label: `${monthLabel(lastMonth)} ${y} Estimate`,
      kind: "est",
      date,
    });
  }
  return cols;
}

function monthLabel(mm: string): string {
  const map: Record<string, string> = {
    "01": "Jan",
    "02": "Feb",
    "03": "Mar",
    "04": "Apr",
    "05": "May",
    "06": "Jun",
    "07": "Jul",
    "08": "Aug",
    "09": "Sep",
    "10": "Oct",
    "11": "Nov",
    "12": "Dec",
  };
  return map[mm] || "Mar";
}

export type ValuationComputedYear = {
  revenue: number | null;
  revenue_growth: number | null;
  expenses: number | null;
  operating_profit: number | null;
  opm: number | null;
  other_income: number | null;
  interest: number | null;
  depreciation: number | null;
  pbt: number | null;
  tax_pct: number | null;
  pat: number | null;
  pat_growth: number | null;
  shares_cr: number | null;
  eps: number | null;
  forward_pe: number | null;
};

function histIndex(series: ValuationHistSeries, date: string): number {
  return series.dates.indexOf(date);
}

function histYear(
  series: ValuationHistSeries,
  date: string,
): ValuationComputedYear {
  const i = histIndex(series, date);
  if (i < 0) {
    return emptyComputed();
  }
  const revenue = series.revenue[i] ?? null;
  const prevRev = i > 0 ? series.revenue[i - 1] ?? null : null;
  const op = series.operating_profit[i] ?? null;
  const expenses =
    series.expenses[i] ??
    (revenue != null && op != null ? revenue - op : null);
  const opm =
    revenue != null && revenue !== 0 && op != null
      ? Math.round((op / revenue) * 1000) / 10
      : null;
  const pat = series.pat[i] ?? null;
  const prevPat = i > 0 ? series.pat[i - 1] ?? null : null;
  const pbt = series.pbt[i] ?? null;
  const taxPct =
    series.tax_pct[i] ??
    (pbt != null && pat != null && pbt !== 0
      ? Math.round(((pbt - pat) / pbt) * 1000) / 10
      : null);
  return {
    revenue,
    revenue_growth: pctChange(revenue, prevRev),
    expenses,
    operating_profit: op,
    opm,
    other_income: series.other_income[i] ?? null,
    interest: series.interest[i] ?? null,
    depreciation: series.depreciation[i] ?? null,
    pbt,
    tax_pct: taxPct,
    pat,
    pat_growth: pctChange(pat, prevPat),
    shares_cr: series.shares_cr[i] ?? null,
    eps: series.eps[i] ?? null,
    forward_pe: null,
  };
}

function emptyComputed(): ValuationComputedYear {
  return {
    revenue: null,
    revenue_growth: null,
    expenses: null,
    operating_profit: null,
    opm: null,
    other_income: null,
    interest: null,
    depreciation: null,
    pbt: null,
    tax_pct: null,
    pat: null,
    pat_growth: null,
    shares_cr: null,
    eps: null,
    forward_pe: null,
  };
}

function seedFromPrior(prior: ValuationComputedYear): ValuationEstimateInput {
  return {
    revenue_growth_pct: prior.revenue_growth,
    opm_pct: prior.opm,
    other_income: prior.other_income,
    interest: prior.interest,
    depreciation: prior.depreciation,
    tax_pct: prior.tax_pct,
    shares_cr: prior.shares_cr,
    revenue: null,
  };
}

function mergeInput(
  base: ValuationEstimateInput,
  overlay: ValuationEstimateInput | undefined,
): ValuationEstimateInput {
  if (!overlay) return base;
  return {
    revenue_growth_pct:
      overlay.revenue_growth_pct ?? base.revenue_growth_pct,
    opm_pct: overlay.opm_pct ?? base.opm_pct,
    other_income: overlay.other_income ?? base.other_income,
    interest: overlay.interest ?? base.interest,
    depreciation: overlay.depreciation ?? base.depreciation,
    tax_pct: overlay.tax_pct ?? base.tax_pct,
    shares_cr: overlay.shares_cr ?? base.shares_cr,
    revenue: overlay.revenue ?? base.revenue,
  };
}

function computeEstYear(
  prior: ValuationComputedYear,
  input: ValuationEstimateInput,
  price: number | null,
): ValuationComputedYear {
  const g = input.revenue_growth_pct;
  let revenue = input.revenue;
  if (revenue == null && prior.revenue != null && g != null) {
    revenue = Math.round(prior.revenue * (1 + g / 100) * 10) / 10;
  }
  const revenue_growth =
    revenue != null && prior.revenue != null
      ? pctChange(revenue, prior.revenue)
      : g;

  const opm = input.opm_pct;
  const operating_profit =
    revenue != null && opm != null
      ? Math.round(revenue * (opm / 100) * 10) / 10
      : null;
  const expenses =
    revenue != null && operating_profit != null
      ? Math.round((revenue - operating_profit) * 10) / 10
      : null;

  const other_income = input.other_income;
  const interest = input.interest;
  const depreciation = input.depreciation;
  const pbt =
    operating_profit != null
      ? Math.round(
          (operating_profit +
            (other_income ?? 0) -
            (interest ?? 0) -
            (depreciation ?? 0)) *
            10,
        ) / 10
      : null;

  const tax_pct = input.tax_pct;
  const pat =
    pbt != null && tax_pct != null
      ? Math.round(pbt * (1 - tax_pct / 100) * 10) / 10
      : null;

  const shares_cr = input.shares_cr ?? prior.shares_cr;
  const eps =
    pat != null && shares_cr != null && shares_cr !== 0
      ? Math.round((pat / shares_cr) * 100) / 100
      : null;

  const forward_pe =
    price != null && eps != null && eps > 0
      ? Math.round((price / eps) * 10) / 10
      : null;

  return {
    revenue,
    revenue_growth,
    expenses,
    operating_profit,
    opm,
    other_income,
    interest,
    depreciation,
    pbt,
    tax_pct,
    pat,
    pat_growth: pctChange(pat, prior.pat),
    shares_cr,
    eps,
    forward_pe,
  };
}

/** Build full grid for columns given hist + per-estimate overlays. */
export function computeValuationGrid(opts: {
  series: ValuationHistSeries;
  columns: ValuationColumn[];
  estimates: Record<string, ValuationEstimateInput>;
  price: number | null;
}): ValuationComputedYear[] {
  const out: ValuationComputedYear[] = [];
  for (let i = 0; i < opts.columns.length; i++) {
    const col = opts.columns[i]!;
    if (col.kind === "hist") {
      const y = histYear(opts.series, col.date);
      out.push(y);
      continue;
    }
    const prior = out[i - 1] ?? emptyComputed();
    const seeded = seedFromPrior(prior);
    const input = mergeInput(seeded, opts.estimates[col.key]);
    out.push(computeEstYear(prior, input, opts.price));
  }
  return out;
}

/** Simple CAGR from first hist revenue to last est revenue. */
export function revenueCagr(
  years: ValuationComputedYear[],
): number | null {
  const nums = years
    .map((y) => y.revenue)
    .filter((v): v is number => v != null && v > 0);
  if (nums.length < 2) return null;
  const first = nums[0]!;
  const last = nums[nums.length - 1]!;
  const n = nums.length - 1;
  if (first <= 0 || n <= 0) return null;
  return Math.round((Math.pow(last / first, 1 / n) - 1) * 1000) / 10;
}

export function loadScenarioEstimates(
  ticker: string,
  scenario: ValuationScenario,
): Record<string, ValuationEstimateInput> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(
      `${STORAGE_PREFIX}${ticker.toUpperCase()}.${scenario}`,
    );
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ValuationEstimateInput>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveScenarioEstimates(
  ticker: string,
  scenario: ValuationScenario,
  estimates: Record<string, ValuationEstimateInput>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `${STORAGE_PREFIX}${ticker.toUpperCase()}.${scenario}`,
      JSON.stringify(estimates),
    );
  } catch {
    /* ignore */
  }
}

export function recentValuationTickers(limit = 12): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}recent`);
    if (!raw) return [];
    const arr = JSON.parse(raw) as string[];
    return Array.isArray(arr)
      ? arr.map((t) => String(t).toUpperCase()).filter(Boolean).slice(0, limit)
      : [];
  } catch {
    return [];
  }
}

export function pushRecentValuationTicker(ticker: string): void {
  if (typeof window === "undefined") return;
  const t = ticker.trim().toUpperCase();
  if (!t) return;
  const prev = recentValuationTickers(24).filter((x) => x !== t);
  try {
    window.localStorage.setItem(
      `${STORAGE_PREFIX}recent`,
      JSON.stringify([t, ...prev].slice(0, 24)),
    );
  } catch {
    /* ignore */
  }
}
