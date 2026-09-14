/**
 * IQMaster — compose investment tracker rows from existing DBs (no invented facts).
 */

import { openSqliteNamed } from "@/lib/sqlite-utils";
import { getMetrics } from "@/lib/metrics";
import { listLatestMarketIqByTickers } from "@/lib/marketiq-screen";
import { listBoardRoomHistory } from "@/lib/boardroom-screen";
import { listLatestConcallPassByTickers } from "@/lib/concall-screen";
import { buildGovernanceBrief } from "@/lib/governance-brief";
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
  about: string | null;
  headquarters: string | null;
  ceo: string | null;
  managing_director: string | null;
  founded_year: string | null;
  tags: string[];
  marketiq: {
    headline: string;
    summary: string;
    sentiment: string;
    impact: number;
    category: string;
    announcement_date: string | null;
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
    period: string | null;
    call_date: string | null;
    result_quality: string | null;
    mgmt_sentiment: string | null;
    revenue_cr: number | null;
    ltp: number | null;
    drift_pct: number | null;
    highlights: Array<{ text: string; polarity: string }>;
  } | null;
};

type CompanyProfile = {
  name: string;
  about: string | null;
  headquarters: string | null;
  ceo: string | null;
  managing_director: string | null;
  founded_year: string | null;
};

function companyProfile(ticker: string): CompanyProfile {
  const empty: CompanyProfile = {
    name: ticker,
    about: null,
    headquarters: null,
    ceo: null,
    managing_director: null,
    founded_year: null,
  };
  try {
    const db = openSqliteNamed("company_about.db", {
      readonly: true,
      wal: true,
    });
    try {
      const row = db
        .prepare(
          `SELECT name, about, headquarters, ceo, managing_director, founded_year
           FROM company_about WHERE UPPER(ticker) = ? LIMIT 1`,
        )
        .get(ticker) as
        | {
            name?: string;
            about?: string | null;
            headquarters?: string | null;
            ceo?: string | null;
            managing_director?: string | null;
            founded_year?: string | null;
          }
        | undefined;
      if (!row) return empty;
      return {
        name: row.name?.trim() || ticker,
        about: row.about?.trim() || null,
        headquarters: row.headquarters?.trim() || null,
        ceo: row.ceo?.trim() || null,
        managing_director: row.managing_director?.trim() || null,
        founded_year: row.founded_year?.trim() || null,
      };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
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
    for (const [t, h] of listLatestMarketIqByTickers(wanted)) {
      miqByTicker.set(t, {
        headline: h.headline,
        summary: h.summary || "",
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

  const concallByTicker = new Map<
    string,
    NonNullable<IqMasterRow["concall"]>
  >();
  try {
    for (const [t, c] of listLatestConcallPassByTickers(wanted)) {
      concallByTicker.set(t, {
        period: c.period,
        call_date: c.call_date,
        result_quality: c.result_quality,
        mgmt_sentiment: c.mgmt_sentiment || c.sentiment,
        revenue_cr: c.revenue_cr,
        ltp: c.ltp,
        drift_pct: c.drift_pct,
        highlights: (c.highlights || []).slice(0, 3).map((h) => ({
          text: h.text,
          polarity: h.polarity,
        })),
      });
    }
  } catch {
    /* ignore */
  }

  return wanted.map((ticker) => {
    const m = getMetrics(ticker);
    const profile = companyProfile(ticker);
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
      company: profile.name,
      market: m?.market ?? null,
      price: m?.price ?? null,
      market_cap_cr: m?.market_cap_cr ?? null,
      sector: m?.sector ?? null,
      about: profile.about,
      headquarters: profile.headquarters,
      ceo: profile.ceo,
      managing_director: profile.managing_director,
      founded_year: profile.founded_year,
      tags: tagsFor(ticker),
      marketiq: miqByTicker.get(ticker) ?? null,
      board: boardByTicker.get(ticker) ?? null,
      governance,
      concall: concallByTicker.get(ticker) ?? null,
    };
  });
}
