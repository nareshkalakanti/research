/**
 * Governance map data — multi-board directors from local governance.db,
 * enriched with metrics / about / BB·TQ.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { pickAboutText } from "./db";
import { holdingsTickerSet } from "./holdings";
import { edgeTickerSet } from "./edge";
import { fundTagsForTicker, fundChangesForTicker, fundWatchlistAllTickers } from "./fund-watchlists";
import { researchLinks } from "./links";
import { loadMetricsMap } from "./metrics";
import { loadBreakoutMap } from "./signals";
import {
  mcapCapCode,
  mcapCapLabel,
  scoreDirectorSeats,
  type DirectorScore,
} from "./gov-score";
import type { FundChangeInfo, FundWatchlistKey } from "./fund-watchlist-meta";

const DATA_DIR = path.join(process.cwd(), "data");

export type GovCompanySeat = {
  ticker: string;
  name: string;
  market: string;
  designation: string;
  category: string | null;
  source: string | null;
  as_of: string | null;
  market_cap_cr: number | null;
  cap_code: string | null;
  cap_label: string | null;
  website: string | null;
  about: string | null;
  /** About + products + end-markets + HQ — used for theme matching. */
  about_search: string;
  headquarters: string | null;
  sector: string | null;
  is_sme: boolean;
  is_main: boolean;
  has_bb: boolean;
  has_tq: boolean;
  has_hold: boolean;
  has_edge: boolean;
  fund_tags: FundWatchlistKey[];
  fund_changes?: Partial<Record<FundWatchlistKey, FundChangeInfo>>;
  web: string | null;
  sc: string;
  tv: string;
};

export type GovernanceMapRow = {
  person_id: string;
  din: string | null;
  name: string;
  board_count: number;
  dir_score: number;
  din_backed: boolean;
  name_collision: boolean;
  big_n: number;
  small_n: number;
  tiny_n: number;
  ti_n: number;
  lc_n: number;
  bridge: boolean;
  tiny_bridge: boolean;
  ti_bridge: boolean;
  multi_lc: boolean;
  sme_n: number;
  main_n: number;
  sme_cross: boolean;
  tickers: string;
  companies: GovCompanySeat[];
  score_breakdown: DirectorScore;
  /** Theme-matched board count when a theme filter is active. */
  theme_matched?: number;
};

type SeatRow = {
  person_id: string;
  din: string | null;
  director_name: string;
  ticker: string;
  company_name: string;
  market: string;
  designation: string;
  category: string | null;
  source: string | null;
  as_of: string | null;
};

type AboutBits = {
  name: string | null;
  website: string | null;
  about: string | null;
  products: string | null;
  end_markets: string | null;
  headquarters: string | null;
  sector: string | null;
};

let govDb: Database.Database | null = null;
let aboutDb: Database.Database | null = null;
let mapCache: { at: number; rows: GovernanceMapRow[] } | null = null;
const CACHE_MS = 60_000;

function openReadonly(name: string): Database.Database {
  const db = new Database(path.join(DATA_DIR, name), {
    readonly: true,
    fileMustExist: true,
  });
  db.pragma("query_only = ON");
  return db;
}

function getGov(): Database.Database {
  if (!govDb) govDb = openReadonly("governance.db");
  return govDb;
}

function getAbout(): Database.Database | null {
  if (aboutDb) return aboutDb;
  try {
    aboutDb = openReadonly("company_about.db");
    return aboutDb;
  } catch {
    return null;
  }
}

const SEAT_SELECT = `
      SELECT
        d.person_id,
        d.din,
        d.name AS director_name,
        s.ticker,
        c.name AS company_name,
        c.market,
        s.designation,
        s.category,
        s.source,
        s.as_of
      FROM directors d
      JOIN board_seats s ON s.person_id = d.person_id
      JOIN companies c ON c.ticker = s.ticker
      WHERE UPPER(c.market) IN ('NSE', 'NSE SME')`;

function loadMultiBoardSeats(minBoards: number): SeatRow[] {
  const min = Math.max(2, minBoards);
  const db = getGov();
  return db
    .prepare(
      `
      ${SEAT_SELECT}
        AND d.person_id IN (
          SELECT s2.person_id
          FROM board_seats s2
          JOIN companies c2 ON c2.ticker = s2.ticker
          WHERE UPPER(c2.market) IN ('NSE', 'NSE SME')
          GROUP BY s2.person_id
          HAVING COUNT(DISTINCT s2.ticker) >= ?
        )
      ORDER BY d.name COLLATE NOCASE, c.name COLLATE NOCASE
      `,
    )
    .all(min) as SeatRow[];
}

