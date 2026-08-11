/**
 * Fetch price / fundamentals for distress scoring (Yahoo Finance).
 */
import YahooFinance from "yahoo-finance2";
import { toYfinanceSymbol } from "@/lib/yfinance";
import type { DistressMetrics } from "./score";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pctFromDecimal(v: number | null): number | null {
  if (v == null) return null;
  if (Math.abs(v) <= 3) return Math.round(v * 1000) / 10;
  return Math.round(v * 10) / 10;
}

function mcapToCr(mcap: number | null): number | null {
  if (mcap == null) return null;
  return Math.round((mcap / 1e7) * 10) / 10;
}

function drawdown(price: number | null, high: number | null): number | null {
  if (price == null || high == null || high <= 0) return null;
  return Math.round((price / high - 1) * 1000) / 10;
}

function bounce(price: number | null, low: number | null): number | null {
  if (price == null || low == null || low <= 0) return null;
  return Math.round((price / low - 1) * 1000) / 10;
}

export async function fetchDistressMetrics(
  ticker: string,
  market?: string | null,
  opts?: { isSeed?: boolean },
): Promise<DistressMetrics> {
  const sym = toYfinanceSymbol(ticker, market);
  const empty: DistressMetrics = {
    ticker: ticker.toUpperCase(),
    yf_symbol: sym,
    price: null,
    mcap_cr: null,
    pe: null,
    pb: null,
    eps_yoy: null,
    sales_yoy: null,
    returns_pct: null,
    w52_high: null,
    w52_low: null,
    drawdown_pct: null,
    bounce_pct: null,
    surv_type: opts?.isSeed ? "SEED" : "—",
    surv_stage: null,
  };

  if (!sym) return empty;

  const trySyms = [sym];
  if (sym.endsWith(".NS")) trySyms.push(sym.replace(/\.NS$/i, ".BO"));
  if (sym.includes("-SM.NS")) trySyms.push(sym.replace(/-SM\.NS/i, ".NS"));

  let price: number | null = null;
  let mcap: number | null = null;
  let pe: number | null = null;
  let pb: number | null = null;
  let epsYoy: number | null = null;
  let salesYoy: number | null = null;
  let returnsPct: number | null = null;
  let w52High: number | null = null;
  let w52Low: number | null = null;
  let used = sym;

  for (const s of trySyms) {
    try {
      const q = await yf.quote(s);
      if (q) {
        price = price ?? num(q.regularMarketPrice);
        mcap = mcap ?? num(q.marketCap);
        pe =
          pe ??
          num(q.trailingPE) ??
          num((q as { forwardPE?: number }).forwardPE);
        w52High = w52High ?? num(q.fiftyTwoWeekHigh);
        w52Low = w52Low ?? num(q.fiftyTwoWeekLow);
        returnsPct =
          returnsPct ??
          pctFromDecimal(
            num(
              (q as { fiftyTwoWeekChangePercent?: number })
                .fiftyTwoWeekChangePercent,
            ),
          );
      }
    } catch {
      /* next */
    }

    try {
      const qs = await yf.quoteSummary(s, {
        modules: [
          "price",
          "summaryDetail",
          "defaultKeyStatistics",
          "financialData",
        ],
      });
      price =
        price ??
        num(qs.price?.regularMarketPrice) ??
        num(qs.summaryDetail?.regularMarketPrice);
      mcap =
        mcap ?? num(qs.price?.marketCap) ?? num(qs.summaryDetail?.marketCap);
      pe =
        pe ??
        num(qs.summaryDetail?.trailingPE) ??
        num(qs.summaryDetail?.forwardPE) ??
        num(qs.defaultKeyStatistics?.trailingPE);
      pb =
        pb ??
        num(qs.defaultKeyStatistics?.priceToBook) ??
        num(qs.summaryDetail?.priceToBook);
      w52High = w52High ?? num(qs.summaryDetail?.fiftyTwoWeekHigh);
      w52Low = w52Low ?? num(qs.summaryDetail?.fiftyTwoWeekLow);
      epsYoy =
        epsYoy ??
        pctFromDecimal(num(qs.financialData?.earningsGrowth));
      salesYoy =
        salesYoy ??
        pctFromDecimal(num(qs.financialData?.revenueGrowth));
      returnsPct =
        returnsPct ??
        pctFromDecimal(
          num(
            (qs.defaultKeyStatistics as { "52WeekChange"?: number } | undefined)?.[
              "52WeekChange"
            ],
          ),
        );
      if (price != null || mcap != null) used = s;
    } catch {
      /* next */
    }

    if (price != null && mcap != null) break;
  }

  return {
    ticker: ticker.toUpperCase(),
    yf_symbol: used,
    price: price != null ? Math.round(price * 100) / 100 : null,
    mcap_cr: mcapToCr(mcap),
    pe: pe != null ? Math.round(pe * 10) / 10 : null,
    pb: pb != null ? Math.round(pb * 100) / 100 : null,
    eps_yoy: epsYoy,
    sales_yoy: salesYoy,
    returns_pct: returnsPct,
    w52_high: w52High,
    w52_low: w52Low,
    drawdown_pct: drawdown(price, w52High),
    bounce_pct: bounce(price, w52Low),
    surv_type: opts?.isSeed ? "SEED" : "—",
    surv_stage: null,
  };
}

export async function fetchDistressMetricsBatch(
  items: Array<{ ticker: string; market?: string | null; isSeed?: boolean }>,
): Promise<DistressMetrics[]> {
  const out: DistressMetrics[] = [];
  for (const item of items) {
    out.push(
      await fetchDistressMetrics(item.ticker, item.market, {
        isSeed: item.isSeed,
      }),
    );
  }
  return out;
}
