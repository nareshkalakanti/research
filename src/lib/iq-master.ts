/**
 * IQMaster — compose investment tracker rows from existing DBs (no invented facts).
 */

import { openSqliteNamed } from "@/lib/sqlite-utils";
import { getMetrics } from "@/lib/metrics";
import { listMarketIqHistory } from "@/lib/marketiq-screen";
import { listBoardRoomHistory } from "@/lib/boardroom-screen";
import { listOrderbookTracker } from "@/lib/orderbook-screen";
import { buildGovernanceBrief } from "@/lib/governance-brief";
import { loadConcallDriftRows } from "@/lib/strategy/concall-drift-store";
import { isEdge } from "@/lib/edge";
import { isHolding } from "@/lib/holdings";
import { fundTagsForTicker } from "@/lib/fund-watchlists";
import { FUND_WATCHLIST_LABELS } from "@/lib/fund-watchlist-meta";

export type IqMasterRow = {
  ticker: string;
  company: string;
  market: string | null;
  price: number | null;
  market_cap_cr: number | null;
  sector: string | null;
  tags: string[];
  marketiq: {
    headline: string;
    sentiment: string;
    impact: number;
    category: string;
    announcement_date: string | null;
  } | null;
  orders: {
    order_count: number;
    total_order_value_cr: number;
    orders_as_pct_of_revenue: number | null;
  } | null;
  board: {
    headline: string;
    category: string;
    announcement_date: string | null;
  } | null;
  governance: {
    signal: string | null;
    reason: string;
  };
  concall: {
    drift_pct: number | null;
    result_quality: string | null;
    mgmt_sentiment: string | null;
    quarter_fy: string | null;
  } | null;
};

function companyName(ticker: string): string {
  try {
    const db = openSqliteNamed("company_about.db", {
      readonly: true,
      wal: true,
    });
    try {
      const row = db
        .prepare(
          `SELECT name FROM company_about WHERE UPPER(ticker) = ? LIMIT 1`,
        )
        .get(ticker) as { name?: string } | undefined;
      const n = row?.name?.trim();
      if (n) return n;
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
  return ticker;
}

function tagsFor(ticker: string): string[] {
  const out: string[] = [];
  try {
    if (isHolding(ticker)) out.push("Hold");
  } catch {
    /* ignore */
  }
  try {
    if (isEdge(ticker)) out.push("Edge");
  } catch {
    /* ignore */
  }
  try {
    for (const t of fundTagsForTicker(ticker)) {
      const label = FUND_WATCHLIST_LABELS[t] || t;
      if (label && !out.includes(label)) out.push(label);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Build IQMaster rows for the given tickers (order preserved). */
export function buildIqMasterRows(tickers: string[]): IqMasterRow[] {
  const wanted = [
    ...new Set(
      tickers
        .map((t) => t.trim().toUpperCase())
        .filter((t) => t && !/^BSE\d{5,6}$/i.test(t)),
    ),
  ].slice(0, 80);

  if (!wanted.length) return [];

  const miqByTicker = new Map<
    string,
    NonNullable<IqMasterRow["marketiq"]>
  >();
  try {
    for (const h of listMarketIqHistory(400)) {
      const t = (h.ticker || "").toUpperCase();
      if (!t || !wanted.includes(t) || miqByTicker.has(t)) continue;
      miqByTicker.set(t, {
        headline: h.headline,
        sentiment: h.sentiment,
        impact: h.impact,
        category: h.category,
        announcement_date: h.announcement_date,
      });
    }
  } catch {
    /* ignore */
  }

  const boardByTicker = new Map<string, NonNullable<IqMasterRow["board"]>>();
  try {
    for (const h of listBoardRoomHistory(400)) {
      const t = (h.ticker || "").toUpperCase();
      if (!t || !wanted.includes(t) || boardByTicker.has(t)) continue;
      boardByTicker.set(t, {
        headline: h.headline || h.proposal || "",
        category: h.category || "Unclassified",
        announcement_date: h.announcement_date,
      });
    }
  } catch {
    /* ignore */
  }

  const orderByTicker = new Map<string, NonNullable<IqMasterRow["orders"]>>();
  try {
    const tracker = listOrderbookTracker({ limit: 500, monthsBack: 12 });
    for (const c of tracker.companies) {
      const t = c.ticker.toUpperCase();
      if (!wanted.includes(t)) continue;
      orderByTicker.set(t, {
        order_count: c.order_count,
        total_order_value_cr: c.total_order_value_cr,
        orders_as_pct_of_revenue: c.orders_as_pct_of_revenue,
      });
    }
  } catch {
    /* ignore */
  }

  const concallByTicker = new Map<
    string,
    NonNullable<IqMasterRow["concall"]>
  >();
  try {
    const drifts = loadConcallDriftRows({ onePerTicker: true, limit: 2000 });
    for (const d of drifts) {
      const t = (d.ticker || "").toUpperCase();
      if (!t || !wanted.includes(t)) continue;
      concallByTicker.set(t, {
        drift_pct: d.drift_pct,
        result_quality: d.result_quality ?? null,
        mgmt_sentiment: d.mgmt_sentiment ?? null,
        quarter_fy: d.quarter_fy ?? null,
      });
    }
  } catch {
    /* ignore */
  }

  return wanted.map((ticker) => {
    const m = getMetrics(ticker);
    let governance: IqMasterRow["governance"] = {
      signal: null,
      reason: "—",
    };
    try {
      const g = buildGovernanceBrief(ticker);
      governance = { signal: g.signal, reason: g.reason };
    } catch {
      /* ignore */
    }
    return {
      ticker,
      company: companyName(ticker),
      market: m?.market ?? null,
      price: m?.price ?? null,
      market_cap_cr: m?.market_cap_cr ?? null,
      sector: m?.sector ?? null,
      tags: tagsFor(ticker),
      marketiq: miqByTicker.get(ticker) ?? null,
      orders: orderByTicker.get(ticker) ?? null,
      board: boardByTicker.get(ticker) ?? null,
      governance,
      concall: concallByTicker.get(ticker) ?? null,
    };
  });
}