/**
 * Directors linked to a company (ticker/name) or matching DIN/name —
 * includes single-board directors so company search works.
 */
function loadSeatsForSearchQuery(q: string): SeatRow[] {
  const term = q.trim();
  if (!term) return [];
  const like = `%${term.toLowerCase()}%`;
  const db = getGov();
  return db
    .prepare(
      `
      ${SEAT_SELECT}
        AND d.person_id IN (
          SELECT DISTINCT d2.person_id
          FROM directors d2
          LEFT JOIN board_seats s2 ON s2.person_id = d2.person_id
          LEFT JOIN companies c2 ON c2.ticker = s2.ticker
            AND UPPER(c2.market) IN ('NSE', 'NSE SME')
          WHERE LOWER(d2.name) LIKE ?
             OR (d2.din IS NOT NULL AND LOWER(d2.din) LIKE ?)
             OR (c2.ticker IS NOT NULL AND LOWER(c2.ticker) LIKE ?)
             OR (c2.name IS NOT NULL AND LOWER(c2.name) LIKE ?)
        )
      ORDER BY d.name COLLATE NOCASE, c.name COLLATE NOCASE
      `,
    )
    .all(like, like, like, like) as SeatRow[];
}

function loadAboutMap(tickers: string[]): Map<string, AboutBits> {
  const map = new Map<string, AboutBits>();
  const db = getAbout();
  if (!db || tickers.length === 0) return map;

  const chunk = 400;
  for (let i = 0; i < tickers.length; i += chunk) {
    const slice = tickers.slice(i, i + chunk);
    const placeholders = slice.map(() => "?").join(",");
    const rows = db
      .prepare(
        `
        SELECT ticker, name, website, about, yf_about, scraped_about,
               products, end_markets, headquarters,
               company_sector, company_industry
        FROM company_about
        WHERE UPPER(ticker) IN (${placeholders})
        `,
      )
      .all(...slice.map((t) => t.toUpperCase())) as Array<{
      ticker: string;
      name: string | null;
      website: string | null;
      about: string | null;
      yf_about: string | null;
      scraped_about: string | null;
      products: string | null;
      end_markets: string | null;
      headquarters: string | null;
      company_sector: string | null;
      company_industry: string | null;
    }>;
    for (const r of rows) {
      const about = pickAboutText(r);
      map.set(r.ticker.toUpperCase(), {
        name: r.name,
        website: r.website,
        about,
        products: r.products?.trim() || null,
        end_markets: r.end_markets?.trim() || null,
        headquarters: r.headquarters?.trim() || null,
        sector: r.company_sector || r.company_industry || null,
      });
    }
  }
  return map;
}

