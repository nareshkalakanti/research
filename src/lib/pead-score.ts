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

/** Post-earnings return from first close after result date through latest/live. */
export function computeReturnsPct(
  bars: Array<{ date: string; close: number }>,
  resultDate: string | null | undefined,
  currentPrice?: number | null,
): number | null {
  const rd = (resultDate || "").slice(0, 10);
  if (!rd || !bars.length) return null;
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  let after = sorted.filter((b) => b.date > rd);
  if (!after.length) after = sorted.filter((b) => b.date >= rd);
  if (!after.length) return null;
  const entry = after[0]!.close;
  if (!(entry > 0)) return null;
  const last = sorted[sorted.length - 1]!.close;
  const exit =
    currentPrice != null && Number.isFinite(currentPrice) && currentPrice > 0
      ? currentPrice
      : last;
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
