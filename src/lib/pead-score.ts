/**
 * PEAD2 scoring from stocks-ai (`score_pead2_percentile` / absolute / returns).
 * Weights and formulas only — no issuer facts.
 */

export type PeadInputs = {
  returns_pct: number | null;
  sales_yoy: number | null;
  sales_qoq: number | null;
  np_yoy: number | null;
  np_qoq: number | null;
  eps_yoy: number | null;
  eps_qoq: number | null;
  ebidt_yoy: number | null;
  ebidt_qoq: number | null;
  forward_pe: number | null;
  cf_profit: number | null;
};

/** Universe percentile ranks (FinanciallyFree PEAD dashboard). */
export const PEAD2_SCORE_WEIGHTS = {
  returns: 14,
  sales_yoy: 12,
  sales_qoq: 11,
  np_yoy: 13,
  np_qoq: 15,
  eps_yoy: 8,
  eps_qoq: 8,
  ebidt_yoy: 8,
  ebidt_qoq: 6,
  forward_pe: 8,
  cf_profit: 2,
} as const;

/** Absolute 0–100 weights (sum 0.90). */
export const PEAD2_ABSOLUTE_WEIGHTS = {
  sales_yoy: 0.15,
  np_yoy: 0.2,
  sales_qoq: 0.1,
  np_qoq: 0.15,
  ebidt_yoy: 0.1,
  ebidt_qoq: 0.05,
  forward_pe: 0.15,
} as const;

const GROWTH_CAP = 100;
const PE_IDEAL = 15;
const PE_BAD = 50;

type MetricSpec = {
  key: keyof PeadInputs;
  weight: number;
  invert: boolean;
};

const PERCENTILE_SPECS: MetricSpec[] = [
  { key: "returns_pct", weight: PEAD2_SCORE_WEIGHTS.returns, invert: false },
  { key: "sales_yoy", weight: PEAD2_SCORE_WEIGHTS.sales_yoy, invert: false },
  { key: "sales_qoq", weight: PEAD2_SCORE_WEIGHTS.sales_qoq, invert: false },
  { key: "np_yoy", weight: PEAD2_SCORE_WEIGHTS.np_yoy, invert: false },
  { key: "np_qoq", weight: PEAD2_SCORE_WEIGHTS.np_qoq, invert: false },
  { key: "eps_yoy", weight: PEAD2_SCORE_WEIGHTS.eps_yoy, invert: false },
  { key: "eps_qoq", weight: PEAD2_SCORE_WEIGHTS.eps_qoq, invert: false },
  { key: "ebidt_yoy", weight: PEAD2_SCORE_WEIGHTS.ebidt_yoy, invert: false },
  { key: "ebidt_qoq", weight: PEAD2_SCORE_WEIGHTS.ebidt_qoq, invert: false },
  { key: "forward_pe", weight: PEAD2_SCORE_WEIGHTS.forward_pe, invert: true },
  { key: "cf_profit", weight: PEAD2_SCORE_WEIGHTS.cf_profit, invert: false },
];

function num(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v;
}

function clamp(x: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, x));
}

function absoluteGrowthScore(val: number | null): number | null {
  const v = num(val);
  if (v == null) return null;
  return clamp((v / GROWTH_CAP) * 100);
}

function absolutePeScore(pe: number | null): number | null {
  const v = num(pe);
  if (v == null || v <= 0) return null;
  return clamp(100 - ((v - PE_IDEAL) / (PE_BAD - PE_IDEAL)) * 100);
}

/** Single-name 0–100 score when a universe is too small for percentiles. */
export function peadScoreAbsolute(row: PeadInputs): number | null {
  const parts: Array<[number, number]> = [];
  const g = [
    ["sales_yoy", PEAD2_ABSOLUTE_WEIGHTS.sales_yoy],
    ["sales_qoq", PEAD2_ABSOLUTE_WEIGHTS.sales_qoq],
    ["np_yoy", PEAD2_ABSOLUTE_WEIGHTS.np_yoy],
    ["np_qoq", PEAD2_ABSOLUTE_WEIGHTS.np_qoq],
    ["ebidt_yoy", PEAD2_ABSOLUTE_WEIGHTS.ebidt_yoy],
    ["ebidt_qoq", PEAD2_ABSOLUTE_WEIGHTS.ebidt_qoq],
  ] as const;
  for (const [key, w] of g) {
    const s = absoluteGrowthScore(row[key]);
    if (s != null) parts.push([s, w]);
  }
  const pe = absolutePeScore(row.forward_pe);
  if (pe != null) parts.push([pe, PEAD2_ABSOLUTE_WEIGHTS.forward_pe]);
  if (!parts.length) return null;
  const weightSum = parts.reduce((a, [, w]) => a + w, 0);
  const full = Object.values(PEAD2_ABSOLUTE_WEIGHTS).reduce((a, b) => a + b, 0);
  const composite = parts.reduce((a, [s, w]) => a + s * w, 0);
  const scaled = composite * (full / weightSum);
  return Math.round(Math.min(100, scaled) * 10) / 10;
}

