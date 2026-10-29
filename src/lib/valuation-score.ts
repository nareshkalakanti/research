/**
 * Valuation Score (signed): each check +1 / 0 / −1. Pure — no I/O.
 *
 * Color bands: ≥3 green · 1–2 yellow · ≤0 red.
 */
import { signedScoreBand, type ScoreBand } from "./fundamental-score";

export type ValuationRuleId =
  | "pb_peer"
  | "ps_peer"
  | "graham"
  | "intrinsic"
  | "cash_rich";

export type ValuationRuleVerdict = "pass" | "neutral" | "fail" | "unknown";

export type ValuationRule = {
  id: ValuationRuleId;
  label: string;
  verdict: ValuationRuleVerdict;
  points: number;
  value: string | null;
  threshold: string;
};

export type ValuationScoreResult = {
  score: number;
  band: ScoreBand;
  rules: ValuationRule[];
};

export type ValuationScoreInput = {
  price?: number | null;
  book_value_ps?: number | null;
  sales?: number | null;
  market_cap?: number | null;
  eps?: number | null;
  /** Peer / sector median P/B (optional). */
  peer_pb_median?: number | null;
  /** Peer / sector median P/S (optional). */
  peer_ps_median?: number | null;
  cash?: number | null;
  debt?: number | null;
  /** Historical EPS CAGR (ratio) vs required — for intrinsic leg. */
  hist_eps_cagr?: number | null;
  required_eps_cagr?: number | null;
};

const PB_PASS_MAX = 2;
const PB_FAIL_MIN = 3;
/** Absolute P/S band when peer median is unavailable. */
const PS_PASS_MAX = 3.5;
const PS_FAIL_MIN = 5;
const INTRINSIC_FAIL_GAP = -0.2;
/**
 * Cash-rich:
 * - pass if cash ≥ debt, or cash is a large share of mcap (liquidity pile)
 * - fail if coverage is thin and net debt is material vs mcap
 * - else neutral (working-capital debt, missing context)
 */
const CASH_MCAP_PASS = 0.5;
const CASH_DEBT_HARD_FAIL = 0.08;
const CASH_DEBT_SOFT_FAIL = 0.25;
/** Soft fail only when net debt is a large share of equity value. */
const NET_DEBT_MCAP_FAIL = 0.75;

function finite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

function fmtX(v: number | null): string | null {
  if (!finite(v)) return null;
  return `${v.toFixed(2)}×`;
}

