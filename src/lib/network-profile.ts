/**
 * Network profile per company (four signals) plus the existing napkin filters
 * and scenario math. Signals describe board connectivity; they are not scores.
 */
import type Database from "better-sqlite3";
import { ensureCompanyMetricsFresh } from "@/lib/company-metrics";
import {
  companyGroupsStale,
  ensureCompanyGroupsTable,
  loadCompanyGroupLinks,
  writeCompanyGroups,
} from "@/lib/company-groups";
import {
  DIRECTOR_CONNECTIONS_VIEW_SQL,
  DIRECTOR_NETWORK_VIEW_SQL,
  DISCOVERY_MAX_TARGET_MCAP,
  NETWORK_DISCOVERY_VIEW_SQL,
  UNKNOWN_CAP_CODE,
  connectivityCapBands,
  ifNotExists,
} from "@/lib/company-network";
import { mcapCapCode } from "@/lib/gov-score";
import {
  NAPKIN_DEFAULT_TARGET_RETURN,
  napkinIllustrativeBuyRows,
  type NapkinBuyCase,
} from "@/lib/napkin/buy-price";
import {
  CURRENT_EPS_SOURCE_LABEL,
  resolveCurrentEps,
} from "@/lib/napkin/current-eps";
import { napkinRequiredEpsCagr } from "@/lib/napkin/engine";
import { epsGrowthGap5y } from "@/lib/napkin/eps-history";
import {
  DEFAULT_NAPKIN_SCAN_FILTER,
  napkinScanStatus,
  type NapkinScanStatus,
  type NapkinStockScanRow,
} from "@/lib/napkin/scan-filters";
import { loadNapkinStockScan } from "@/lib/napkin/stock-scan";
import { openSqliteNamed } from "@/lib/sqlite-utils";

/** Signal B threshold: connected company market cap above this, in ₹ Cr. */
export const LARGE_CONNECTION_MCAP_CR = 10_000;

export const NETWORK_CONNECTION_GROUPS_VIEW_SQL = `
CREATE VIEW network_connection_groups AS
SELECT
    n.*,
    CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM company_groups g1 WHERE g1.ticker = n.target_ticker
        )
          OR NOT EXISTS (
            SELECT 1 FROM company_groups g2 WHERE g2.ticker = n.connected_ticker
        )
            THEN 'unclassified'
        WHEN EXISTS (
            SELECT 1
            FROM company_groups g1
            JOIN company_groups g2
                ON g2.group_key = g1.group_key
            WHERE g1.ticker = n.target_ticker
              AND g2.ticker = n.connected_ticker
        )
            THEN 'same_group'
        ELSE 'cross_group'
    END AS connection_type
FROM network_discovery n
`;

export type ConnectionType = "same_group" | "cross_group" | "unclassified";

const PROFILE_SQL = `
SELECT
    target_ticker AS ticker,
    MAX(target_company) AS name,
    MAX(target_market_cap) AS market_cap,
    COUNT(DISTINCT person_id) AS external_directors,
    COUNT(DISTINCT CASE
        WHEN connected_market_cap > @large THEN person_id
    END) AS large_connections,
    COUNT(DISTINCT CASE
        WHEN connection_type = 'cross_group' THEN person_id
    END) AS cross_group_directors,
    COUNT(DISTINCT CASE
        WHEN connection_type = 'same_group' THEN person_id
    END) AS same_group_directors,
    COUNT(DISTINCT CASE
        WHEN connection_type = 'unclassified' THEN person_id
    END) AS unclassified_directors,
    MAX(connected_market_cap) AS largest_connection_mcap,
    ROUND(
        MAX(connected_market_cap) / NULLIF(MAX(target_market_cap), 0),
        1
    ) AS max_mcap_ratio
FROM network_connection_groups
`;

export type NetworkSignals = {
  ticker: string;
  name: string | null;
  market_cap: number | null;
  total_directors: number;
  external_directors: number;
  large_connections: number;
  cross_group_directors: number;
  same_group_directors: number;
  unclassified_directors: number;
  largest_connection_mcap: number | null;
  max_mcap_ratio: number | null;
};

export type NetworkFundamentals = {
  pe: number | null;
  revenue_cagr_3y: number | null;
  revenue_cagr_5y: number | null;
  eps_cagr_3y: number | null;
  eps_cagr_5y: number | null;
  roce: number | null;
  roe: number | null;
  current_price: number | null;
};

