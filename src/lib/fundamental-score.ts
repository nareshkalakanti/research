/**
 * Fundamental Score (0–6): +1 per rule. Pure — no I/O.
 *
 * Color bands: 3–6 green · 1–2 yellow · 0 red.
 */
export type FundamentalRuleId =
  | "bv_cagr"
  | "sales_cagr"
  | "roce"
  | "interest_cover"
  | "net_block"
  | "quality";

export type FundamentalRuleVerdict = "pass" | "fail" | "unknown";

export type FundamentalRule = {
  id: FundamentalRuleId;
  label: string;
  verdict: FundamentalRuleVerdict;
  value: string | null;
  threshold: string;
};

export type ScoreBand = "green" | "yellow" | "red";

export type FundamentalScoreResult = {
  score: number;
  passed: number;
  evaluated: number;
  band: ScoreBand;
  rules: FundamentalRule[];
};

export type FundamentalScoreInput = {
  /** Book value (Equity + Reserves), oldest → newest, ₹ Cr. */
  book_value?: Array<number | null> | null;
  /** Equity / share capital — used to detect true capital raises. */
  equity_capital?: Array<number | null> | null;
  /** Sales / revenue, oldest → newest, ₹ Cr. */
  sales?: Array<number | null> | null;
  /** Latest ROCE as ratio (0.16 = 16%) or percent (>1.5 → ÷100). */
  roce?: number | null;
  operating_profit?: number | null;
  /** OP series oldest → newest (for multi-year interest cover). */
  operating_profit_series?: Array<number | null> | null;
  /** Fallback when OP missing (NBFCs): cover uses (PBT + Interest) / Interest. */
  pbt?: number | null;
  interest?: number | null;
  /** Interest series oldest → newest. */
  interest_series?: Array<number | null> | null;
  fixed_assets?: Array<number | null> | null;
  other_income?: number | null;
  /** When true, net-block check is N/A (lenders / asset-light). */
  skip_net_block?: boolean;
};

const BV_CAGR_MIN = 0.1;
const SALES_CAGR_MIN = 0.1;
const ROCE_MIN = 0.1;
const INTEREST_COVER_MIN = 5;
const NET_BLOCK_MULT_MIN = 2;
const OI_SALES_MAX = 0.1;
const BV_SPAN_YEARS = 10;
const SALES_PREF_YEARS = 10;
/** Equity-capital YoY jump ⇒ capital raise; drop pre-raise BV / sales history. */
const EQUITY_RAISE_MULT = 4;
/** Ignore micro seed-capital → IPO noise (₹ Cr). */
const EQUITY_RAISE_MIN_PRIOR = 1;
/** YoY sales jump treated as structural break (restatement). */
const SALES_JUMP_MULT = 4;
/** After a structural cut, require this many years before longest-CAGR fallback. */
const SALES_POST_JUMP_MIN_YEARS = 5;
/** Interest cover must clear the bar in each of the last N years when series exist. */
const INTEREST_COVER_YEARS = 3;

function finite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

function asRoceRatio(v: number | null | undefined): number | null {
  if (!finite(v)) return null;
  return Math.abs(v) > 1.5 ? v / 100 : v;
}

function fmtPct(ratio: number | null): string | null {
  if (!finite(ratio)) return null;
  return `${(ratio * 100).toFixed(1)}%`;
}

function fmtMult(v: number | null): string | null {
  if (!finite(v)) return null;
  return `${v.toFixed(2)}×`;
}

function fmtCover(v: number | null): string | null {
  if (!finite(v)) return null;
  if (v === Infinity) return "∞";
  return `${v.toFixed(1)}×`;
}

function lastFiniteIndex(values: Array<number | null>): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    if (finite(values[i])) return i;
  }
  return null;
}

function lastTwoFinite(
  values: Array<number | null> | null | undefined,
): [number | null, number | null] {
  if (!values?.length) return [null, null];
  const endIdx = lastFiniteIndex(values);
  if (endIdx == null) return [null, null];
  let prior: number | null = null;
  for (let i = endIdx - 1; i >= 0; i--) {
    if (finite(values[i])) {
      prior = values[i]!;
      break;
    }
  }
  return [values[endIdx]!, prior];
}

/** True n-year CAGR needs positive start/end and n > 0. */
export function seriesCagr(
  values: Array<number | null> | null | undefined,
  spanYears: number,
): number | null {
  if (!values?.length || spanYears <= 0) return null;
  const endIdx = lastFiniteIndex(values);
  if (endIdx == null) return null;
  const startIdx = endIdx - spanYears;
  if (startIdx < 0) return null;
  const start = values[startIdx];
  const end = values[endIdx];
  if (!finite(start) || !finite(end) || start <= 0 || end <= 0) return null;
  return Math.pow(end / start, 1 / spanYears) - 1;
}

