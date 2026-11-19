import { inactiveListingTickers } from "./listing-sync";
import type { FillResult } from "./nanocap-champs";
import { holderScanState, scanHolders, withStakeDb } from "./nse-holders";
import { buildMatcher, loadInvestors, type Investor } from "./smart-entities";
import { openSqliteNamed } from "./sqlite-utils";
import { fetchSourceHoldings, resolveHoldings } from "./trendlyne-holdings";

/**
 * Smart money: what a hand-picked set of investors hold and changed this
 * quarter. Sources (never the user's watchlists):
 *   - NSE shareholding filings (every named holder > 1%), latest + previous quarter
 *   - Trendlyne portfolio pages, for investors that have one (adds BSE stocks)
 */

export type Move = "new" | "up" | "down" | "same" | "exit" | null;

export type SmartHolding = {
  investor: string;
  pct: number | null;
  prev_pct: number | null;
  move: Move;
  /** Quarter end (NSE) or fetch date (Trendlyne). */
  as_of: string | null;
  source: "nse" | "trendlyne";
};

export type SmartMap = Map<string, SmartHolding[]>;

// ---- Trendlyne store (own file: data/smart_money.db) -------------------------

function withSmartDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T, readonly = false): T {
  const db = openSqliteNamed("smart_money.db", { readonly, wal: true });
  try {
    if (!readonly) {
      db.pragma("busy_timeout = 5000");
      db.exec(`CREATE TABLE IF NOT EXISTS tl_holdings (
        investor TEXT NOT NULL,
        ticker TEXT NOT NULL,
        exchange TEXT,
        company_name TEXT,
        pct REAL,
        change_qtr REAL,
        change_type TEXT,
        value_cr REAL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (investor, ticker)
      )`);
    }
    return fn(db);
  } finally {
    db.close();
  }
}

