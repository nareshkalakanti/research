/**
 * Mock / paper trades — track "what if I bought ₹X" for agent picks.
 * Analysis only; no real orders.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import YahooFinance from "yahoo-finance2";
import { loadAllCompanies } from "@/lib/db";
import { toYfinanceSymbol } from "@/lib/yfinance";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "agents.db");

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export type PaperTrade = {
  id: number;
  symbol: string;
  name: string;
  market: string;
  amount_inr: number;
  entry_price: number;
  qty: number;
  confidence: number | null;
  source: string | null;
  opened_at: string;
  closed_at: string | null;
  close_price: number | null;
  status: "open" | "closed";
};

export type PaperPosition = PaperTrade & {
  live_price: number | null;
  day_change_pct: number | null;
  market_value: number | null;
  pnl_inr: number | null;
  pnl_pct: number | null;
};

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'NSE',
      amount_inr REAL NOT NULL,
      entry_price REAL NOT NULL,
      qty REAL NOT NULL,
      confidence INTEGER,
      source TEXT,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      close_price REAL,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status);
    CREATE INDEX IF NOT EXISTS idx_paper_trades_symbol ON paper_trades(symbol);
  `);
  db = conn;
  return conn;
}

function mapRow(r: Record<string, unknown>): PaperTrade {
  return {
    id: Number(r.id),
    symbol: String(r.symbol),
    name: String(r.name),
    market: String(r.market || "NSE"),
    amount_inr: Number(r.amount_inr),
    entry_price: Number(r.entry_price),
    qty: Number(r.qty),
    confidence: r.confidence != null ? Number(r.confidence) : null,
    source: r.source != null ? String(r.source) : null,
    opened_at: String(r.opened_at),
    closed_at: r.closed_at != null ? String(r.closed_at) : null,
    close_price: r.close_price != null ? Number(r.close_price) : null,
    status: String(r.status) === "closed" ? "closed" : "open",
  };
}

export function listPaperTrades(opts?: {
  status?: "open" | "closed" | "all";
}): PaperTrade[] {
  const status = opts?.status ?? "open";
  const rows =
    status === "all"
      ? (getDb()
          .prepare(`SELECT * FROM paper_trades ORDER BY opened_at DESC, id DESC`)
          .all() as Array<Record<string, unknown>>)
      : (getDb()
          .prepare(
            `SELECT * FROM paper_trades WHERE status = ? ORDER BY opened_at DESC, id DESC`,
          )
          .all(status) as Array<Record<string, unknown>>);
  return rows.map(mapRow);
}

async function fetchLiveQuote(
  symbol: string,
  market: string,
): Promise<{ price: number | null; day_change_pct: number | null }> {
  const sym = toYfinanceSymbol(symbol, market);
  try {
    const q = await yf.quote(sym);
    const price =
      q?.regularMarketPrice != null ? Number(q.regularMarketPrice) : null;
    const prev =
      q?.regularMarketPreviousClose != null
        ? Number(q.regularMarketPreviousClose)
        : null;
    let day_change_pct: number | null = null;
    if (price != null && prev != null && prev > 0) {
      day_change_pct = Math.round(((price - prev) / prev) * 10000) / 100;
    } else if (q?.regularMarketChangePercent != null) {
      day_change_pct =
        Math.round(Number(q.regularMarketChangePercent) * 100) / 100;
    }
    return {
      price: price != null && Number.isFinite(price) ? price : null,
      day_change_pct,
    };
  } catch {
    return { price: null, day_change_pct: null };
  }
}

function enrich(
  t: PaperTrade,
  live: { price: number | null; day_change_pct: number | null },
): PaperPosition {
  const mark =
    t.status === "closed"
      ? t.close_price
      : live.price ?? t.entry_price;
  const market_value =
    mark != null ? Math.round(mark * t.qty * 100) / 100 : null;
  const pnl_inr =
    market_value != null
      ? Math.round((market_value - t.amount_inr) * 100) / 100
      : null;
  const pnl_pct =
    pnl_inr != null && t.amount_inr > 0
      ? Math.round((pnl_inr / t.amount_inr) * 10000) / 100
      : null;
  return {
    ...t,
    live_price: t.status === "closed" ? t.close_price : live.price,
    day_change_pct: t.status === "closed" ? null : live.day_change_pct,
    market_value,
    pnl_inr,
    pnl_pct,
  };
}

export async function listPaperPositions(opts?: {
  status?: "open" | "closed" | "all";
}): Promise<{
  positions: PaperPosition[];
  summary: {
    open_count: number;
    invested: number;
    market_value: number;
    pnl_inr: number;
    pnl_pct: number | null;
  };
}> {
  const trades = listPaperTrades({ status: opts?.status ?? "all" });
  const open = trades.filter((t) => t.status === "open");
  const quoteCache = new Map<
    string,
    { price: number | null; day_change_pct: number | null }
  >();

  for (const t of open) {
    const key = `${t.market}:${t.symbol}`;
    if (!quoteCache.has(key)) {
      quoteCache.set(key, await fetchLiveQuote(t.symbol, t.market));
    }
  }

  const positions = trades.map((t) => {
    const key = `${t.market}:${t.symbol}`;
    const live =
      quoteCache.get(key) ??
      ({ price: t.close_price, day_change_pct: null } as const);
    return enrich(t, live);
  });

  const openPos = positions.filter((p) => p.status === "open");
  const invested = openPos.reduce((a, p) => a + p.amount_inr, 0);
  const market_value = openPos.reduce(
    (a, p) => a + (p.market_value ?? p.amount_inr),
    0,
  );
  const pnl_inr = Math.round((market_value - invested) * 100) / 100;
  const pnl_pct =
    invested > 0 ? Math.round((pnl_inr / invested) * 10000) / 100 : null;

  return {
    positions,
    summary: {
      open_count: openPos.length,
      invested: Math.round(invested * 100) / 100,
      market_value: Math.round(market_value * 100) / 100,
      pnl_inr,
      pnl_pct,
    },
  };
}

export async function openPaperTrade(opts: {
  symbol: string;
  amountInr: number;
  entryPrice?: number | null;
  confidence?: number | null;
  source?: string | null;
  name?: string | null;
  market?: string | null;
}): Promise<PaperPosition> {
  const symbol = opts.symbol.trim().toUpperCase();
  if (!symbol) throw new Error("Symbol required");
  const amount = Number(opts.amountInr);
  if (!Number.isFinite(amount) || amount < 100) {
    throw new Error("Amount must be at least ₹100");
  }
  if (amount > 10_000_000) {
    throw new Error("Amount too large for mock trade");
  }

  const co = loadAllCompanies().find(
    (c) => c.ticker.toUpperCase() === symbol,
  );
  const market = opts.market || co?.market || "NSE";
  const name = opts.name || co?.name || symbol;

  let entry = opts.entryPrice != null ? Number(opts.entryPrice) : null;
  if (entry == null || !Number.isFinite(entry) || entry <= 0) {
    const live = await fetchLiveQuote(symbol, market);
    entry = live.price;
  }
  if (entry == null || entry <= 0) {
    const fallback = co?.price != null ? Number(co.price) : null;
    entry = fallback;
  }
  if (entry == null || entry <= 0) {
    throw new Error(`No price available for ${symbol}`);
  }

  entry = Math.round(entry * 100) / 100;
  const qty = Math.round((amount / entry) * 10000) / 10000;
  const opened_at = new Date().toISOString();

  const r = getDb()
    .prepare(
      `INSERT INTO paper_trades (
        symbol, name, market, amount_inr, entry_price, qty,
        confidence, source, opened_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    )
    .run(
      symbol,
      name,
      market,
      amount,
      entry,
      qty,
      opts.confidence ?? null,
      opts.source ?? "mock",
      opened_at,
    );

  const trade = mapRow(
    getDb()
      .prepare(`SELECT * FROM paper_trades WHERE id = ?`)
      .get(Number(r.lastInsertRowid)) as Record<string, unknown>,
  );
  const live = await fetchLiveQuote(symbol, market);
  return enrich(trade, live);
}

export async function closePaperTrade(id: number): Promise<PaperPosition | null> {
  const row = getDb()
    .prepare(`SELECT * FROM paper_trades WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const trade = mapRow(row);
  if (trade.status === "closed") {
    return enrich(trade, { price: trade.close_price, day_change_pct: null });
  }
  const live = await fetchLiveQuote(trade.symbol, trade.market);
  const closePrice = live.price ?? trade.entry_price;
  getDb()
    .prepare(
      `UPDATE paper_trades
       SET status = 'closed', closed_at = ?, close_price = ?
       WHERE id = ?`,
    )
    .run(new Date().toISOString(), closePrice, id);
  const updated = mapRow(
    getDb()
      .prepare(`SELECT * FROM paper_trades WHERE id = ?`)
      .get(id) as Record<string, unknown>,
  );
  return enrich(updated, { price: closePrice, day_change_pct: null });
}

export function deletePaperTrade(id: number): boolean {
  const r = getDb().prepare(`DELETE FROM paper_trades WHERE id = ?`).run(id);
  return r.changes > 0;
}