/**
 * Drop history before a mega YoY jump (capital raise / restatement / IPO).
 * Returns { series, cut } where cut > 0 means a structural break was found.
 */
export function seriesAfterJumps(
  values: Array<number | null> | null | undefined,
  jumpMult: number,
  opts?: { minPrior?: number },
): { series: Array<number | null> | null; cut: number } {
  if (!values?.length) return { series: null, cut: 0 };
  const minPrior = opts?.minPrior ?? 0;
  let cut = 0;
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const cur = values[i];
    if (
      finite(prev) &&
      finite(cur) &&
      prev >= minPrior &&
      prev > 0 &&
      cur / prev >= jumpMult
    ) {
      cut = i;
    }
  }
  return { series: cut > 0 ? values.slice(cut) : values, cut };
}

/** Index of last qualifying equity-capital raise, or 0. */
export function equityRaiseCut(
  equity_capital: Array<number | null> | null | undefined,
): number {
  return seriesAfterJumps(equity_capital, EQUITY_RAISE_MULT, {
    minPrior: EQUITY_RAISE_MIN_PRIOR,
  }).cut;
}

/**
 * Drop BV history before a true capital raise (equity capital jump),
 * falling back to BV jumps only when equity series is missing.
 */
export function bookValueAfterRaises(
  book_value: Array<number | null> | null | undefined,
  equity_capital?: Array<number | null> | null,
): Array<number | null> | null {
  if (!book_value?.length) return null;
  const cut = equityRaiseCut(equity_capital);
  if (cut > 0 && cut < book_value.length) {
    return book_value.slice(cut);
  }
  if (!equity_capital?.some((v) => finite(v) && v >= EQUITY_RAISE_MIN_PRIOR)) {
    return seriesAfterJumps(book_value, SALES_JUMP_MULT).series;
  }
  return book_value;
}

function coverFromEbitInterest(
  ebit: number | null,
  interest: number | null,
): number | null {
  if (!finite(ebit)) return null;
  if (interest == null || interest === 0) return ebit > 0 ? Infinity : null;
  if (!finite(interest) || interest < 0) return null;
  return ebit / interest;
}

/** Longest positive span ending at latest finite point (min 1 year). */
export function longestCagr(
  values: Array<number | null> | null | undefined,
): { cagr: number; years: number } | null {
  if (!values?.length) return null;
  const endIdx = lastFiniteIndex(values);
  if (endIdx == null || endIdx < 1) return null;
  const end = values[endIdx]!;
  if (end <= 0) return null;
  for (let years = endIdx; years >= 1; years--) {
    const start = values[endIdx - years];
    if (!finite(start) || start <= 0) continue;
    return { cagr: Math.pow(end / start, 1 / years) - 1, years };
  }
  return null;
}

/** Score band for 0–N count scores (Fundamental / Management). */
export function countScoreBand(score: number): ScoreBand {
  if (score >= 3) return "green";
  if (score >= 1) return "yellow";
  return "red";
}

/** Band for signed valuation-style scores. */
export function signedScoreBand(score: number): ScoreBand {
  if (score >= 3) return "green";
  if (score >= 1) return "yellow";
  return "red";
}