function buildRowsFromSeats(
  seats: SeatRow[],
  minBoards: number,
): GovernanceMapRow[] {
  if (seats.length === 0) return [];

  const byPerson = new Map<string, SeatRow[]>();
  for (const seat of seats) {
    const list = byPerson.get(seat.person_id) ?? [];
    list.push(seat);
    byPerson.set(seat.person_id, list);
  }

  const allTickers = [
    ...new Set(seats.map((s) => s.ticker.toUpperCase()).filter(Boolean)),
  ];
  const metrics = loadMetricsMap();
  const breakouts = loadBreakoutMap();
  const holdings = holdingsTickerSet();
  const edge = edgeTickerSet();
  const abouts = loadAboutMap(allTickers);

  const rows: GovernanceMapRow[] = [];

  for (const [personId, grp] of byPerson) {
    const companies: GovCompanySeat[] = [];
    for (const seat of grp) {
      const ticker = seat.ticker.toUpperCase();
      if (!ticker) continue;
      let market = (seat.market || "NSE").toUpperCase();
      const isSme = market === "NSE SME";
      if (isSme) market = "NSE SME";

      const m = metrics.get(ticker);
      const mcap = m?.market_cap_cr ?? null;
      const about = abouts.get(ticker);
      const bo = breakouts.get(ticker);
      const links = researchLinks(ticker, market, about?.website ?? null);

      companies.push({
        ticker,
        name: seat.company_name || about?.name || ticker,
        market,
        designation: seat.designation || "",
        category: seat.category,
        source: seat.source,
        as_of: seat.as_of,
        market_cap_cr: mcap,
        cap_code: mcapCapCode(mcap),
        cap_label: mcapCapLabel(mcap),
        website: about?.website ?? null,
        about: about?.about ?? null,
        about_search: [
          about?.headquarters,
          about?.about,
          about?.products,
          about?.end_markets,
          about?.headquarters,
        ]
          .filter(Boolean)
          .join(" \n "),
        headquarters: about?.headquarters ?? null,
        sector: about?.sector ?? m?.sector ?? null,
        is_sme: isSme,
        is_main: !isSme && market === "NSE",
        has_bb: Boolean(bo?.has_bb),
        has_tq: Boolean(bo?.has_tq),
        has_hold: holdings.has(ticker),
        has_edge: edge.has(ticker),
        fund_tags: fundTagsForTicker(ticker),
        fund_changes: fundChangesForTicker(ticker),
        web: links.web,
        sc: links.sc,
        tv: links.tv,
      });
    }

    const uniqueTickers = new Set(companies.map((c) => c.ticker));
    if (uniqueTickers.size < minBoards) continue;

    const din = grp[0]?.din?.trim() || null;
    const director = grp[0]?.director_name || "";
    const scored = scoreDirectorSeats(companies, {
      personId,
      din,
    });

    let smeN = 0;
    let mainN = 0;
    for (const c of companies) {
      if (c.is_sme) smeN += 1;
      else if (c.is_main) mainN += 1;
    }

    rows.push({
      person_id: personId,
      din,
      name: director,
      board_count: scored.board_count,
      dir_score: scored.dir_score,
      din_backed: scored.din_backed,
      name_collision: scored.name_collision,
      big_n: scored.big_n,
      small_n: scored.small_n,
      tiny_n: scored.tiny_n,
      ti_n: scored.ti_n,
      lc_n: scored.lc_n,
      bridge: scored.bridge,
      tiny_bridge: scored.tiny_bridge,
      ti_bridge: scored.ti_bridge,
      multi_lc: scored.multi_lc,
      sme_n: smeN,
      main_n: mainN,
      sme_cross: smeN >= 1 && mainN >= 1,
      tickers: companies.map((c) => c.ticker).join(", "),
      companies,
      score_breakdown: scored,
    });
  }

  rows.sort((a, b) => {
    if (b.dir_score !== a.dir_score) return b.dir_score - a.dir_score;
    if (b.board_count !== a.board_count) return b.board_count - a.board_count;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return rows;
}

function buildRows(minBoards: number): GovernanceMapRow[] {
  return buildRowsFromSeats(loadMultiBoardSeats(minBoards), minBoards);
}

export function invalidateGovernanceMapCache(): void {
  mapCache = null;
}

export function loadGovernanceMap(opts?: {
  minBoards?: number;
  refresh?: boolean;
  /** When set, search directors + companies (incl. single-board). */
  q?: string;
}): GovernanceMapRow[] {
  const minBoards = opts?.minBoards ?? 2;
  const q = (opts?.q || "").trim();
  const now = Date.now();

  if (!fs.existsSync(path.join(DATA_DIR, "governance.db"))) {
    return [];
  }

  if (q) {
    // Company / director search: include 1-board directors so tickers resolve.
    return buildRowsFromSeats(loadSeatsForSearchQuery(q), 1);
  }

  if (
    !opts?.refresh &&
    mapCache &&
    now - mapCache.at < CACHE_MS &&
    minBoards === 2
  ) {
    return mapCache.rows;
  }

  const rows = buildRows(minBoards);
  if (minBoards === 2) {
    mapCache = { at: now, rows };
  }
  return rows;
}

export type GovernanceMapStats = {
  directors: number;
  din_backed: number;
  name_only: number;
  bridges: number;
  tiny_bridges: number;
  ti_bridges: number;
  multi_lc: number;
  sme_cross: number;
  companies: number;
};

export function governanceMapStats(
  rows: GovernanceMapRow[],
): GovernanceMapStats {
  const tickers = new Set<string>();
  let dinBacked = 0;
  let bridges = 0;
  let tinyBridges = 0;
  let tiBridges = 0;
  let multiLc = 0;
  let smeCross = 0;
  for (const r of rows) {
    if (r.din_backed) dinBacked += 1;
    if (r.bridge) bridges += 1;
    if (r.tiny_bridge) tinyBridges += 1;
    if (r.ti_bridge) tiBridges += 1;
    if (r.multi_lc) multiLc += 1;
    if (r.sme_cross) smeCross += 1;
    for (const c of r.companies) tickers.add(c.ticker);
  }
  return {
    directors: rows.length,
    din_backed: dinBacked,
    name_only: rows.length - dinBacked,
    bridges,
    tiny_bridges: tinyBridges,
    ti_bridges: tiBridges,
    multi_lc: multiLc,
    sme_cross: smeCross,
    companies: tickers.size,
  };
}