export type NetworkNapkin = {
  required_cagr: number | null;
  historical_eps_cagr: number | null;
  growth_gap: number | null;
  status: NapkinScanStatus;
};

export type NetworkCandidate = NetworkSignals &
  NetworkFundamentals &
  NetworkNapkin & { groups: string[] };

export type CandidateSort = "cross_group" | "large" | "ratio" | "external";

/**
 * Open governance.db with company_groups, company_metrics and the network
 * views ready. Groups load before the handle opens (the family map opens
 * governance.db itself).
 */
export function openNetworkDb(refresh = false): Database.Database {
  let stale = true;
  const probe = openSqliteNamed("governance.db", { wal: true });
  try {
    stale = companyGroupsStale(probe);
  } finally {
    probe.close();
  }
  const links = stale || refresh ? loadCompanyGroupLinks(refresh) : null;
  const db = openSqliteNamed("governance.db", { wal: true });
  try {
    ensureCompanyGroupsTable(db);
    if (links?.length) writeCompanyGroups(db, links);
    ensureCompanyMetricsFresh(db, refresh);
    db.exec(ifNotExists(DIRECTOR_NETWORK_VIEW_SQL, "director_network"));
    db.exec(ifNotExists(DIRECTOR_CONNECTIONS_VIEW_SQL, "director_connections"));
    db.exec(ifNotExists(NETWORK_DISCOVERY_VIEW_SQL, "network_discovery"));
    const current = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?`)
      .get("network_connection_groups") as { sql: string } | undefined;
    if (current && current.sql.trim() !== NETWORK_CONNECTION_GROUPS_VIEW_SQL.trim()) {
      db.exec(`DROP VIEW network_connection_groups`);
    }
    db.exec(
      ifNotExists(NETWORK_CONNECTION_GROUPS_VIEW_SQL, "network_connection_groups"),
    );
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

function groupsByTicker(db: Database.Database): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const rows = db
    .prepare(`SELECT ticker, group_name FROM company_groups ORDER BY group_name`)
    .all() as Array<{ ticker: string; group_name: string }>;
  for (const r of rows) {
    const list = map.get(r.ticker) ?? [];
    list.push(r.group_name);
    map.set(r.ticker, list);
  }
  return map;
}

function totalDirectors(db: Database.Database): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT ticker, COUNT(DISTINCT person_id) AS n FROM board_seats GROUP BY ticker`,
    )
    .all() as Array<{ ticker: string; n: number }>;
  return new Map(rows.map((r) => [r.ticker, r.n]));
}

function fundamentalsByTicker(db: Database.Database): Map<string, NetworkFundamentals> {
  const rows = db
    .prepare(
      `SELECT ticker, pe, revenue_cagr_3y, revenue_cagr_5y, eps_cagr_3y,
              eps_cagr_5y, roce, roe, current_price
       FROM company_metrics`,
    )
    .all() as Array<NetworkFundamentals & { ticker: string }>;
  return new Map(rows.map(({ ticker, ...rest }) => [ticker, rest]));
}

function scanByTicker(): Map<string, NapkinStockScanRow> {
  return new Map(
    loadNapkinStockScan("any").rows.map((r) => [r.ticker.toUpperCase(), r]),
  );
}

export function networkNapkin(
  f: Pick<NetworkFundamentals, "pe" | "eps_cagr_5y">,
  scan: NapkinStockScanRow | undefined,
): NetworkNapkin {
  const required = napkinRequiredEpsCagr(f.pe);
  return {
    required_cagr: required,
    historical_eps_cagr: f.eps_cagr_5y,
    growth_gap: epsGrowthGap5y(f.eps_cagr_5y, required),
    status: scan ? napkinScanStatus(scan, DEFAULT_NAPKIN_SCAN_FILTER) : "N/A",
  };
}

const EMPTY_FUNDAMENTALS: NetworkFundamentals = {
  pe: null,
  revenue_cagr_3y: null,
  revenue_cagr_5y: null,
  eps_cagr_3y: null,
  eps_cagr_5y: null,
  roce: null,
  roe: null,
  current_price: null,
};

