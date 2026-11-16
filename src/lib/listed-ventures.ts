import {
  buildStock,
  loadCtx,
  loadCurrent,
  recentQuarter,
  recentlyTried,
  runFill,
  type Ctx,
  type FillResult,
  type NanoStock,
  type Progress,
} from "./nanocap-champs";
import { inactiveListingTickers } from "./listing-sync";
import { fetchScreenerTopRatios } from "./screener-ratios";
import { fetchScreenerQuarterlyFundamentals } from "./screener-quarters";

/**
 * Listed Ventures basket (Lotusdew): growth compounders — ₹500–6,000 Cr,
 * fast sales growth, high ROCE, roughly half-independent boards, valuation not
 * a filter. Current = named list "others"; past = "lvhistorical" minus current.
 */

export const LV_CURRENT_KEY = "others";
export const LV_HISTORY_KEY = "lvhistorical";

export const LV_RULES = {
  minMcapCr: 500,
  maxMcapCr: 6000,
  minSalesYoy: 15,
  minRoce: 0.15,
  maxPe: 60,
  minBoard: 5,
  minIndependentShare: 0.4,
} as const;

export type LvPage = {
  basket: "lv";
  current: NanoStock[];
  past: Array<NanoStock & { sold_at: string }>;
  candidates: NanoStock[];
  coverage: { universe: number; with_data: number; missing: number; to_try: number };
  rules: typeof LV_RULES;
};

function lvUniverse(ctx: Ctx): string[] {
  const inactive = inactiveListingTickers();
  const out: string[] = [];
  for (const [t, co] of ctx.cos) {
    if (co.market !== "NSE" || inactive.has(t)) continue;
    const m = ctx.mcap.get(t);
    if (m == null || m < LV_RULES.minMcapCr || m > LV_RULES.maxMcapCr) continue;
    out.push(t);
  }
  return out;
}

/** Needs ROCE (Screener ratios) and 5+ quarters to be judged. */
function hasData(t: string, ctx: Ctx): boolean {
  return ctx.ratios.get(t)?.roce != null && (ctx.quarters.get(t)?.length ?? 0) >= 5;
}

function fitsLv(s: NanoStock): boolean {
  return (
    s.sales_yoy != null &&
    s.sales_yoy >= LV_RULES.minSalesYoy &&
    s.profit_yoy != null &&
    s.profit_yoy > 0 &&
    s.roce != null &&
    s.roce >= LV_RULES.minRoce &&
    s.pe != null &&
    s.pe >= 3 &&
    s.pe <= LV_RULES.maxPe &&
    s.board >= LV_RULES.minBoard &&
    s.independent < s.board &&
    s.independent / s.board >= LV_RULES.minIndependentShare &&
    recentQuarter(s.latest_quarter)
  );
}

export function buildLvPage(): LvPage {
  const ctx = loadCtx();
  const current = loadCurrent(LV_CURRENT_KEY);
  const currentSet = new Set(current);
  const pastTickers = loadCurrent(LV_HISTORY_KEY).filter((t) => !currentSet.has(t));
  const pastSet = new Set(pastTickers);

  const uni = lvUniverse(ctx);
  const candidates = uni
    .filter((t) => !currentSet.has(t) && !pastSet.has(t))
    .map((t) => buildStock(t, ctx))
    .filter(fitsLv)
    .sort((a, b) => (b.sales_yoy ?? 0) - (a.sales_yoy ?? 0));

  const tried = recentlyTried("lv");
  const withData = uni.filter((t) => hasData(t, ctx)).length;
  return {
    basket: "lv",
    current: current.map((t) => buildStock(t, ctx)),
    past: pastTickers
      .map((t) => ({ ...buildStock(t, ctx), sold_at: "" }))
      .sort((a, b) => (b.mcap_cr ?? 0) - (a.mcap_cr ?? 0)),
    candidates,
    coverage: {
      universe: uni.length,
      with_data: withData,
      missing: uni.length - withData,
      to_try: uni.filter((t) => !hasData(t, ctx) && !tried.has(t)).length,
    },
    rules: LV_RULES,
  };
}

/** Fetch ROCE + quarterly results for LV-band stocks that lack them. */
export function fillLvData(limit = 25, onProgress?: Progress): Promise<FillResult> {
  const ctx = loadCtx();
  const missing = lvUniverse(ctx).filter((t) => !hasData(t, ctx));
  return runFill(
    "lv",
    missing,
    limit,
    async (t) => {
      const r = ctx.ratios.get(t)?.roce == null ? await fetchScreenerTopRatios(t, { force: true }) : null;
      const q =
        (ctx.quarters.get(t)?.length ?? 0) < 5 ? await fetchScreenerQuarterlyFundamentals(t) : null;
      const roceOk = r ? r.roce != null : true;
      const qOk = q ? q.length >= 5 : true;
      return roceOk && qOk;
    },
    onProgress,
  );
}
