/**
 * PEAD 2 table universe — same metrics as stocks-ai PEAD 2, from local caches.
 */
import { loadAllCompanies } from "./db";
import { loadQuarterOverlayMap } from "./fundamentals-scan";
import { mcapCapCode } from "./gov-score";
import {
  peadScoreFf,
  usableForwardPe,
} from "./pead-score";
import {
  isCalendarQuarterEnd,
  latestAnnounceOnOrBefore,
  loadPeadAnnounceDatesMap,
  sliceToAnnouncedQuarters,
} from "./pead-announced";
import { loadMetricsMap } from "./metrics";
import { loadQuarterMetricsMap } from "./quarter-metrics-cache";
import { loadBreakoutMap } from "./signals";
import { loadPeadReturnsMap } from "./pead-returns-cache";
import { loadPeadWebMetricsMap } from "./pead-web-metrics";
import { computeForwardPe, computeTrailingPe, epsFromQuarterPanel } from "./valuation";
import {
  buildQuarterPanel,
  extraMetricsFromPanel,
  mergeQuarterFill,
  yoyFromPanel,
} from "./quarter-panel";
import type { Pead2Row } from "./pead2-types";

export type { Pead2Row } from "./pead2-types";

function finite(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v;
}

function firstFinite(
  ...vals: Array<number | null | undefined>
): number | null {
  for (const v of vals) {
    const n = finite(v);
    if (n != null) return n;
  }
  return null;
}

function usableResultDate(raw: string | null | undefined): string | null {
  const d = (raw || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  if (isCalendarQuarterEnd(d)) return null;
  return d;
}

export function loadPead2Rows(): Pead2Row[] {
  const companies = loadAllCompanies();
  const overlay = loadQuarterOverlayMap();
  const metricsQ = loadQuarterMetricsMap();
  const prices = loadMetricsMap();
  const breakouts = loadBreakoutMap();
  const returnsMap = loadPeadReturnsMap();
  const webMap = loadPeadWebMetricsMap();
  const announceMap = loadPeadAnnounceDatesMap();
  const out: Pead2Row[] = [];

  for (const c of companies) {
    const ticker = c.ticker.toUpperCase();
    const o = overlay.get(ticker);
    const q = metricsQ.get(ticker);
    const p = prices.get(ticker);
    const web = webMap.get(ticker);
    const announces = announceMap.get(ticker) ?? [];
    const mergedQuarters = mergeQuarterFill(
      o?.quarters ?? [],
      web?.quarters ?? [],
    );
    const sliced =
      mergedQuarters.length
        ? sliceToAnnouncedQuarters(mergedQuarters, announces)
        : [];
    const panel = sliced.length ? buildQuarterPanel(sliced) : null;
    const yoy = panel ? yoyFromPanel(panel) : null;
    const extras = panel ? extraMetricsFromPanel(panel) : null;

    const sales_yoy = firstFinite(yoy?.sales_yoy, o?.sales_yoy, q?.sales_yoy);
    const sales_qoq = firstFinite(extras?.sales_qoq, o?.sales_qoq, q?.sales_qoq);
    const np_yoy = firstFinite(yoy?.np_yoy, o?.np_yoy, q?.np_yoy);
    const np_qoq = firstFinite(extras?.np_qoq, o?.np_qoq, q?.np_qoq);
    const ebidt_yoy = firstFinite(
      yoy?.ebidt_yoy,
      extras?.ebidt_yoy,
      o?.ebidt_yoy,
      q?.ebidt_yoy,
    );
    const ebidt_qoq = firstFinite(extras?.ebidt_qoq, o?.ebidt_qoq, q?.ebidt_qoq);
    const cf_profit = firstFinite(extras?.cf_profit, q?.cf_profit);
    const price = c.price ?? p?.price ?? null;
    const epsValues = panel
      ? epsFromQuarterPanel(panel)
      : o?.eps_values ?? [];
    const pe_ratio = firstFinite(
      computeTrailingPe(price, epsValues),
      web?.pe_ratio,
    );
    const computedFpe = price ? computeForwardPe(price, epsValues) : null;
    const cachedFpe = finite(q?.forward_pe);
    const rawFpe = firstFinite(
      computedFpe != null && computedFpe !== 999 ? computedFpe : null,
      cachedFpe != null && cachedFpe !== 999 ? cachedFpe : null,
      computedFpe,
      cachedFpe,
    );

    const result_date =
      latestAnnounceOnOrBefore(announces) ||
      usableResultDate(q?.result_date);

    const forward_pe = usableForwardPe(rawFpe);

    const pead_score = peadScoreFf(
      sales_yoy,
      sales_qoq,
      np_yoy,
      np_qoq,
      ebidt_yoy,
      ebidt_qoq,
      forward_pe,
    );
    if (pead_score == null) continue;

    const cached = returnsMap.get(ticker);
    out.push({
      ticker,
      name: c.name,
      market: c.market,
      sector: c.sector,
      mcap_cr: c.mcap_cr ?? p?.market_cap_cr ?? null,
      price,
      cap_code: mcapCapCode(c.mcap_cr ?? p?.market_cap_cr ?? null),
      web: c.web,
      sc: c.sc,
      tv: c.tv,
      pead_score,
      result_date,
      pe_ratio,
      forward_pe,
      returns_pct: cached?.returns_pct ?? null,
      daily_ret_pct: cached?.daily_ret_pct ?? null,
      sales_yoy,
      sales_qoq,
      np_yoy,
      np_qoq,
      ebidt_yoy,
      ebidt_qoq,
      cf_profit,
      has_tq: Boolean(breakouts.get(ticker)?.has_tq),
      has_bb: Boolean(breakouts.get(ticker)?.has_bb),
    });
  }

  return out.sort((a, b) => {
    const ad = a.result_date || "";
    const bd = b.result_date || "";
    if (ad !== bd) return bd.localeCompare(ad);
    const as = a.pead_score;
    const bs = b.pead_score;
    if (as == null && bs == null) return a.ticker.localeCompare(b.ticker);
    if (as == null) return 1;
    if (bs == null) return -1;
    if (bs !== as) return bs - as;
    return a.ticker.localeCompare(b.ticker);
  });
}