function sortValue(row: NetworkCandidate, sort: CandidateSort): number {
  if (sort === "large") return row.large_connections;
  if (sort === "ratio") return row.max_mcap_ratio ?? -1;
  if (sort === "external") return row.external_directors;
  return row.cross_group_directors;
}

/** Every small company with directors on other boards, unsorted. */
export function buildNetworkCandidates(refresh = false): NetworkCandidate[] {
  const db = openNetworkDb(refresh);
  let profiles: Array<Omit<NetworkSignals, "total_directors">>;
  let groups: Map<string, string[]>;
  let totals: Map<string, number>;
  let fundamentals: Map<string, NetworkFundamentals>;
  try {
    const where =
      DISCOVERY_MAX_TARGET_MCAP != null ? "WHERE target_market_cap < @maxTarget" : "";
    profiles = db
      .prepare(`${PROFILE_SQL} ${where} GROUP BY target_ticker`)
      .all({
        large: LARGE_CONNECTION_MCAP_CR,
        ...(DISCOVERY_MAX_TARGET_MCAP != null
          ? { maxTarget: DISCOVERY_MAX_TARGET_MCAP }
          : {}),
      }) as typeof profiles;
    groups = groupsByTicker(db);
    totals = totalDirectors(db);
    fundamentals = fundamentalsByTicker(db);
  } finally {
    db.close();
  }
  const scans = scanByTicker();
  return profiles.map((p) => {
    const f = fundamentals.get(p.ticker) ?? EMPTY_FUNDAMENTALS;
    return {
      ...p,
      total_directors: totals.get(p.ticker) ?? 0,
      ...f,
      ...networkNapkin(f, scans.get(p.ticker)),
      groups: groups.get(p.ticker) ?? [],
    };
  });
}

/** Small companies with their network signals and existing napkin filter result. */
export function loadNetworkCandidates(opts?: {
  q?: string | null;
  sort?: CandidateSort;
  passingOnly?: boolean;
  page?: number;
  pageSize?: number;
  refresh?: boolean;
}): {
  rows: NetworkCandidate[];
  total: number;
  page: number;
  pages: number;
  max_target_mcap: number | null;
  large_mcap: number;
} {
  const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
  const page = Math.max(1, opts?.page ?? 1);
  const sort = opts?.sort ?? "cross_group";
  const q = (opts?.q || "").trim().toUpperCase();
  let rows = buildNetworkCandidates(opts?.refresh === true);
  if (q) {
    rows = rows.filter(
      (r) =>
        r.ticker.toUpperCase().includes(q) ||
        (r.name || "").toUpperCase().includes(q) ||
        r.groups.some((g) => g.toUpperCase().includes(q)),
    );
  }
  if (opts?.passingOnly) rows = rows.filter((r) => r.status !== "N/A");
  rows.sort(
    (a, b) =>
      sortValue(b, sort) - sortValue(a, sort) ||
      b.cross_group_directors - a.cross_group_directors ||
      b.large_connections - a.large_connections ||
      (b.max_mcap_ratio ?? -1) - (a.max_mcap_ratio ?? -1) ||
      a.ticker.localeCompare(b.ticker),
  );
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    total,
    page: safePage,
    pages,
    max_target_mcap: DISCOVERY_MAX_TARGET_MCAP,
    large_mcap: LARGE_CONNECTION_MCAP_CR,
  };
}

export type NetworkScreenRow = {
  ticker: string;
  name: string | null;
  market_cap: number | null;
  cap_code: string;
  group_keys: string[];
  multi_company_directors: number;
  same_group_directors: number;
  cross_group_directors: number;
  unclassified_directors: number;
  max_mcap_ratio: number | null;
};

export const SCREEN_SORT_KEYS = [
  "company",
  "market_cap",
  "multi_company_directors",
  "same_group_directors",
  "cross_group_directors",
  "unclassified_directors",
  "max_mcap_ratio",
] as const;
export type ScreenSortKey = (typeof SCREEN_SORT_KEYS)[number];
export type ScreenConnection = ConnectionType | "any";

function screenSortValue(row: NetworkScreenRow, key: ScreenSortKey): number | string | null {
  if (key === "company") return row.ticker;
  if (key === "market_cap") return row.market_cap;
  if (key === "max_mcap_ratio") return row.max_mcap_ratio;
  return row[key];
}

