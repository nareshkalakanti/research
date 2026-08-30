import { openSqliteNamed } from "../sqlite-utils";
import type { BuybackEvent, BuybackSummary, LiquidityScore } from "./types";
import {
  computeSpreadPct,
  isBuyableBuyback,
  pickSummaryMethod,
  scoreBuybackSummary,
} from "./buyback-parse";
import { loadAllCompanies } from "../db";
import { researchLinks } from "../links";
import { capTier, type CapTier } from "../types";
import {
  passesStrategyTags,
  type StrategyTagFilters,
} from "./strategy-tags";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function ensureSchema(): void {
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS buyback_events (
        id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        announced_at TEXT,
        ex_date TEXT,
        max_price REAL,
        pct_equity REAL,
        size_shares REAL,
        status TEXT NOT NULL,
        subject TEXT,
        description TEXT,
        source TEXT NOT NULL,
        seq_id TEXT,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_buyback_events_ticker ON buyback_events(ticker);

      CREATE TABLE IF NOT EXISTS buyback_summary (
        ticker TEXT PRIMARY KEY,
        event_count INTEGER NOT NULL,
        latest_date TEXT,
        latest_status TEXT,
        max_price REAL,
        pct_equity REAL,
        buyback_score REAL NOT NULL,
        flags TEXT NOT NULL,
        reason TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        detail_fetched_at TEXT
      );

      CREATE TABLE IF NOT EXISTS liquidity_scores (
        ticker TEXT PRIMARY KEY,
        avg_value_20d_lakh REAL,
        avg_value_60d_lakh REAL,
        avg_value_120d_lakh REAL,
        ramp_ratio REAL,
        is_low_liquidity INTEGER NOT NULL,
        is_ramping INTEGER NOT NULL,
        liquidity_score REAL NOT NULL,
        flags TEXT NOT NULL,
        reason TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS strategy_scan_log (
        ticker TEXT NOT NULL,
        scan_type TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (ticker, scan_type)
      );
    `);
    const cols = db
      .prepare(`PRAGMA table_info(buyback_summary)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "detail_fetched_at")) {
      db.exec(`ALTER TABLE buyback_summary ADD COLUMN detail_fetched_at TEXT`);
    }
  } finally {
    db.close();
  }
}

