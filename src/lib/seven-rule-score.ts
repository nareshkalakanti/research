/**
 * 7-Rule stock score (1 point each). Pure — no I/O.
 *
 * Quarterly series default **oldest → newest** (newest-last), matching
 * `buildQuarterPanel`. Pass `order: "newest-first"` or ISO `dates` (auto-detect)
 * when your arrays run newest-first.
 */
import {
  profitYoyPct,
  yoyPairFromPanel,
  yoyPct,
  type QuarterPanel,
} from "./quarter-panel";

export type RuleVerdict = "pass" | "fail" | "unknown";

export type SevenRuleRating = "strong_buy" | "buy" | "deep_dive" | "no";

export type SevenRuleId =
  | "roce"
  | "roe"
  | "sales_qoq"
  | "profit_qoq"
  | "sales_yoy"
  | "profit_yoy"
  | "opm_trend";

export type SevenRuleRule = {
  id: SevenRuleId;
  label: string;
  verdict: RuleVerdict;
  value: string | null;
  threshold: string;
};

export type SevenRuleResult = {
  passed: number;
  score: number;
  /** Null while any rule is UNKNOWN (provisional). */
  rating: SevenRuleRating | null;
  ratingLabel: string | null;
  provisional: boolean;
  evaluated: number;
  rules: SevenRuleRule[];
};

export type SevenRuleInput = {
  roce?: number | null;
  roe?: number | null;
  sales?: Array<number | null> | null;
  profit?: Array<number | null> | null;
  opm?: Array<number | null> | null;
  /** Panel quarter labels, oldest → newest. */
  labels?: string[] | null;
  order?: "newest-last" | "newest-first";
  /** ISO dates parallel to sales — used to detect newest-first. */
  dates?: string[] | null;
};

const ROCE_MIN = 0.15;
const ROE_MIN = 0.15;
const SALES_QOQ_MIN = 10;
const PROFIT_QOQ_MIN = 10;
const SALES_YOY_MIN = 10;
const PROFIT_YOY_MIN = 15;
const RULE_COUNT = 7;

function finite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtRatio(v: number | null): string | null {
  if (!finite(v)) return null;
  return `${(v * 100).toFixed(1)}%`;
}

function fmtPctPts(v: number | null): string | null {
  if (!finite(v)) return null;
  const digits = Number.isInteger(v) ? 0 : 1;
  return `${v.toFixed(digits)}%`;
}

function pairLatestPrev(
  values: Array<number | null>,
): [number | null, number | null] {
  if (values.length < 2) return [null, null];
  return [
    values[values.length - 1] ?? null,
    values[values.length - 2] ?? null,
  ];
}

function yoyFromSeries(
  values: Array<number | null>,
  labels: string[],
): [number | null, number | null] {
  if (labels.length === values.length && labels.length >= 2) {
    return yoyPairFromPanel(values, labels);
  }
  if (values.length >= 5) {
    const latest = values[values.length - 1] ?? null;
    const prior = values[values.length - 5] ?? null;
    return [latest, prior];
  }
  return [null, null];
}

/** Human note when same-quarter YoY cannot be computed. */
function yoyUnknownNote(
  values: Array<number | null>,
  labels: string[],
  metric: string,
): string {
  if (!labels.length || labels.length !== values.length) {
    return `Missing ${metric} for latest Q vs same Q last year`;
  }
  const latestIdx = labels.length - 1;
  const latestLabel = labels[latestIdx]!;
  const latestVal = values[latestIdx];
  if (latestVal == null) {
    return `Missing ${metric} for ${latestLabel}`;
  }
  // Mirror yoyPairFromPanel: need same month, year-1.
  const parts = latestLabel.trim().split(/\s+/);
  const mon = parts[0] ?? "Q";
  const year = Number(parts[1]);
  const need =
    Number.isFinite(year) ? `${mon} ${year - 1}` : "same quarter last year";
  const priorIdx = labels.findIndex((l, i) => {
    if (i >= latestIdx) return false;
    const p = l.trim().split(/\s+/);
    return p[0] === mon && Number(p[1]) === year - 1;
  });
  if (priorIdx < 0) return `Missing ${metric} for ${need} (have ${latestLabel})`;
  if (values[priorIdx] == null) {
    return `Missing ${metric} for ${labels[priorIdx]}`;
  }
  return `Cannot compute ${metric} YoY (${latestLabel})`;
}

function detectNewestFirst(dates: string[] | null | undefined): boolean {
  if (!dates || dates.length < 2) return false;
  const a = dates[0]!.slice(0, 10);
  const b = dates[dates.length - 1]!.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) {
    return false;
  }
  return a > b;
}

function normalizeSeries<T>(
  arr: T[] | null | undefined,
  order: SevenRuleInput["order"],
  dates: string[] | null | undefined,
): T[] {
  const raw = arr ?? [];
  if (!raw.length) return [];
  const newestFirst =
    order === "newest-first" ||
    (order !== "newest-last" && detectNewestFirst(dates));
  return newestFirst ? [...raw].reverse() : [...raw];
}

function verdictFromThreshold(
  value: number | null,
  min: number,
): RuleVerdict {
  if (value == null) return "unknown";
  if (value > min) return "pass";
  return "fail";
}

export function sevenRuleRatingFromPassed(passed: number): {
  rating: SevenRuleRating;
  ratingLabel: string;
} {
  if (passed >= 7) return { rating: "strong_buy", ratingLabel: "STRONG BUY" };
  if (passed === 6) return { rating: "buy", ratingLabel: "BUY" };
  if (passed === 5) return { rating: "deep_dive", ratingLabel: "DEEP DIVE" };
  return { rating: "no", ratingLabel: "NO" };
}