/** Sort with nulls last in either direction. */
export function compareScreenRows(
  a: NetworkScreenRow,
  b: NetworkScreenRow,
  key: ScreenSortKey,
  dir: "asc" | "desc",
): number {
  const av = screenSortValue(a, key);
  const bv = screenSortValue(b, key);
  if (av == null || bv == null) {
    if (av == null && bv == null) return a.ticker.localeCompare(b.ticker);
    return av == null ? 1 : -1;
  }
  const cmp =
    typeof av === "string" || typeof bv === "string"
      ? String(av).localeCompare(String(bv))
      : av - bv;
  return (dir === "asc" ? cmp : -cmp) || a.ticker.localeCompare(b.ticker);
}

export function screenRowMatches(
  row: NetworkScreenRow,
  f: { q?: string; group?: string | null; connection?: ScreenConnection; cap?: string | null },
): boolean {
  const q = (f.q || "").trim().toUpperCase();
  if (q && !row.ticker.toUpperCase().includes(q) && !(row.name || "").toUpperCase().includes(q)) {
    return false;
  }
  if (f.group && !row.group_keys.includes(f.group)) return false;
  if (f.cap && row.cap_code !== f.cap) return false;
  if (f.connection === "same_group" && row.same_group_directors === 0) return false;
  if (f.connection === "cross_group" && row.cross_group_directors === 0) return false;
  if (f.connection === "unclassified" && row.unclassified_directors === 0) return false;
  return true;
}

/** Every company with a director on another listed board, any market cap. */
export function loadNetworkScreen(opts?: {
  q?: string | null;
  group?: string | null;
  connection?: ScreenConnection;
  cap?: string | null;
  sort?: ScreenSortKey;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}): {
  rows: NetworkScreenRow[];
  total: number;
  page: number;
  pages: number;
  groups: Array<{ key: string; name: string }>;
  bands: Array<{ code: string; label: string }>;
} {
  const db = openNetworkDb();
  let profiles: Array<Omit<NetworkSignals, "total_directors">>;
  let links: Array<{ ticker: string; group_key: string; group_name: string }>;
  try {
    profiles = db
      .prepare(`${PROFILE_SQL} GROUP BY target_ticker`)
      .all({ large: LARGE_CONNECTION_MCAP_CR }) as typeof profiles;
    links = db
      .prepare(`SELECT ticker, group_key, group_name FROM company_groups`)
      .all() as typeof links;
  } finally {
    db.close();
  }
  const keysByTicker = new Map<string, string[]>();
  for (const l of links) {
    const list = keysByTicker.get(l.ticker) ?? [];
    list.push(l.group_key);
    keysByTicker.set(l.ticker, list);
  }
  const all: NetworkScreenRow[] = profiles.map((p) => ({
    ticker: p.ticker,
    name: p.name,
    market_cap: p.market_cap,
    cap_code: mcapCapCode(p.market_cap) ?? UNKNOWN_CAP_CODE,
    group_keys: keysByTicker.get(p.ticker) ?? [],
    multi_company_directors: p.external_directors,
    same_group_directors: p.same_group_directors,
    cross_group_directors: p.cross_group_directors,
    unclassified_directors: p.unclassified_directors,
    max_mcap_ratio: p.max_mcap_ratio,
  }));

  const inScreen = new Set(all.flatMap((r) => r.group_keys));
  const groupNames = new Map<string, string>();
  for (const l of links) {
    if (inScreen.has(l.group_key) && !groupNames.has(l.group_key)) {
      groupNames.set(l.group_key, l.group_name);
    }
  }
  const groups = [...groupNames]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const sort = opts?.sort ?? "max_mcap_ratio";
  const dir = opts?.dir ?? "desc";
  const rows = all
    .filter((r) =>
      screenRowMatches(r, {
        q: opts?.q ?? "",
        group: opts?.group,
        connection: opts?.connection,
        cap: opts?.cap,
      }),
    )
    .sort((a, b) => compareScreenRows(a, b, sort, dir));
  const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, opts?.page ?? 1), pages);
  const start = (page - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    total,
    page,
    pages,
    groups,
    bands: connectivityCapBands(),
  };
}

