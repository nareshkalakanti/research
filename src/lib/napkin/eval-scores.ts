/**
 * Compute Fundamental / Management / Valuation scores for Napkin.
 */
import {
  fundamentalScore,
  type FundamentalScoreResult,
} from "@/lib/fundamental-score";
import {
  managementScore,
  type ManagementScoreResult,
} from "@/lib/management-score";
import {
  evaluationFinalRating,
  valuationScore,
  type ValuationScoreResult,
} from "@/lib/valuation-score";
import {
  fetchScreenerAnnualBs,
  fetchScreenerAnnualPl,
  type ScreenerAnnualBs,
  type ScreenerAnnualPl,
} from "@/lib/screener-annual";
import {
  fetchScreenerShareholding,
  type ScreenerShareholding,
} from "@/lib/screener-shareholding";
import { napkinRequiredEpsCagr } from "@/lib/napkin/engine";
import type { NapkinStockJson } from "@/lib/napkin/types";

export type NapkinEvalScores = {
  fundamental: FundamentalScoreResult;
  management: ManagementScoreResult;
  valuation: ValuationScoreResult;
  total: number;
  total_max: number;
  final_rating: "Good" | "Average" | "Weak";
};

function lastFinite(
  vals: Array<number | null> | null | undefined,
): number | null {
  if (!vals?.length) return null;
  for (let i = vals.length - 1; i >= 0; i--) {
    const v = vals[i];
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

/** NBFC / lender-like P&L: heavy interest, no operating-profit line. */
export function looksLikeLender(pl: ScreenerAnnualPl | null): boolean {
  if (!pl) return false;
  const rev = lastFinite(pl.revenue);
  const interest = lastFinite(pl.interest);
  const op = lastFinite(pl.operating_profit);
  if (rev == null || rev <= 0 || interest == null) return false;
  return interest / rev > 0.25 && op == null;
}

export function buildFundamentalFromParts(opts: {
  pl: ScreenerAnnualPl | null;
  bs: ScreenerAnnualBs | null;
  roce: number | null;
}): FundamentalScoreResult {
  const pl = opts.pl;
  const bs = opts.bs;
  const lender = looksLikeLender(pl);
  return fundamentalScore({
    book_value: bs?.book_value?.some((v) => v != null) ? bs.book_value : null,
    equity_capital: bs?.equity_capital?.some((v) => v != null)
      ? bs.equity_capital
      : null,
    sales: pl?.revenue?.length ? pl.revenue : null,
    roce: opts.roce,
    operating_profit: lastFinite(pl?.operating_profit),
    operating_profit_series: pl?.operating_profit?.length
      ? pl.operating_profit
      : null,
    pbt: lastFinite(pl?.pbt),
    interest: lastFinite(pl?.interest),
    interest_series: pl?.interest?.length ? pl.interest : null,
    fixed_assets: lender
      ? null
      : bs?.fixed_assets?.some((v) => v != null)
        ? bs.fixed_assets
        : null,
    other_income: lastFinite(pl?.other_income) ?? 0,
    skip_net_block: lender,
  });
}

export function buildManagementFromShareholding(
  sh: ScreenerShareholding,
): ManagementScoreResult {
  return managementScore({
    shareholder_counts: sh.shareholders,
    pledged_pct: sh.pledged_pct,
    fii_pct: lastFinite(sh.fii),
    dii_pct: lastFinite(sh.dii),
    promoter_pct: sh.promoters,
  });
}

export function buildValuationFromStock(
  row: NapkinStockJson,
  opts?: {
    book_value_ps?: number | null;
    peer_pb_median?: number | null;
    peer_ps_median?: number | null;
  },
): ValuationScoreResult {
  let bookPs = opts?.book_value_ps ?? null;
  // Prefer shares from mcap/price over ROE-implied BV (avoids stale/wrong BVPS).
  if (
    bookPs == null &&
    row.eps != null &&
    row.roe != null &&
    row.roe > 0.01 &&
    row.eps > 0 &&
    !(row.market_cap != null && row.price != null && row.price > 0)
  ) {
    bookPs = row.eps / row.roe;
  }

  const required = napkinRequiredEpsCagr(row.pe);
  const hist = row.cagr.eps_5y ?? row.cagr.eps_3y ?? null;

  return valuationScore({
    price: row.price,
    book_value_ps: bookPs,
    sales: row.revenue,
    market_cap: row.market_cap,
    eps: row.eps,
    peer_pb_median: opts?.peer_pb_median ?? null,
    peer_ps_median: opts?.peer_ps_median ?? null,
    cash: row.cash,
    debt: row.total_debt,
    hist_eps_cagr: hist,
    required_eps_cagr: required,
  });
}

export async function computeNapkinEvalScores(
  row: NapkinStockJson,
): Promise<NapkinEvalScores> {
  const ticker = (row.ticker || "").trim().toUpperCase();
  const [pl, bs, sh] = await Promise.all([
    fetchScreenerAnnualPl(ticker).catch(() => null),
    fetchScreenerAnnualBs(ticker).catch(() => null),
    fetchScreenerShareholding(ticker).catch(() => null),
  ]);

  const emptySh: ScreenerShareholding = {
    dates: [],
    promoters: [],
    fii: [],
    dii: [],
    public: [],
    shareholders: [],
    pledged_pct: null,
  };

  const fundamental = buildFundamentalFromParts({
    pl,
    bs,
    roce: row.roce,
  });
  const management = buildManagementFromShareholding(sh ?? emptySh);

  let bookPs: number | null = null;
  const bookCr = lastFinite(bs?.book_value);
  let shares = row.shares_outstanding;
  if (
    (shares == null || shares <= 0) &&
    row.market_cap != null &&
    row.price != null &&
    row.price > 0
  ) {
    shares = row.market_cap / row.price;
  }
  if (bookCr != null && shares != null && shares > 0) {
    bookPs = (bookCr * 10_000_000) / shares;
  }

  const valuation = buildValuationFromStock(row, { book_value_ps: bookPs });
  const total = fundamental.score + management.score + valuation.score;

  return {
    fundamental,
    management,
    valuation,
    total,
    total_max: 17,
    final_rating: evaluationFinalRating(total),
  };
}
