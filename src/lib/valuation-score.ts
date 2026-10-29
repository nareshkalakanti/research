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
      if (pb < 1.5) verdict = "pass";
      else if (pb > 3) verdict = "fail";
      else verdict = "neutral";
    }
    rules.push({
      id: "pb_peer",
      label: "P/B peer valuation",
      verdict,
      points: pointsFrom(verdict),
      value: peer != null ? `${fmtX(pb)} vs peer ${fmtX(peer)}` : fmtX(pb),
      threshold: "below peer / <1.5×",
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
      if (ps < 2) verdict = "pass";
      else if (ps > 5) verdict = "fail";
      else verdict = "neutral";
    }
    rules.push({
      id: "ps_peer",
      label: "P/S peer valuation",
      verdict,
      points: pointsFrom(verdict),
      value: peer != null ? `${fmtX(ps)} vs peer ${fmtX(peer)}` : fmtX(ps),
      threshold: "below peer / <2×",
    });
  }

  // 3) Graham
  {
    const g = grahamNumber(input.eps, input.book_value_ps);
    const price = finite(input.price) ? input.price : null;
    let verdict: ValuationRuleVerdict = "unknown";
    if (finite(g) && finite(price) && g > 0) {
      if (price < g) verdict = "pass";
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
      threshold: "price < Graham №",
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
      else if (gap <= -0.05) verdict = "fail";
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
    let verdict: ValuationRuleVerdict = "unknown";
    let value: string | null = null;
    if (finite(cash)) {
      const net = cash - debt;
      value = `net ${fmtMoney(net)}`;
      if (net > 0 && cash >= debt) verdict = "pass";
      else if (debt > 0 && cash / Math.max(debt, 1e-9) < 0.25) verdict = "fail";
      else verdict = "neutral";
    }
    rules.push({
      id: "cash_rich",
      label: "Cash Rich Rating",
      verdict,
      points: pointsFrom(verdict),
      value,
      threshold: "cash ≥ debt",
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