function percentileOf(values: Array<number | null>, invert: boolean): Array<number | null> {
  const rankedIdx: number[] = [];
  const nums: number[] = [];
  values.forEach((v, i) => {
    if (v != null && Number.isFinite(v)) {
      rankedIdx.push(i);
      nums.push(v);
    }
  });
  const out: Array<number | null> = values.map(() => null);
  if (nums.length < 2) {
    rankedIdx.forEach((i) => {
      out[i] = 50;
    });
    return out;
  }
  const sorted = [...nums].sort((a, b) => a - b);
  rankedIdx.forEach((i, k) => {
    const v = nums[k]!;
    let lo = 0;
    let hi = 0;
    for (const s of sorted) {
      if (s < v) lo += 1;
      if (s <= v) hi += 1;
    }
    const avgRank = (lo + hi) / 2;
    let pct = (avgRank / nums.length) * 100;
    if (invert) pct = 100 - pct;
    out[i] = pct;
  });
  return out;
}

/** Universe percentile PEAD score (0–100). Falls back to absolute per row. */
export function peadScoresPercentile(rows: PeadInputs[]): Array<number | null> {
  if (!rows.length) return [];
  const pctByKey = new Map<keyof PeadInputs, Array<number | null>>();
  for (const spec of PERCENTILE_SPECS) {
    if (spec.weight <= 0) continue;
    pctByKey.set(
      spec.key,
      percentileOf(
        rows.map((r) => num(r[spec.key])),
        spec.invert,
      ),
    );
  }
  return rows.map((row, i) => {
    let composite = 0;
    let weight = 0;
    for (const spec of PERCENTILE_SPECS) {
      const pct = pctByKey.get(spec.key)?.[i];
      if (pct == null || !Number.isFinite(pct)) continue;
      composite += pct * spec.weight;
      weight += spec.weight;
    }
    if (weight <= 0) return peadScoreAbsolute(row);
    return Math.round((composite / weight) * 10) / 10;
  });
}

function barDay(raw: string | null | undefined): string {
  return (raw || "").slice(0, 10);
}

/**
 * Post-earnings Ret — same shape as Concall Drift %:
 * (LTP − result-day close) / result-day close × 100.
 * Day column keeps the announce gap (prior → result session).
 */