function fmtMoney(v: number | null): string | null {
  if (!finite(v)) return null;
  return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/** Classic Graham number: √(22.5 × EPS × BVPS). */
export function grahamNumber(
  eps: number | null | undefined,
  bvps: number | null | undefined,
): number | null {
  if (!finite(eps) || !finite(bvps) || eps <= 0 || bvps <= 0) return null;
  return Math.sqrt(22.5 * eps * bvps);
}

function pointsFrom(
  verdict: ValuationRuleVerdict,
): number {
  if (verdict === "pass") return 1;
  if (verdict === "fail") return -1;
  return 0;
}

export function valuationScore(
  input: ValuationScoreInput,
): ValuationScoreResult {
  const rules: ValuationRule[] = [];

  const pb =
    finite(input.price) && finite(input.book_value_ps) && input.book_value_ps > 0
      ? input.price / input.book_value_ps
      : null;
  const ps =
    finite(input.market_cap) && finite(input.sales) && input.sales > 0
      ? input.market_cap / input.sales
      : null;

  // 1) P/B peer
  {
    let verdict: ValuationRuleVerdict = "unknown";
    const peer = finite(input.peer_pb_median) ? input.peer_pb_median : null;
    if (finite(pb) && finite(peer) && peer > 0) {
      if (pb < peer * 0.9) verdict = "pass";
      else if (pb > peer * 1.15) verdict = "fail";
      else verdict = "neutral";
    } else if (finite(pb)) {
      if (pb < PB_PASS_MAX) verdict = "pass";
      else if (pb > PB_FAIL_MIN) verdict = "fail";
      else verdict = "neutral";
    }
    rules.push({
      id: "pb_peer",
      label: "P/B peer valuation",
      verdict,
      points: pointsFrom(verdict),
      value: peer != null ? `${fmtX(pb)} vs peer ${fmtX(peer)}` : fmtX(pb),
      threshold: `below peer / <${PB_PASS_MAX}×`,
    });
  }

  // 2) P/S peer
  {
    let verdict: ValuationRuleVerdict = "unknown";
    const peer = finite(input.peer_ps_median) ? input.peer_ps_median : null;
    if (finite(ps) && finite(peer) && peer > 0) {
      if (ps < peer * 0.9) verdict = "pass";
      else if (ps > peer * 1.15) verdict = "fail";
      else verdict = "neutral";
    } else if (finite(ps)) {
      if (ps < PS_PASS_MAX) verdict = "pass";
      else if (ps > PS_FAIL_MIN) verdict = "fail";
      else verdict = "neutral";
    }
    rules.push({
      id: "ps_peer",
      label: "P/S peer valuation",
      verdict,
      points: pointsFrom(verdict),
      value: peer != null ? `${fmtX(ps)} vs peer ${fmtX(peer)}` : fmtX(ps),
      threshold: `below peer / <${PS_PASS_MAX}×`,
    });
  }

  // 3) Graham — require a margin of safety vs the classic number
  {
    const g = grahamNumber(input.eps, input.book_value_ps);
    const price = finite(input.price) ? input.price : null;
    let verdict: ValuationRuleVerdict = "unknown";
    if (finite(g) && finite(price) && g > 0) {
      if (price < g * 0.9) verdict = "pass";
      else if (price > g * 1.5) verdict = "fail";
      else verdict = "neutral";
    }
    rules.push({
      id: "graham",
      label: "Graham analysis",
      verdict,
      points: pointsFrom(verdict),
      value:
        finite(g) && finite(price)
          ? `price ${fmtMoney(price)} vs GN ${fmtMoney(g)}`
          : null,
      threshold: "price < 0.9× Graham №",
    });
  }

  // 4) Intrinsic (hist EPS CAGR vs required)
  {
    const hist = finite(input.hist_eps_cagr) ? input.hist_eps_cagr : null;
    const req = finite(input.required_eps_cagr) ? input.required_eps_cagr : null;
    let verdict: ValuationRuleVerdict = "unknown";
    let value: string | null = null;
    if (finite(hist) && finite(req)) {
      const gap = hist - req;
      value = `gap ${(gap * 100).toFixed(1)} pp`;
      if (gap >= 0.02) verdict = "pass";
      else if (gap <= INTRINSIC_FAIL_GAP) verdict = "fail";
      else verdict = "neutral";
    }
    rules.push({
      id: "intrinsic",
      label: "Intrinsic value analysis",
      verdict,
      points: pointsFrom(verdict),
      value,
      threshold: "hist CAGR ≥ required",
    });
  }

  // 5) Cash rich
  {
    const cash = finite(input.cash) ? input.cash : null;
    const debt = finite(input.debt) ? input.debt : 0;
    const mcap = finite(input.market_cap) ? input.market_cap : null;
    let verdict: ValuationRuleVerdict = "unknown";
    let value: string | null = null;
    if (finite(cash)) {
      const net = cash - debt;
      const cover = debt > 0 ? cash / debt : Infinity;
      const cashMcap =
        finite(mcap) && mcap > 0 ? cash / mcap : null;
      const netDebtMcap =
        finite(mcap) && mcap > 0 ? (debt - cash) / mcap : null;
      value = `net ${fmtMoney(net)}`;
      if (cash >= debt || (finite(cashMcap) && cashMcap >= CASH_MCAP_PASS)) {
        verdict = "pass";
      } else if (debt > 0 && cover < CASH_DEBT_HARD_FAIL) {
        // Tiny cash vs debt — but ignore when net debt is small vs mcap.
        verdict =
          finite(netDebtMcap) && netDebtMcap <= 0.15 ? "neutral" : "fail";
      } else if (
        debt > 0 &&
        cover < CASH_DEBT_SOFT_FAIL &&
        finite(netDebtMcap) &&
        netDebtMcap > NET_DEBT_MCAP_FAIL
      ) {
        verdict = "fail";
      } else {
        verdict = "neutral";
      }
    }
    rules.push({
      id: "cash_rich",
      label: "Cash Rich Rating",
      verdict,
      points: pointsFrom(verdict),
      value,
      threshold: "cash ≥ debt or cash ≥ 50% mcap",
    });
  }

  const score = rules.reduce((s, r) => s + r.points, 0);
  return {
    score,
    band: signedScoreBand(score),
    rules,
  };
}

/** Final rating from total (Fund+Mgmt+Val), matching eval-table style. */
export function evaluationFinalRating(
  total: number,
): "Good" | "Average" | "Weak" {
  if (total >= 9) return "Good";
  if (total >= 5) return "Average";
  return "Weak";
}