export function upsertBuybackEvents(events: BuybackEvent[]): number {
  if (!events.length) return 0;
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  const now = new Date().toISOString();
  try {
    const stmt = db.prepare(`
      INSERT INTO buyback_events (
        id, ticker, announced_at, ex_date, max_price, pct_equity, size_shares,
        status, subject, description, source, seq_id, fetched_at
      ) VALUES (
        @id, @ticker, @announced_at, @ex_date, @max_price, @pct_equity, @size_shares,
        @status, @subject, @description, @source, @seq_id, @fetched_at
      )
      ON CONFLICT(id) DO UPDATE SET
        announced_at = excluded.announced_at,
        ex_date = excluded.ex_date,
        max_price = COALESCE(excluded.max_price, buyback_events.max_price),
        pct_equity = COALESCE(excluded.pct_equity, buyback_events.pct_equity),
        size_shares = COALESCE(excluded.size_shares, buyback_events.size_shares),
        status = excluded.status,
        subject = excluded.subject,
        description = excluded.description,
        fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction((batch: BuybackEvent[]) => {
      for (const e of batch) {
        stmt.run({ ...e, fetched_at: now });
      }
    });
    tx(events);
    return events.length;
  } finally {
    db.close();
  }
}

export type StrategyRowLinks = {
  sc: string;
  tv: string;
  web: string | null;
};

function passesCapFilter(
  mcap: number | null | undefined,
  cap?: CapTier | "All",
): boolean {
  if (!cap || cap === "All") return true;
  if (cap === "NC") return mcap == null || Number.isNaN(mcap);
  return capTier(mcap) === cap;
}

export function strategyCapCounts(
  rows: Array<{ market_cap_cr: number | null }>,
): Record<CapTier, number> {
  const counts: Record<CapTier, number> = {
    NC: 0,
    TI: 0,
    MIC: 0,
    SC: 0,
    MC: 0,
    LC: 0,
  };
  for (const row of rows) {
    counts[capTier(row.market_cap_cr)] += 1;
  }
  return counts;
}

function companyMeta(ticker: string) {
  const c = loadAllCompanies().find(
    (row) => row.ticker.toUpperCase() === ticker.toUpperCase(),
  );
  const links = researchLinks(
    c?.ticker ?? ticker,
    c?.market,
    c?.website ?? null,
  );
  return {
    name: c?.name || ticker,
    market: c?.market || "NSE",
    market_cap_cr: c?.mcap_cr ?? null,
    price: c?.price ?? null,
    sc: links.sc,
    tv: links.tv,
    web: links.web,
  };
}

export function recomputeBuybackSummary(
  ticker: string,
  opts?: { detailFetched?: boolean },
): void {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  const key = ticker.toUpperCase();
  try {
    const events = db
      .prepare(
        `SELECT id, ticker, announced_at, ex_date, max_price, pct_equity, size_shares,
                status, subject, description, source, seq_id
         FROM buyback_events WHERE ticker = ? ORDER BY announced_at DESC`,
      )
      .all(key) as BuybackEvent[];

    if (!events.length) {
      db.prepare(`DELETE FROM buyback_summary WHERE ticker = ?`).run(key);
      return;
    }

    const meta = companyMeta(key);
    const scored = scoreBuybackSummary({
      events,
      market_cap_cr: meta.market_cap_cr,
    });
    const latest = events[0]!;
    const maxPrice = events
      .filter((e) => e.max_price != null)
      .sort((a, b) => {
        const annA = a.source === "nse_announcement" ? 1 : 0;
        const annB = b.source === "nse_announcement" ? 1 : 0;
        if (annB !== annA) return annB - annA;
        return (b.max_price ?? 0) - (a.max_price ?? 0);
      })[0]?.max_price ?? null;
    const pctEquity = events
      .map((e) => e.pct_equity)
      .filter((n): n is number => n != null)
      .sort((a, b) => b - a)[0] ?? null;

    const existing = db
      .prepare(`SELECT detail_fetched_at FROM buyback_summary WHERE ticker = ?`)
      .get(key) as { detail_fetched_at?: string | null } | undefined;
    const detailAt =
      opts?.detailFetched === true
        ? new Date().toISOString()
        : existing?.detail_fetched_at ?? null;

    db.prepare(
      `INSERT INTO buyback_summary (
         ticker, event_count, latest_date, latest_status, max_price, pct_equity,
         buyback_score, flags, reason, fetched_at, detail_fetched_at
       ) VALUES (
         @ticker, @event_count, @latest_date, @latest_status, @max_price, @pct_equity,
         @buyback_score, @flags, @reason, @fetched_at, @detail_fetched_at
       )
       ON CONFLICT(ticker) DO UPDATE SET
         event_count = excluded.event_count,
         latest_date = excluded.latest_date,
         latest_status = excluded.latest_status,
         max_price = excluded.max_price,
         pct_equity = excluded.pct_equity,
         buyback_score = excluded.buyback_score,
         flags = excluded.flags,
         reason = excluded.reason,
         fetched_at = excluded.fetched_at,
         detail_fetched_at = COALESCE(excluded.detail_fetched_at, buyback_summary.detail_fetched_at)`,
    ).run({
      ticker: key,
      event_count: events.length,
      latest_date: latest.announced_at || latest.ex_date,
      latest_status: latest.status,
      max_price: maxPrice,
      pct_equity: pctEquity,
      buyback_score: scored.score,
      flags: scored.flags.join(","),
      reason: scored.reason,
      fetched_at: new Date().toISOString(),
      detail_fetched_at: detailAt,
    });
  } finally {
    db.close();
  }
}

export function recomputeAllBuybackSummaries(): number {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const rows = db
      .prepare(`SELECT ticker FROM buyback_summary`)
      .all() as Array<{ ticker: string }>;
    for (const row of rows) {
      recomputeBuybackSummary(row.ticker);
    }
    return rows.length;
  } finally {
    db.close();
  }
}

export function upsertLiquidityScore(row: LiquidityScore): void {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO liquidity_scores (
         ticker, avg_value_20d_lakh, avg_value_60d_lakh, avg_value_120d_lakh,
         ramp_ratio, is_low_liquidity, is_ramping, liquidity_score, flags, reason, fetched_at
       ) VALUES (
         @ticker, @avg_value_20d_lakh, @avg_value_60d_lakh, @avg_value_120d_lakh,
         @ramp_ratio, @is_low_liquidity, @is_ramping, @liquidity_score, @flags, @reason, @fetched_at
       )
       ON CONFLICT(ticker) DO UPDATE SET
         avg_value_20d_lakh = excluded.avg_value_20d_lakh,
         avg_value_60d_lakh = excluded.avg_value_60d_lakh,
         avg_value_120d_lakh = excluded.avg_value_120d_lakh,
         ramp_ratio = excluded.ramp_ratio,
         is_low_liquidity = excluded.is_low_liquidity,
         is_ramping = excluded.is_ramping,
         liquidity_score = excluded.liquidity_score,
         flags = excluded.flags,
         reason = excluded.reason,
         fetched_at = excluded.fetched_at`,
    ).run({
      ticker: row.ticker.toUpperCase(),
      avg_value_20d_lakh: row.avg_value_20d_lakh,
      avg_value_60d_lakh: row.avg_value_60d_lakh,
      avg_value_120d_lakh: row.avg_value_120d_lakh,
      ramp_ratio: row.ramp_ratio,
      is_low_liquidity: row.is_low_liquidity ? 1 : 0,
      is_ramping: row.is_ramping ? 1 : 0,
      liquidity_score: row.liquidity_score,
      flags: row.flags.join(","),
      reason: row.reason,
      fetched_at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}

export function recordStrategyScan(
  ticker: string,
  scanType: "buyback" | "liquidity",
  status: "ok" | "empty" | "failed",
  detail?: string,
): void {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `INSERT INTO strategy_scan_log (ticker, scan_type, status, detail, fetched_at)
       VALUES (@ticker, @scan_type, @status, @detail, @fetched_at)
       ON CONFLICT(ticker, scan_type) DO UPDATE SET
         status = excluded.status,
         detail = excluded.detail,
         fetched_at = excluded.fetched_at`,
    ).run({
      ticker: ticker.toUpperCase(),
      scan_type: scanType,
      status,
      detail: detail || null,
      fetched_at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}

function isFresh(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && Date.now() - ts < TTL_MS;
}

export type BuybackLoadOpts = {
  market?: string;
  cap?: CapTier | "All";
  minScore?: number;
  limit?: number;
  tags?: StrategyTagFilters;
  openOnly?: boolean;
  tenderOnly?: boolean;
  buyableOnly?: boolean;
  minSpreadPct?: number;
};

export function enrichBuybackRow(
  row: {
    ticker: string;
    event_count: number;
    latest_date: string | null;
    latest_status: string | null;
    max_price: number | null;
    pct_equity: number | null;
    buyback_score: number;
    flags: string;
    reason: string;
  },
  events: BuybackEvent[],
  meta: ReturnType<typeof companyMeta>,
): BuybackSummary {
  const flags = row.flags ? row.flags.split(",").filter(Boolean) : [];
  const method = pickSummaryMethod(events);
  const spread_pct = computeSpreadPct(row.max_price, meta.price);
  const has_history =
    flags.includes("past_buyback") ||
    flags.includes("active_buyback") ||
    flags.includes("buyback_announced") ||
    row.event_count > 0;

  return {
    ticker: row.ticker,
    name: meta.name,
    market: meta.market,
    market_cap_cr: meta.market_cap_cr,
    price: meta.price,
    event_count: row.event_count,
    latest_date: row.latest_date,
    latest_status: (row.latest_status as BuybackSummary["latest_status"]) || null,
    buyback_method: method,
    max_price: row.max_price,
    pct_equity: row.pct_equity,
    spread_pct,
    buyback_score: row.buyback_score,
    flags,
    reason: row.reason,
    has_history,
    events,
    sc: meta.sc,
    tv: meta.tv,
    web: meta.web,
  };
}

export function passesBuybackFilters(
  summary: BuybackSummary,
  opts?: BuybackLoadOpts,
): boolean {
  if (opts?.openOnly && summary.latest_status !== "open") return false;
  if (opts?.tenderOnly && summary.buyback_method !== "tender") return false;
  if (opts?.buyableOnly && !isBuyableBuyback(summary)) return false;
  if (
    opts?.minSpreadPct != null &&
    (summary.spread_pct == null || summary.spread_pct < opts.minSpreadPct)
  ) {
    return false;
  }
  return true;
}

export function buybackFilterCounts(rows: BuybackSummary[]): {
  history: number;
  open: number;
  tender: number;
  spread8: number;
  buy: number;
} {
  return {
    history: rows.length,
    open: rows.filter((r) => r.latest_status === "open").length,
    tender: rows.filter((r) => r.buyback_method === "tender").length,
    spread8: rows.filter((r) => r.spread_pct != null && r.spread_pct >= 8).length,
    buy: rows.filter((r) => isBuyableBuyback(r)).length,
  };
}

export function loadBuybackSummaries(opts?: BuybackLoadOpts): BuybackSummary[] {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const minScore = opts?.minScore;
    const sql =
      minScore != null
        ? `SELECT * FROM buyback_summary WHERE buyback_score >= ? ORDER BY latest_date DESC, buyback_score DESC`
        : `SELECT * FROM buyback_summary ORDER BY latest_date DESC, buyback_score DESC`;
    const rows = (
      minScore != null ? db.prepare(sql).all(minScore) : db.prepare(sql).all()
    ) as Array<{
      ticker: string;
      event_count: number;
      latest_date: string | null;
      latest_status: string | null;
      max_price: number | null;
      pct_equity: number | null;
      buyback_score: number;
      flags: string;
      reason: string;
    }>;

    const out: BuybackSummary[] = [];
    for (const row of rows) {
      const meta = companyMeta(row.ticker);
      if (opts?.market && opts.market !== "All") {
        if (opts.market === "NSE") {
          if (meta.market !== "NSE" && meta.market !== "NSE SME") continue;
        } else if (meta.market !== opts.market) continue;
      }
      if (!passesCapFilter(meta.market_cap_cr, opts?.cap)) continue;
      if (!passesStrategyTags(row.ticker, meta.market, opts?.tags)) continue;
      const events = db
        .prepare(
          `SELECT id, ticker, announced_at, ex_date, max_price, pct_equity, size_shares,
                  status, subject, description, source, seq_id
           FROM buyback_events WHERE ticker = ? ORDER BY announced_at DESC LIMIT 12`,
        )
        .all(row.ticker) as BuybackEvent[];

      const summary = enrichBuybackRow(row, events, meta);
      if (!passesBuybackFilters(summary, opts)) continue;

      out.push(summary);
      if (opts?.limit && out.length >= opts.limit) break;
    }
    return out;
  } finally {
    db.close();
  }
}

export function loadLiquidityScores(opts?: {
  market?: string;
  cap?: CapTier | "All";
  minScore?: number;
  onlyMatches?: boolean;
  limit?: number;
  tags?: StrategyTagFilters;
}): LiquidityScore[] {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const minScore = opts?.minScore ?? 0;
    let sql = `SELECT * FROM liquidity_scores WHERE liquidity_score >= ?`;
    if (opts?.onlyMatches) {
      sql += ` AND is_low_liquidity = 1 AND is_ramping = 1`;
    }
    sql += ` ORDER BY liquidity_score DESC, ramp_ratio DESC`;

    const rows = db.prepare(sql).all(minScore) as Array<{
      ticker: string;
      avg_value_20d_lakh: number | null;
      avg_value_60d_lakh: number | null;
      avg_value_120d_lakh: number | null;
      ramp_ratio: number | null;
      is_low_liquidity: number;
      is_ramping: number;
      liquidity_score: number;
      flags: string;
      reason: string;
    }>;

    const out: LiquidityScore[] = [];
    for (const row of rows) {
      const meta = companyMeta(row.ticker);
      if (opts?.market && opts.market !== "All") {
        if (opts.market === "NSE") {
          if (meta.market !== "NSE" && meta.market !== "NSE SME") continue;
        } else if (meta.market !== opts.market) continue;
      }
      if (!passesCapFilter(meta.market_cap_cr, opts?.cap)) continue;
      if (!passesStrategyTags(row.ticker, meta.market, opts?.tags)) continue;
      const c = loadAllCompanies().find(
        (x) => x.ticker.toUpperCase() === row.ticker.toUpperCase(),
      );
      out.push({
        ticker: row.ticker,
        name: meta.name,
        market: meta.market,
        market_cap_cr: meta.market_cap_cr,
        price: c?.price ?? null,
        sc: meta.sc,
        tv: meta.tv,
        web: meta.web,
        avg_value_20d_lakh: row.avg_value_20d_lakh,
        avg_value_60d_lakh: row.avg_value_60d_lakh,
        avg_value_120d_lakh: row.avg_value_120d_lakh,
        ramp_ratio: row.ramp_ratio,
        is_low_liquidity: row.is_low_liquidity === 1,
        is_ramping: row.is_ramping === 1,
        liquidity_score: row.liquidity_score,
        flags: row.flags ? row.flags.split(",").filter(Boolean) : [],
        reason: row.reason,
      });
      if (opts?.limit && out.length >= opts.limit) break;
    }
    return out;
  } finally {
    db.close();
  }
}

export function pendingBuybackDetailTickers(opts?: {
  market?: string;
}): string[] {
  ensureSchema();
  const companies = loadAllCompanies().filter((c) =>
    ["NSE", "NSE SME"].includes(c.market),
  );
  let allowed = new Set(companies.map((c) => c.ticker.toUpperCase()));
  if (opts?.market && opts.market !== "All") {
    allowed = new Set(
      companies
        .filter((c) =>
          opts.market === "NSE"
            ? c.market === "NSE" || c.market === "NSE SME"
            : c.market === opts.market,
        )
        .map((c) => c.ticker.toUpperCase()),
    );
  }

  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT e.ticker AS ticker
         FROM buyback_events e
         LEFT JOIN buyback_summary s ON s.ticker = e.ticker
         WHERE s.detail_fetched_at IS NULL`,
      )
      .all() as Array<{ ticker: string }>;
    return rows
      .map((r) => r.ticker.toUpperCase())
      .filter((t) => allowed.has(t))
      .sort();
  } finally {
    db.close();
  }
}

export function pendingBuybackTickers(opts?: {
  market?: string;
  missingOnly?: boolean;
}): string[] {
  if (opts?.missingOnly !== false) {
    return pendingBuybackDetailTickers({ market: opts?.market });
  }
  ensureSchema();
  const companies = loadAllCompanies().filter((c) =>
    ["NSE", "NSE SME"].includes(c.market),
  );
  let filtered = companies;
  if (opts?.market && opts.market !== "All") {
    filtered = companies.filter((c) => c.market === opts.market);
  }

  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    return filtered.map((c) => c.ticker.toUpperCase()).sort();
  } finally {
    db.close();
  }
}

export function pendingLiquidityTickers(opts?: {
  market?: string;
  missingOnly?: boolean;
}): string[] {
  ensureSchema();
  const missingOnly = opts?.missingOnly !== false;
  const companies = loadAllCompanies();
  let filtered = companies;
  if (opts?.market && opts.market !== "All") {
    if (opts.market === "NSE") {
      filtered = companies.filter(
        (c) => c.market === "NSE" || c.market === "NSE SME",
      );
    } else {
      filtered = companies.filter((c) => c.market === opts.market);
    }
  }

  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const done = new Set<string>();
    if (missingOnly) {
      const scored = db
        .prepare(`SELECT ticker, fetched_at FROM liquidity_scores`)
        .all() as Array<{ ticker: string; fetched_at: string }>;
      for (const row of scored) {
        if (isFresh(row.fetched_at)) done.add(row.ticker.toUpperCase());
      }
      const logged = db
        .prepare(
          `SELECT ticker, fetched_at FROM strategy_scan_log WHERE scan_type = 'liquidity'`,
        )
        .all() as Array<{ ticker: string; fetched_at: string }>;
      for (const row of logged) {
        if (isFresh(row.fetched_at)) done.add(row.ticker.toUpperCase());
      }
    }
    return filtered
      .map((c) => c.ticker.toUpperCase())
      .filter((t) => !done.has(t))
      .sort();
  } finally {
    db.close();
  }
}

export function buybackStats(): { tickers: number; events: number } {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const tickers = (
      db.prepare(`SELECT COUNT(*) AS n FROM buyback_summary`).get() as { n: number }
    ).n;
    const events = (
      db.prepare(`SELECT COUNT(*) AS n FROM buyback_events`).get() as { n: number }
    ).n;
    return { tickers, events };
  } finally {
    db.close();
  }
}

export function liquidityStats(): { tickers: number; matches: number } {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const tickers = (
      db.prepare(`SELECT COUNT(*) AS n FROM liquidity_scores`).get() as { n: number }
    ).n;
    const matches = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM liquidity_scores WHERE is_low_liquidity = 1 AND is_ramping = 1`,
        )
        .get() as { n: number }
    ).n;
    return { tickers, matches };
  } finally {
    db.close();
  }
}

export function buybackTickersWithEvents(): Set<string> {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const rows = db
      .prepare(`SELECT DISTINCT ticker FROM buyback_events`)
      .all() as Array<{ ticker: string }>;
    return new Set(rows.map((r) => r.ticker.toUpperCase()));
  } finally {
    db.close();
  }
}