export function computeReturnsPct(
  bars: Array<{ date: string; close: number }>,
  resultDate: string | null | undefined,
  currentPrice?: number | null,
): number | null {
  const entry = resultEntryClose(bars, resultDate);
  if (entry == null || !(entry > 0)) return null;
  const sorted = [...bars]
    .map((b) => ({ date: barDay(b.date), close: b.close }))
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return null;
  const last = sorted[sorted.length - 1]!.close;
  const exit =
    currentPrice != null && Number.isFinite(currentPrice) && currentPrice > 0
      ? currentPrice
      : last;
  if (!(exit > 0)) return null;
  return Math.round((exit / entry - 1) * 10000) / 100;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function formatResultDate(iso: string | null | undefined): string {
  const d = (iso || "").slice(0, 10);
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "—";
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const mon = MONTHS[month - 1];
  if (!mon || !Number.isFinite(day)) return "—";
  return `${day} ${mon} ${String(year).slice(-2)}`;
}

export function peadScoreClass(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return "pead-na";
  if (score >= 70) return "pead-good";
  if (score >= 45) return "pead-mid";
  return "pead-bad";
}

/** FinanciallyFree Result Monitor score (can be negative). */
export function peadScoreFfMonitor(
  sales_yoy: number | null,
  sales_qoq: number | null,
  forward_pe: number | null,
): number | null {
  const peCheapMax = 20;
  const peBonusPerPoint = 2.4;
  const growthCap = 100;
  const parts: number[] = [];
  for (const raw of [sales_yoy, sales_qoq]) {
    const v = num(raw);
    if (v == null) continue;
    parts.push(Math.max(-growthCap, Math.min(growthCap, v)));
  }
  if (!parts.length) return null;
  let score = parts.reduce((a, b) => a + b, 0) / parts.length;
  const pe = num(forward_pe);
  if (pe != null && pe > 0 && pe < 500 && pe < peCheapMax) {
    score += (peCheapMax - pe) * peBonusPerPoint;
  }
  return Math.round(score * 10) / 10;
}

/** Same monitor formula; NP then EBIDT if sales YoY/QoQ are missing. */
export function peadScoreFf(
  sales_yoy: number | null,
  sales_qoq: number | null,
  np_yoy: number | null,
  np_qoq: number | null,
  ebidt_yoy: number | null,
  ebidt_qoq: number | null,
  forward_pe: number | null,
): number | null {
  return (
    peadScoreFfMonitor(sales_yoy, sales_qoq, forward_pe) ??
    peadScoreFfMonitor(np_yoy, np_qoq, forward_pe) ??
    peadScoreFfMonitor(ebidt_yoy, ebidt_qoq, forward_pe)
  );
}

/** Unusable / missing run-rate PE is blank — not a 999.0 print. */
export function usableForwardPe(forward_pe: number | null): number | null {
  const pe = num(forward_pe);
  if (pe == null || pe <= 0 || pe >= 500) return null;
  return pe;
}

/** Dashboard badge: high > 40, low if negative or very small. */
export function pead2ScoreClass(
  score: number | null | undefined,
  highMin = 40,
): string {
  if (score == null || !Number.isFinite(score)) return "pead2-score-na";
  if (score > highMin) return "pead2-score-high";
  if (score < 0 || score <= highMin * 0.35) return "pead2-score-low";
  return "pead2-score-mid";
}

/**
 * Day change on the result session only: prior close → first close on/after
 * result date. Not the max of later days (that inflated "Day" for weeks).
 */
export function computeDailyRetFf(
  bars: Array<{ date: string; close: number }>,
  resultDate: string | null | undefined,
  cap = 0,
): number | null {
  const rd = barDay(resultDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rd) || !bars.length) return null;
  const sorted = [...bars]
    .map((b) => ({ date: barDay(b.date), close: b.close }))
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return null;
  if (sorted[sorted.length - 1]!.date < rd) return null;
  const prior = sorted.filter((b) => b.date < rd);
  const first = sorted.find((b) => b.date >= rd);
  if (!first || !(first.close > 0)) return null;
  const prev = prior.length > 0 ? prior[prior.length - 1]!.close : null;
  if (prev == null || !(prev > 0)) return null;
  const move = (first.close / prev - 1) * 100;
  const out = cap > 0 ? Math.min(move, cap) : move;
  return Math.round(out * 100) / 100;
}

/**
 * Ret baseline (Drift-style call-day close): first session close on/after result date.
 */
export function resultEntryClose(
  bars: Array<{ date: string; close: number }>,
  resultDate: string | null | undefined,
): number | null {
  const rd = barDay(resultDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rd) || !bars.length) return null;
  const sorted = [...bars]
    .map((b) => ({ date: barDay(b.date), close: b.close }))
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const hit = sorted.find((b) => b.date >= rd);
  return hit && hit.close > 0 ? hit.close : null;
}

/** Score → short action label (product bands, not issuer special-cases). */
export function peadRecommendation(
  score: number | null | undefined,
  highMin = 40,
): "Buy" | "Watch" | "Avoid" | null {
  if (score == null || !Number.isFinite(score)) return null;
  if (score > highMin) return "Buy";
  if (score < 0 || score <= highMin * 0.35) return "Avoid";
  return "Watch";
}

/** Live returns from stored entry close → current price. */
export function returnsPctFromEntry(
  entryClose: number | null | undefined,
  currentPrice: number | null | undefined,
): number | null {
  if (
    entryClose == null ||
    !(entryClose > 0) ||
    currentPrice == null ||
    !(currentPrice > 0)
  ) {
    return null;
  }
  return Math.round((currentPrice / entryClose - 1) * 10000) / 100;
}