async function pullTrendlyne(inv: Investor): Promise<number> {
  if (!inv.tl_portfolio_id) return 0;
  const parsed = await fetchSourceHoldings(
    { label: inv.label, portfolio_id: inv.tl_portfolio_id, portfolio_slug: inv.tl_slug || "portfolio" },
    inv.label,
  );
  const rows = resolveHoldings(parsed).filter((r) => r.symbol);
  // An empty page is a fetch problem, not "sold everything" — keep what we have.
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  withSmartDb((db) => {
    db.transaction(() => {
      db.prepare(`DELETE FROM tl_holdings WHERE investor = ?`).run(inv.id);
      const ins = db.prepare(
        `INSERT OR REPLACE INTO tl_holdings (investor, ticker, exchange, company_name, pct, change_qtr, change_type, value_cr, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows)
        ins.run(
          inv.id,
          r.symbol.toUpperCase(),
          r.exchange,
          r.company_name,
          r.holding_percent,
          r.change_qtr,
          (r.change_type || "").toLowerCase(),
          r.holding_value_cr,
          now,
        );
    })();
  });
  return rows.length;
}

function tlMove(t: string | null): Move {
  const s = (t || "").toLowerCase();
  if (s === "new") return "new";
  if (s === "increased") return "up";
  if (s === "decreased") return "down";
  if (s === "unchanged" || s === "disclosed") return "same";
  return null;
}

// ---- Build ------------------------------------------------------------------

/** Ticker → each tracked investor's holding and this quarter's move. */
export function loadSmartMap(): SmartMap {
  const out: SmartMap = new Map();
  const put = (t: string, h: SmartHolding) => {
    if (!out.has(t)) out.set(t, []);
    out.get(t)!.push(h);
  };

  // NSE filings: sum each investor's named entities per symbol × quarter.
  type Q = Map<string, Map<string, number>>; // quarter → investor → pct
  const bySym = new Map<string, Q>();
  const matchInvestor = buildMatcher();
  const quartersOf = new Map<string, Set<string>>();
  try {
    withStakeDb((db) => {
      for (const r of db.prepare(`SELECT symbol, quarter, holder, pct FROM holder_stakes`).all() as Array<{
        symbol: string;
        quarter: string;
        holder: string;
        pct: number | null;
      }>) {
        const sym = r.symbol.toUpperCase();
        if (!quartersOf.has(sym)) quartersOf.set(sym, new Set());
        quartersOf.get(sym)!.add(r.quarter);
        const invId = matchInvestor(r.holder);
        if (!invId) continue;
        if (!bySym.has(sym)) bySym.set(sym, new Map());
        const q = bySym.get(sym)!;
        if (!q.has(r.quarter)) q.set(r.quarter, new Map());
        const m = q.get(r.quarter)!;
        m.set(invId, (m.get(invId) ?? 0) + (r.pct ?? 0));
      }
    }, true);
  } catch {
    /* no filings yet */
  }
  const scan = (() => {
    try {
      return holderScanState();
    } catch {
      return new Map<string, { quarter: string | null }>();
    }
  })();
  const nseSeen = new Set<string>();
  for (const [sym, q] of bySym) {
    const quarters = [...(quartersOf.get(sym) ?? [])].sort().reverse();
    const latest = scan.get(sym)?.quarter ?? quarters[0];
    if (!latest) continue;
    const prevQ = quarters.find((x) => x < latest) ?? null;
    const now = q.get(latest) ?? new Map<string, number>();
    const prev = prevQ ? q.get(prevQ) ?? new Map<string, number>() : null;
    const ids = new Set([...now.keys(), ...(prev?.keys() ?? [])]);
    for (const id of ids) {
      const p = now.get(id) ?? null;
      const pp = prev ? prev.get(id) ?? null : null;
      let move: Move = null;
      if (prev) {
        if (p != null && pp == null) move = "new";
        else if (p == null && pp != null) move = "exit";
        else if (p != null && pp != null) move = p - pp > 0.05 ? "up" : pp - p > 0.05 ? "down" : "same";
      }
      put(sym, { investor: id, pct: p, prev_pct: pp, move, as_of: latest, source: "nse" });
      nseSeen.add(`${id}|${sym}`);
    }
  }

  // Trendlyne: adds stocks the filings don't cover (BSE, not scanned yet).
  try {
    withSmartDb((db) => {
      for (const r of db
        .prepare(`SELECT investor, ticker, pct, change_qtr, change_type, fetched_at FROM tl_holdings`)
        .all() as Array<{
        investor: string;
        ticker: string;
        pct: number | null;
        change_qtr: number | null;
        change_type: string | null;
        fetched_at: string;
      }>) {
        if (nseSeen.has(`${r.investor}|${r.ticker}`)) continue;
        put(r.ticker, {
          investor: r.investor,
          pct: r.pct,
          prev_pct: r.pct != null && r.change_qtr != null ? r.pct - r.change_qtr : null,
          move: tlMove(r.change_type),
          as_of: r.fetched_at.slice(0, 10),
          source: "trendlyne",
        });
      }
    }, true);
  } catch {
    /* nothing pulled yet */
  }
  return out;
}

/** 0–100: more tracked investors, and fresh buying, score higher. */
export function smartScore(hs: SmartHolding[]): number {
  let s = 0;
  for (const h of hs) {
    if (h.move === "exit") {
      s -= 10;
      continue;
    }
    s += 20;
    if (h.move === "new") s += 25;
    else if (h.move === "up") s += 15;
    else if (h.move === "down") s -= 10;
  }
  return Math.max(0, Math.min(100, s));
}

export type SmartStatus = {
  investors: Array<{ id: string; label: string; note?: string; holds: number; bought: number; trendlyne: boolean }>;
  nse: { scanned: number; universe: number; latest_quarter: string | null; with_prev: number };
};

function nseUniverse(): Array<{ t: string; market: string }> {
  const inactive = inactiveListingTickers();
  const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
  try {
    return (
      db
        .prepare(`SELECT UPPER(ticker) AS t, market FROM company_about WHERE market IN ('NSE', 'NSE SME')`)
        .all() as Array<{ t: string; market: string }>
    ).filter((r) => !inactive.has(r.t));
  } finally {
    db.close();
  }
}

export function smartStatus(map: SmartMap): SmartStatus {
  const investors = loadInvestors().map((i) => {
    let holds = 0;
    let bought = 0;
    for (const hs of map.values())
      for (const h of hs)
        if (h.investor === i.id && h.move !== "exit") {
          holds++;
          if (h.move === "new" || h.move === "up") bought++;
        }
    return { id: i.id, label: i.label, note: i.note ?? undefined, holds, bought, trendlyne: !!i.tl_portfolio_id };
  });
  const scan = holderScanState();
  const uni = nseUniverse();
  const quarters = [...scan.values()].map((s) => s.quarter).filter((q): q is string => !!q);
  const latest = quarters.sort().at(-1) ?? null;
  let withPrev = 0;
  for (const hs of map.values()) if (hs.some((h) => h.source === "nse" && h.move != null)) withPrev++;
  return {
    investors,
    nse: {
      scanned: uni.filter((u) => scan.get(u.t)?.ok).length,
      universe: uni.length,
      latest_quarter: latest,
      with_prev: withPrev,
    },
  };
}

// ---- Refresh job ------------------------------------------------------------

const STOP_KEY = "__smartMoneyStop";
type StopHolder = { [STOP_KEY]?: boolean };

export function stopSmartRefresh(): void {
  (globalThis as StopHolder)[STOP_KEY] = true;
}

/**
 * 1. Trendlyne portfolio pages (Kacholia, Kela, Dolly Khanna).
 * 2. Latest NSE filing for every NSE / NSE SME company not scanned in 20 days.
 * 3. Previous quarter's filing wherever a tracked investor shows up (for new / added / cut).
 */
export async function runSmartRefresh(
  onProgress: (done: number, total: number, filled: number) => void,
): Promise<FillResult> {
  const holder = globalThis as StopHolder;
  holder[STOP_KEY] = false;
  const tl = loadInvestors().filter((i) => i.tl_portfolio_id);
  const scan = holderScanState();
  const fresh = Date.now() - 20 * 86_400_000;
  const todo = nseUniverse().filter((u) => {
    const s = scan.get(u.t);
    return !s || !s.ok || Date.parse(s.scanned_at) < fresh;
  });
  let total = tl.length + todo.length;
  let done = 0;
  let filled = 0;
  let failed = 0;
  onProgress(0, total, 0);

  for (const inv of tl) {
    if (holder[STOP_KEY]) break;
    try {
      if ((await pullTrendlyne(inv)) > 0) filled++;
    } catch {
      failed++;
    }
    done++;
    onProgress(done, total, filled);
  }

  const marketOf = new Map(nseUniverse().map((u) => [u.t, u.market]));
  const runWave = async (items: Array<{ t: string; market: string }>, back: number) => {
    for (let i = 0; i < items.length; i += 2) {
      if (holder[STOP_KEY]) return;
      await Promise.all(
        items.slice(i, i + 2).map(async (u) => {
          try {
            if (await scanHolders(u.t, u.market, back)) filled++;
          } catch {
            failed++;
          }
          done++;
        }),
      );
      onProgress(done, total, filled);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  await runWave(todo, 0);

  // Previous quarter wherever a tracked investor appears in the latest filing.
  const map = loadSmartMap();
  const needPrev: Array<{ t: string; market: string }> = [];
  for (const [t, hs] of map)
    if (hs.some((h) => h.source === "nse" && h.move == null) && marketOf.has(t))
      needPrev.push({ t, market: marketOf.get(t)! });
  total += needPrev.length;
  onProgress(done, total, filled);
  await runWave(needPrev, 1);

  return { tried: done, filled, left: Math.max(0, total - done), not_found: failed };
}