export function fundamentalScore(
  input: FundamentalScoreInput,
): FundamentalScoreResult {
  const rules: FundamentalRule[] = [];

  {
    const bvSeries = bookValueAfterRaises(
      input.book_value,
      input.equity_capital,
    );
    const cagr = seriesCagr(bvSeries, BV_SPAN_YEARS);
    let verdict: FundamentalRuleVerdict = "unknown";
    if (finite(cagr)) verdict = cagr > BV_CAGR_MIN ? "pass" : "fail";
    else if (bvSeries?.length) {
      // Post-raise history shorter than 10Y → cannot claim 10Y BV growth.
      verdict = "fail";
    }
    rules.push({
      id: "bv_cagr",
      label: "Book value 10Y CAGR",
      verdict,
      value: fmtPct(cagr),
      threshold: `>${BV_CAGR_MIN * 100}% over ${BV_SPAN_YEARS}Y`,
    });
  }

  {
    const salesJump = seriesAfterJumps(input.sales, SALES_JUMP_MULT);
    const eqCut = equityRaiseCut(input.equity_capital);
    const cut = Math.max(salesJump.cut, eqCut);
    const salesSeries =
      cut > 0 && input.sales?.length
        ? input.sales.slice(cut)
        : (input.sales ?? null);
    const truncated = cut > 0;
    const pref = seriesCagr(salesSeries, SALES_PREF_YEARS);
    const long = longestCagr(salesSeries);
    // After IPO / restatement, only trust longest CAGR with enough years.
    const longOk =
      long != null &&
      (!truncated || long.years >= SALES_POST_JUMP_MIN_YEARS);
    const usePref = finite(pref);
    const cagr = usePref ? pref : longOk ? long!.cagr : null;
    const years = usePref ? SALES_PREF_YEARS : longOk ? long!.years : null;
    let verdict: FundamentalRuleVerdict = "unknown";
    if (finite(cagr)) verdict = cagr > SALES_CAGR_MIN ? "pass" : "fail";
    else if (truncated && salesSeries?.length) {
      verdict = "fail";
    }
    rules.push({
      id: "sales_cagr",
      label: years != null ? `Sales ${years}Y CAGR` : "Sales CAGR",
      verdict,
      value: fmtPct(cagr),
      threshold: `>${SALES_CAGR_MIN * 100}%`,
    });
  }

  {
    const roce = asRoceRatio(input.roce);
    let verdict: FundamentalRuleVerdict = "unknown";
    if (finite(roce)) verdict = roce > ROCE_MIN ? "pass" : "fail";
    rules.push({
      id: "roce",
      label: "ROCE",
      verdict,
      value: fmtPct(roce),
      threshold: `>${ROCE_MIN * 100}%`,
    });
  }

  {
    const opSeries = input.operating_profit_series;
    const intSeries = input.interest_series;
    let cover: number | null = null;
    let verdict: FundamentalRuleVerdict = "unknown";

    const covers: number[] = [];
    if (opSeries?.length && intSeries?.length) {
      const n = Math.min(opSeries.length, intSeries.length);
      for (let i = n - 1; i >= 0 && covers.length < INTEREST_COVER_YEARS; i--) {
        const op = opSeries[i];
        const interest = intSeries[i];
        if (!finite(op) && !(finite(input.pbt) && i === n - 1)) continue;
        const ebit =
          finite(op)
            ? op
            : finite(input.pbt) && finite(interest)
              ? input.pbt + interest
              : null;
        const c = coverFromEbitInterest(ebit, finite(interest) ? interest : null);
        if (finite(c)) covers.push(c);
      }
    }

    if (covers.length >= 2) {
      cover = Math.min(...covers.map((c) => (c === Infinity ? 1e9 : c)));
      if (cover >= 1e9) cover = Infinity;
      verdict = covers.every(
        (c) => c === Infinity || c > INTEREST_COVER_MIN,
      )
        ? "pass"
        : "fail";
    } else {
      const op = finite(input.operating_profit) ? input.operating_profit : null;
      const pbt = finite(input.pbt) ? input.pbt : null;
      const interest = finite(input.interest) ? input.interest : null;
      const ebit =
        finite(op) ? op : finite(pbt) && finite(interest) ? pbt + interest : null;
      cover = coverFromEbitInterest(ebit, interest);
      if (finite(cover)) {
        verdict =
          cover === Infinity || cover > INTEREST_COVER_MIN ? "pass" : "fail";
      }
    }
    rules.push({
      id: "interest_cover",
      label: "Interest cover",
      verdict,
      value: fmtCover(cover),
      threshold: `>${INTEREST_COVER_MIN}×`,
    });
  }

  {
    let mult: number | null = null;
    let verdict: FundamentalRuleVerdict = "unknown";
    if (!input.skip_net_block) {
      const [latest, prior] = lastTwoFinite(input.fixed_assets);
      if (finite(latest) && finite(prior) && prior > 0) {
        mult = latest / prior;
        verdict = mult > NET_BLOCK_MULT_MIN ? "pass" : "fail";
      }
    }
    rules.push({
      id: "net_block",
      label: "Net block YoY",
      verdict,
      value: fmtMult(mult),
      threshold: `>${NET_BLOCK_MULT_MIN}×`,
    });
  }

  {
    const [sales] = lastTwoFinite(input.sales);
    const oi = finite(input.other_income) ? input.other_income : 0;
    let ratio: number | null = null;
    let verdict: FundamentalRuleVerdict = "unknown";
    if (finite(sales) && sales > 0) {
      ratio = oi / sales;
      verdict = ratio < OI_SALES_MAX ? "pass" : "fail";
    }
    rules.push({
      id: "quality",
      label: "Other income / Sales",
      verdict,
      value: fmtPct(ratio),
      threshold: `<${OI_SALES_MAX * 100}%`,
    });
  }

  const passed = rules.filter((r) => r.verdict === "pass").length;
  const evaluated = rules.filter((r) => r.verdict !== "unknown").length;

  return {
    score: passed,
    passed,
    evaluated,
    band: countScoreBand(passed),
    rules,
  };
}
