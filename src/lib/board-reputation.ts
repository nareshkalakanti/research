/**
 * Company-level board reputation from governance.db (director network scores).
 * Scan chip “Board” — like TQ/BB, but columns show score / bridge / SME× / top director.
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  scoreDirectorSeats,
  type DirectorScore,
} from "./gov-score";
import { loadMetricsMap } from "./metrics";

const DATA_DIR = path.join(process.cwd(), "data");
const GOV_PATH = path.join(DATA_DIR, "governance.db");

/** Min best-director score to pass without a bridge / Multi-LC / SME× flag. */
export const BOARD_REP_MIN_SCORE = 50;

export type BoardRepFlags = {
  bridge: boolean;
  tiny_bridge: boolean;
  ti_bridge: boolean;
  multi_lc: boolean;
  sme_cross: boolean;
};

export type BoardRepHit = BoardRepFlags & {
  ticker: string;
  /** Best DIN-backed director score on this board. */
  board_score: number;
  /** Qualifying directors (reputation signals) on this board. */
  board_dirs: number;
  /** Highest-scoring director name. */
  board_top: string | null;
  /** DIN of top director when available. */
  board_top_din: string | null;
};

type SeatSql = {
  person_id: string;
  din: string | null;
  director_name: string;
  ticker: string;
  market: string | null;
  designation: string | null;
  category: string | null;
};

type Cache = {
  at: number;
  byTicker: Map<string, BoardRepHit>;
  set: Set<string>;
};

let cache: Cache | null = null;
const CACHE_MS = 60_000;

function isSmeMarket(market: string | null | undefined): boolean {
  return /\bSME\b/i.test(market || "");
}

function isMainNse(market: string | null | undefined): boolean {
  const m = (market || "").trim().toUpperCase();
  return m === "NSE" || (m.startsWith("NSE") && !isSmeMarket(m));
}

function directorQualifies(score: DirectorScore, smeCross: boolean): boolean {
  if (!score.din_backed) return false;
  if (
    score.bridge ||
    score.tiny_bridge ||
    score.ti_bridge ||
    score.multi_lc ||
    smeCross
  ) {
    return true;
  }
  return score.board_count >= 2 && score.dir_score >= BOARD_REP_MIN_SCORE;
}

function loadSeats(): SeatSql[] {
  if (!fs.existsSync(GOV_PATH)) return [];
  const db = new Database(GOV_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  try {
    return db
      .prepare(
        `SELECT
          d.person_id AS person_id,
          d.din AS din,
          d.name AS director_name,
          UPPER(TRIM(s.ticker)) AS ticker,
          c.market AS market,
          s.designation AS designation,
          s.category AS category
        FROM directors d
        JOIN board_seats s ON s.person_id = d.person_id
        LEFT JOIN companies c ON c.ticker = s.ticker
        WHERE TRIM(COALESCE(s.ticker, '')) != ''
          AND d.din IS NOT NULL
          AND TRIM(d.din) != ''`,
      )
      .all() as SeatSql[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function buildCache(): Cache {
  const seats = loadSeats();
  const metrics = loadMetricsMap();
  const byPerson = new Map<string, SeatSql[]>();
  for (const seat of seats) {
    const list = byPerson.get(seat.person_id) ?? [];
    list.push(seat);
    byPerson.set(seat.person_id, list);
  }

  type Agg = {
    score: number;
    dirs: number;
    top: string | null;
    topDin: string | null;
    bridge: boolean;
    tiny_bridge: boolean;
    ti_bridge: boolean;
    multi_lc: boolean;
    sme_cross: boolean;
  };
  const byTicker = new Map<string, Agg>();

  for (const [personId, grp] of byPerson) {
    const din = grp[0]?.din?.trim() || null;
    const name = grp[0]?.director_name?.trim() || "";
    const scored = scoreDirectorSeats(
      grp.map((s) => ({
        ticker: s.ticker,
        market_cap_cr: metrics.get(s.ticker.toUpperCase())?.market_cap_cr ?? null,
        person_id: personId,
        din,
        designation: s.designation,
        category: s.category,
      })),
      { personId, din },
    );

    let smeN = 0;
    let mainN = 0;
    for (const s of grp) {
      if (isSmeMarket(s.market)) smeN += 1;
      else if (isMainNse(s.market)) mainN += 1;
    }
    const smeCross = smeN >= 1 && mainN >= 1;
    if (!directorQualifies(scored, smeCross)) continue;

    const tickers = new Set(
      grp.map((s) => s.ticker.toUpperCase()).filter(Boolean),
    );
    for (const ticker of tickers) {
      const prev = byTicker.get(ticker);
      if (!prev) {
        byTicker.set(ticker, {
          score: scored.dir_score,
          dirs: 1,
          top: name || null,
          topDin: din,
          bridge: scored.bridge || scored.tiny_bridge || scored.ti_bridge,
          tiny_bridge: scored.tiny_bridge,
          ti_bridge: scored.ti_bridge,
          multi_lc: scored.multi_lc,
          sme_cross: smeCross,
        });
        continue;
      }
      prev.dirs += 1;
      prev.bridge =
        prev.bridge || scored.bridge || scored.tiny_bridge || scored.ti_bridge;
      prev.tiny_bridge = prev.tiny_bridge || scored.tiny_bridge;
      prev.ti_bridge = prev.ti_bridge || scored.ti_bridge;
      prev.multi_lc = prev.multi_lc || scored.multi_lc;
      prev.sme_cross = prev.sme_cross || smeCross;
      if (scored.dir_score > prev.score) {
        prev.score = scored.dir_score;
        prev.top = name || prev.top;
        prev.topDin = din || prev.topDin;
      }
    }
  }

  const hits = new Map<string, BoardRepHit>();
  for (const [ticker, a] of byTicker) {
    hits.set(ticker, {
      ticker,
      board_score: a.score,
      board_dirs: a.dirs,
      board_top: a.top,
      board_top_din: a.topDin,
      bridge: a.bridge,
      tiny_bridge: a.tiny_bridge,
      ti_bridge: a.ti_bridge,
      multi_lc: a.multi_lc,
      sme_cross: a.sme_cross,
    });
  }

  return {
    at: Date.now(),
    byTicker: hits,
    set: new Set(hits.keys()),
  };
}

function ensureCache(): Cache {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache;
  cache = buildCache();
  return cache;
}

export function invalidateBoardRepCache(): void {
  cache = null;
}

export function boardRepTickerSet(): Set<string> {
  return ensureCache().set;
}

export function boardRepHit(ticker: string): BoardRepHit | null {
  return ensureCache().byTicker.get(ticker.toUpperCase()) ?? null;
}

export function boardRepMap(): Map<string, BoardRepHit> {
  return ensureCache().byTicker;
}