export type NetworkInvestigation = {
  signals: NetworkSignals | null;
  groups: string[];
  fundamentals: NetworkFundamentals;
  napkin: NetworkNapkin;
  scenario: {
    eps: number | null;
    eps_source: string | null;
    price: number | null;
    target_return: number;
    rows: Array<{
      name: string;
      expected_cagr: number;
      exit_pe: number;
      case: NapkinBuyCase;
    }>;
  };
  directors: Array<{
    person_id: string;
    director: string;
    connected: Array<{
      ticker: string;
      name: string | null;
      designation: string | null;
      market_cap: number | null;
      market_cap_ratio: number | null;
      connection_type: ConnectionType;
      groups: string[];
    }>;
  }>;
  large_mcap: number;
};

/** Network → fundamentals → napkin → scenario for one company. */
export async function loadNetworkInvestigation(
  ticker: string,
): Promise<NetworkInvestigation> {
  const t = ticker.trim().toUpperCase();
  const db = openNetworkDb();
  let market: string | null = null;
  let signals: NetworkSignals | null = null;
  let groups: Map<string, string[]>;
  let fundamentals: NetworkFundamentals;
  let links: Array<{
    person_id: string;
    director: string;
    connected_ticker: string;
    connected_company: string | null;
    connected_market_cap: number | null;
    market_cap_ratio: number | null;
    connection_type: ConnectionType;
    designation: string | null;
  }>;
  try {
    const p = db
      .prepare(`${PROFILE_SQL} WHERE target_ticker = @t GROUP BY target_ticker`)
      .get({ large: LARGE_CONNECTION_MCAP_CR, t }) as
      | Omit<NetworkSignals, "total_directors">
      | undefined;
    const total = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT person_id) AS n FROM board_seats WHERE ticker = ?`,
        )
        .get(t) as { n: number }
    ).n;
    if (p) signals = { ...p, total_directors: total };
    market =
      (db.prepare(`SELECT market FROM companies WHERE ticker = ?`).get(t) as
        | { market: string | null }
        | undefined)?.market ?? null;
    groups = groupsByTicker(db);
    fundamentals = fundamentalsByTicker(db).get(t) ?? EMPTY_FUNDAMENTALS;
    links = db
      .prepare(
        `SELECT n.person_id, n.director, n.connected_ticker, n.connected_company,
                n.connected_market_cap, n.market_cap_ratio, n.connection_type,
                bs.designation
         FROM network_connection_groups n
         LEFT JOIN board_seats bs
           ON bs.ticker = n.connected_ticker AND bs.person_id = n.person_id
         WHERE n.target_ticker = ?
         ORDER BY n.director,
                  CASE n.connection_type
                      WHEN 'cross_group' THEN 0
                      WHEN 'unclassified' THEN 1
                      ELSE 2
                  END,
                  n.connected_ticker`,
      )
      .all(t) as typeof links;
  } finally {
    db.close();
  }
  const scan = scanByTicker().get(t);
  const current = await resolveCurrentEps({
    ticker: t,
    market,
    storedTtm: scan?.eps ?? null,
  });
  const eps = current.eps;
  const price = fundamentals.current_price ?? current.price;
  const byPerson = new Map<string, NetworkInvestigation["directors"][number]>();
  for (const l of links) {
    let d = byPerson.get(l.person_id);
    if (!d) {
      d = { person_id: l.person_id, director: l.director, connected: [] };
      byPerson.set(l.person_id, d);
    }
    d.connected.push({
      ticker: l.connected_ticker,
      name: l.connected_company,
      designation: l.designation,
      market_cap: l.connected_market_cap,
      market_cap_ratio: l.market_cap_ratio,
      connection_type: l.connection_type,
      groups: groups.get(l.connected_ticker) ?? [],
    });
  }
  return {
    signals,
    groups: groups.get(t) ?? [],
    fundamentals,
    napkin: networkNapkin(fundamentals, scan),
    scenario: {
      eps,
      eps_source: current.source ? CURRENT_EPS_SOURCE_LABEL[current.source] : null,
      price,
      target_return: NAPKIN_DEFAULT_TARGET_RETURN,
      rows: napkinIllustrativeBuyRows({
        eps,
        price,
        target_return: NAPKIN_DEFAULT_TARGET_RETURN,
      }),
    },
    directors: [...byPerson.values()],
    large_mcap: LARGE_CONNECTION_MCAP_CR,
  };
}