/** Profit QoQ/YoY — UNKNOWN when prior ≤ 0 (avoid misleading % on zero/loss base). */
function profitGrowthPct(
  latest: number | null,
  prior: number | null,
): number | null {
  if (latest == null || prior == null || !Number.isFinite(latest)) return null;
  if (!Number.isFinite(prior) || prior <= 0) return null;
  return profitYoyPct(latest, prior);
}

export function sevenRuleScore(input: SevenRuleInput): SevenRuleResult {
  const sales = normalizeSeries(input.sales, input.order, input.dates);
  const profit = normalizeSeries(input.profit, input.order, input.dates);
  const opm = normalizeSeries(input.opm, input.order, input.dates);
  let labels = normalizeSeries(input.labels ?? [], input.order, input.dates);

  if (labels.length && labels.length !== sales.length) {
    labels = [];
  }

  const roceV = finite(input.roce) ? input.roce : null;
  const roeV = finite(input.roe) ? input.roe : null;

  const [sLatest, sPrev] = pairLatestPrev(sales);
  const salesQoq = yoyPct(sLatest, sPrev);
  const [pLatest, pPrev] = pairLatestPrev(profit);
  const profitQoq = profitGrowthPct(pLatest, pPrev);

  const [sYLatest, sYPrior] = yoyFromSeries(sales, labels);
  const salesYoy = yoyPct(sYLatest, sYPrior);
  const [pYLatest, pYPrior] = yoyFromSeries(profit, labels);
  const profitYoy = profitGrowthPct(pYLatest, pYPrior);

  const [opmLatest, opmPrev] = pairLatestPrev(opm);
  let opmVerdict: RuleVerdict = "unknown";
  if (opmLatest != null && opmPrev != null) {
    opmVerdict = opmLatest > opmPrev ? "pass" : "fail";
  }

  const rules: SevenRuleRule[] = [
    {
      id: "roce",
      label: "ROCE > 15%",
      verdict: finite(roceV)
        ? roceV > ROCE_MIN
          ? "pass"
          : "fail"
        : "unknown",
      value: fmtRatio(roceV),
      threshold: "> 15%",
    },
    {
      id: "roe",
      label: "ROE > 15%",
      verdict: finite(roeV) ? (roeV > ROE_MIN ? "pass" : "fail") : "unknown",
      value: fmtRatio(roeV),
      threshold: "> 15%",
    },
    {
      id: "sales_qoq",
      label: "QoQ sales growth > 10%",
      verdict: verdictFromThreshold(salesQoq, SALES_QOQ_MIN),
      value: fmtPctPts(salesQoq),
      threshold: "> 10%",
    },
    {
      id: "profit_qoq",
      label: "QoQ profit growth > 10%",
      verdict: verdictFromThreshold(profitQoq, PROFIT_QOQ_MIN),
      value: fmtPctPts(profitQoq),
      threshold: "> 10%",
    },
    {
      id: "sales_yoy",
      label: "YoY quarterly sales > 10%",
      verdict: verdictFromThreshold(salesYoy, SALES_YOY_MIN),
      value:
        fmtPctPts(salesYoy) ??
        yoyUnknownNote(sales, labels, "sales"),
      threshold: "> 10%",
    },
    {
      id: "profit_yoy",
      label: "YoY quarterly profit > 15%",
      verdict: verdictFromThreshold(profitYoy, PROFIT_YOY_MIN),
      value:
        fmtPctPts(profitYoy) ??
        yoyUnknownNote(profit, labels, "profit"),
      threshold: "> 15%",
    },
    {
      id: "opm_trend",
      label: "Latest OPM > prior quarter",
      verdict: opmVerdict,
      value:
        opmLatest != null && opmPrev != null
          ? `${fmtPctPts(opmLatest)} vs ${fmtPctPts(opmPrev)}`
          : opmLatest != null
            ? fmtPctPts(opmLatest)
            : null,
      threshold: "↑ vs prior Q",
    },
  ];

  const passed = rules.filter((r) => r.verdict === "pass").length;
  const evaluated = rules.filter(
    (r) => r.verdict === "pass" || r.verdict === "fail",
  ).length;
  const provisional = evaluated < RULE_COUNT;
  const score = round2((passed / RULE_COUNT) * 10);
  const rated = provisional ? null : sevenRuleRatingFromPassed(passed);

  return {
    passed,
    score,
    rating: rated?.rating ?? null,
    ratingLabel: rated?.ratingLabel ?? null,
    provisional,
    evaluated,
    rules,
  };
}

function rowValues(panel: QuarterPanel, label: string): Array<number | null> {
  return panel.rows.find((r) => r.label === label)?.values ?? [];
}

/** Score from a quarter panel (oldest → newest) plus annual ROCE/ROE ratios. */
export function sevenRuleFromPanel(
  panel: QuarterPanel | null | undefined,
  opts: { roce?: number | null; roe?: number | null },
): SevenRuleResult | null {
  if (!panel?.labels?.length) return null;
  return sevenRuleScore({
    roce: opts.roce ?? null,
    roe: opts.roe ?? null,
    sales: rowValues(panel, "Sales"),
    profit: rowValues(panel, "Net Profit"),
    opm: rowValues(panel, "OPM %"),
    labels: panel.labels,
    order: "newest-last",
  });
}

export function sevenRuleRatingMatches(
  rating: SevenRuleRating | null,
  filter: string | null | undefined,
): boolean {
  const f = (filter || "").trim().toLowerCase().replace(/-/g, "_");
  if (!f) return true;
  if (rating == null) return false;
  if (f === "strong_buy") return rating === "strong_buy";
  if (f === "buy") return rating === "buy";
  if (f === "deep_dive") return rating === "deep_dive";
  if (f === "no" || f === "avoid" || f === "sell") return rating === "no";
  return true;
}
