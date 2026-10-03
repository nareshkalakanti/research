/**
 * Board-seat network views on governance.db. The views are the only definition
 * of the counts; a high count marks a connector, not a quality signal.
 */
import type Database from "better-sqlite3";
import { ensureCompanyGroupsTable } from "@/lib/company-groups";
import { ensureCompanyMetricsFresh } from "@/lib/company-metrics";
import { CAP_CODE_BANDS, mcapCapCode } from "@/lib/gov-score";
import { loadMetricsMap } from "@/lib/metrics";
import { openSqliteNamed } from "@/lib/sqlite-utils";

export const COMPANY_NETWORK_VIEW_SQL = `
CREATE VIEW company_network AS
SELECT
    a.ticker AS ticker_a,
    b.ticker AS ticker_b,
    COUNT(DISTINCT a.person_id) AS shared_directors
FROM board_seats a
JOIN board_seats b
    ON a.person_id = b.person_id
   AND a.ticker < b.ticker
GROUP BY
    a.ticker,
    b.ticker
`;

export const DIRECTOR_NETWORK_VIEW_SQL = `
CREATE VIEW director_network AS
SELECT
    d.person_id,
    d.name,
    COUNT(DISTINCT bs.ticker) AS company_count
FROM directors d
JOIN board_seats bs
    ON bs.person_id = d.person_id
GROUP BY
    d.person_id,
    d.name
`;

export const DIRECTOR_NETWORK_MIN_COMPANIES = 2;

export const COMPANY_CONNECTIVITY_VIEW_SQL = `
CREATE VIEW company_connectivity AS
SELECT
    bs.ticker,
    COUNT(DISTINCT bs.person_id) AS total_directors,
    COUNT(DISTINCT CASE
        WHEN dn.company_count > 1 THEN bs.person_id
    END) AS externally_connected_directors
FROM board_seats bs
JOIN director_network dn
    ON dn.person_id = bs.person_id
GROUP BY bs.ticker
`;

export const DIRECTOR_CONNECTIONS_VIEW_SQL = `
CREATE VIEW director_connections AS
SELECT
    bs1.ticker AS target_ticker,
    c1.name AS target_company,
    bs1.person_id,
    d.name AS director,
    bs2.ticker AS connected_ticker,
    c2.name AS connected_company,
    bs2.designation AS connected_designation
FROM board_seats bs1
JOIN board_seats bs2
    ON bs1.person_id = bs2.person_id
   AND bs1.ticker <> bs2.ticker
JOIN directors d
    ON d.person_id = bs1.person_id
JOIN companies c1
    ON c1.ticker = bs1.ticker
JOIN companies c2
    ON c2.ticker = bs2.ticker
`;

export const NETWORK_DISCOVERY_VIEW_SQL = `
CREATE VIEW network_discovery AS
SELECT
    bs1.ticker AS target_ticker,
    c1.name AS target_company,
    bs1.person_id,
    d.name AS director,
    bs2.ticker AS connected_ticker,
    c2.name AS connected_company,
    cm1.market_cap AS target_market_cap,
    cm2.market_cap AS connected_market_cap,
    ROUND(
        cm2.market_cap / NULLIF(cm1.market_cap, 0),
        1
    ) AS market_cap_ratio
FROM board_seats bs1
JOIN board_seats bs2
    ON bs1.person_id = bs2.person_id
   AND bs1.ticker <> bs2.ticker
JOIN directors d
    ON d.person_id = bs1.person_id
JOIN companies c1
    ON c1.ticker = bs1.ticker
JOIN companies c2
    ON c2.ticker = bs2.ticker
JOIN company_metrics cm1
    ON cm1.ticker = bs1.ticker
JOIN company_metrics cm2
    ON cm2.ticker = bs2.ticker
`;

/** Target companies below the top of the "SC" (small cap) band, in ₹ Cr. */
export const DISCOVERY_MAX_TARGET_MCAP =
  CAP_CODE_BANDS.find((b) => b.code === "SC")?.hi ?? null;

export type NetworkDiscoveryRow = {
  target_ticker: string;
  target_company: string | null;
  person_id: string;
  director: string;
  connected_ticker: string;
  connected_company: string | null;
  target_market_cap: number | null;
  connected_market_cap: number | null;
  market_cap_ratio: number | null;
};

export const UNKNOWN_CAP_CODE = "NA";
/** Tiny, micro and small cap bands: every band up to and including "SC". */
export const DEFAULT_CONNECTIVITY_CAPS = CAP_CODE_BANDS.slice(
  0,
  CAP_CODE_BANDS.findIndex((b) => b.code === "SC") + 1,
).map((b) => b.code);

export function connectivityCapBands(): Array<{ code: string; label: string }> {
  return [
    ...CAP_CODE_BANDS.map((b) => ({ code: b.code, label: b.label })),
    { code: UNKNOWN_CAP_CODE, label: "Market cap unknown" },
  ];
}

export type CompanyConnectivityRow = {
  ticker: string;
  name: string | null;
  market_cap_cr: number | null;
  cap_code: string;
  total_directors: number;
  externally_connected_directors: number;
  connected_share: number | null;
};

export function ifNotExists(sql: string, view: string): string {
  return sql.replace(`CREATE VIEW ${view}`, `CREATE VIEW IF NOT EXISTS ${view}`);
}

export type DirectorNetworkRow = {
  person_id: string;
  name: string;
  company_count: number;
  tickers: string[];
};

export type CompanyNetworkRow = {
  ticker_a: string;
  ticker_b: string;
  shared_directors: number;
  name_a: string | null;
  name_b: string | null;
};

function likePattern(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

export function loadCompanyNetwork(opts?: {
  q?: string | null;
  page?: number;
  pageSize?: number;
}): { rows: CompanyNetworkRow[]; total: number; page: number; pages: number } {
  const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
  const page = Math.max(1, opts?.page ?? 1);
  const q = (opts?.q || "").trim();
  const db = openSqliteNamed("governance.db", { wal: true });
  try {
    db.exec(ifNotExists(COMPANY_NETWORK_VIEW_SQL, "company_network"));
    const where = q
      ? `WHERE n.ticker_a LIKE @like ESCAPE '\\'
          OR n.ticker_b LIKE @like ESCAPE '\\'
          OR IFNULL(ca.name, '') LIKE @like ESCAPE '\\'
          OR IFNULL(cb.name, '') LIKE @like ESCAPE '\\'`
      : "";
    const params = q ? { like: likePattern(q) } : {};
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM company_network n
           LEFT JOIN companies ca ON ca.ticker = n.ticker_a
           LEFT JOIN companies cb ON cb.ticker = n.ticker_b
           ${where}`,
        )
        .get(params) as { n: number }
    ).n;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pages);
    const rows = db
      .prepare(
        `SELECT
           n.ticker_a,
           n.ticker_b,
           n.shared_directors,
           ca.name AS name_a,
           cb.name AS name_b
         FROM company_network n
         LEFT JOIN companies ca ON ca.ticker = n.ticker_a
         LEFT JOIN companies cb ON cb.ticker = n.ticker_b
         ${where}
         ORDER BY n.shared_directors DESC, n.ticker_a, n.ticker_b
         LIMIT @limit OFFSET @offset`,
      )
      .all({
        ...params,
        limit: pageSize,
        offset: (safePage - 1) * pageSize,
      }) as CompanyNetworkRow[];
    return { rows, total, page: safePage, pages };
  } finally {
    db.close();
  }
}

export function loadCompanyConnectivity(opts?: {
  q?: string | null;
  caps?: string[] | null;
  page?: number;
  pageSize?: number;
}): {
  rows: CompanyConnectivityRow[];
  total: number;
  page: number;
  pages: number;
  caps: string[];
} {
  const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
  const page = Math.max(1, opts?.page ?? 1);
  const q = (opts?.q || "").trim().toUpperCase();
  const caps = opts?.caps?.length ? opts.caps : DEFAULT_CONNECTIVITY_CAPS;
  const capSet = new Set(caps);
  const db = openSqliteNamed("governance.db", { wal: true });
  let base: Array<{
    ticker: string;
    name: string | null;
    total_directors: number;
    externally_connected_directors: number;
  }>;
  try {
    db.exec(ifNotExists(DIRECTOR_NETWORK_VIEW_SQL, "director_network"));
    db.exec(ifNotExists(COMPANY_CONNECTIVITY_VIEW_SQL, "company_connectivity"));
    base = db
      .prepare(
        `SELECT n.ticker, c.name, n.total_directors, n.externally_connected_directors
         FROM company_connectivity n
         LEFT JOIN companies c ON c.ticker = n.ticker`,
      )
      .all() as typeof base;
  } finally {
    db.close();
  }
  const metrics = loadMetricsMap();
  const all: CompanyConnectivityRow[] = [];
  for (const r of base) {
    const mcap = metrics.get(r.ticker.toUpperCase())?.market_cap_cr ?? null;
    const cap_code = mcapCapCode(mcap) ?? UNKNOWN_CAP_CODE;
    if (!capSet.has(cap_code)) continue;
    if (
      q &&
      !r.ticker.toUpperCase().includes(q) &&
      !(r.name || "").toUpperCase().includes(q)
    ) {
      continue;
    }
    all.push({
      ...r,
      market_cap_cr: mcap,
      cap_code,
      connected_share:
        r.total_directors > 0
          ? r.externally_connected_directors / r.total_directors
          : null,
    });
  }
  all.sort(
    (a, b) =>
      b.externally_connected_directors - a.externally_connected_directors ||
      b.total_directors - a.total_directors ||
      a.ticker.localeCompare(b.ticker),
  );
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;
  return {
    rows: all.slice(start, start + pageSize),
    total,
    page: safePage,
    pages,
    caps,
  };
}

function ensureNetworkViews(db: Database.Database, refresh = false): void {
  ensureCompanyMetricsFresh(db, refresh);
  db.exec(ifNotExists(DIRECTOR_NETWORK_VIEW_SQL, "director_network"));
  db.exec(ifNotExists(DIRECTOR_CONNECTIONS_VIEW_SQL, "director_connections"));
  db.exec(ifNotExists(NETWORK_DISCOVERY_VIEW_SQL, "network_discovery"));
}

export const DISCOVERY_MCAP_BANDS = [
  "all",
  "lt100",
  "b100_500",
  "b500_1000",
  "b1000_5000",
  "gte5000",
] as const;
export type DiscoveryMcapBand = (typeof DISCOVERY_MCAP_BANDS)[number];

export const DISCOVERY_SIGNALS = [
  "all",
  "boards3",
  "c5k",
  "c10k",
  "xgroup",
  "cos2",
  "dirs2",
] as const;
export type DiscoverySignal = (typeof DISCOVERY_SIGNALS)[number];

export type DiscoveryCompanyRow = {
  ticker: string;
  name: string | null;
  market_cap: number | null;
  connected_companies: number;
  directors: number;
  board_directors: number;
  largest_connected_mcap: number | null;
  cross_group: boolean;
};

export type DiscoveryCompanySummary = {
  companies: number;
  boards_3: number;
  connected_5k: number;
  connected_10k: number;
  cross_group: number;
};

export function discoveryMcapMatches(
  mcap: number | null,
  band: DiscoveryMcapBand,
): boolean {
  if (band === "all") return true;
  if (mcap == null) return false;
  if (band === "lt100") return mcap < 100;
  if (band === "b100_500") return mcap >= 100 && mcap < 500;
  if (band === "b500_1000") return mcap >= 500 && mcap < 1000;
  if (band === "b1000_5000") return mcap >= 1000 && mcap < 5000;
  return mcap >= 5000;
}

export function discoverySignalMatches(
  row: DiscoveryCompanyRow,
  signal: DiscoverySignal,
): boolean {
  if (signal === "all") return true;
  if (signal === "boards3") return row.board_directors >= 3;
  if (signal === "c5k") return (row.largest_connected_mcap ?? 0) >= 5000;
  if (signal === "c10k") return (row.largest_connected_mcap ?? 0) >= 10_000;
  if (signal === "xgroup") return row.cross_group;
  if (signal === "cos2") return row.connected_companies >= 2;
  return row.directors >= 2;
}

export function discoveryCompanySignals(row: DiscoveryCompanyRow): string[] {
  const out: string[] = [];
  if (row.board_directors >= 3) out.push("3+ Boards");
  if ((row.largest_connected_mcap ?? 0) >= 10_000) out.push("₹10k+ Connection");
  else if ((row.largest_connected_mcap ?? 0) >= 5000) out.push("₹5k+ Connection");
  if (row.cross_group) out.push("Cross Group");
  if (row.connected_companies >= 2) out.push("2+ Connections");
  return out;
}

function discoveryCompanySummary(
  rows: DiscoveryCompanyRow[],
): DiscoveryCompanySummary {
  return {
    companies: rows.length,
    boards_3: rows.filter((r) => r.board_directors >= 3).length,
    connected_5k: rows.filter((r) => (r.largest_connected_mcap ?? 0) >= 5000)
      .length,
    connected_10k: rows.filter((r) => (r.largest_connected_mcap ?? 0) >= 10_000)
      .length,
    cross_group: rows.filter((r) => r.cross_group).length,
  };
}

/** Small targets linked through a director to other boards, by market_cap_ratio. */
export function loadNetworkDiscovery(opts?: {
  q?: string | null;
  page?: number;
  pageSize?: number;
  refresh?: boolean;
  companies?: boolean;
  mcap?: DiscoveryMcapBand;
  signal?: DiscoverySignal;
}): {
  rows: NetworkDiscoveryRow[];
  companies?: DiscoveryCompanyRow[];
  summary?: DiscoveryCompanySummary;
  total: number;
  page: number;
  pages: number;
  max_target_mcap: number | null;
} {
  const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
  const page = Math.max(1, opts?.page ?? 1);
  const q = (opts?.q || "").trim();
  const db = openSqliteNamed("governance.db", { wal: true });
  try {
    ensureNetworkViews(db, opts?.refresh === true);
    if (opts?.companies) {
      const params: Record<string, string | number> = {};
      const where =
        DISCOVERY_MAX_TARGET_MCAP != null
          ? ((params.maxTarget = DISCOVERY_MAX_TARGET_MCAP),
            "WHERE n.target_market_cap < @maxTarget")
          : "";
      const edges = db
        .prepare(`SELECT * FROM network_discovery n ${where}`)
        .all(params) as NetworkDiscoveryRow[];
      const boardN = new Map(
        (
          db
            .prepare(
              `SELECT ticker, COUNT(DISTINCT person_id) AS n
               FROM board_seats GROUP BY ticker`,
            )
            .all() as Array<{ ticker: string; n: number }>
        ).map((r) => [r.ticker, r.n]),
      );
      const groupKeys = new Map<string, Set<string>>();
      for (const row of db
        .prepare(`SELECT ticker, group_key FROM company_groups`)
        .all() as Array<{ ticker: string; group_key: string }>) {
        const set = groupKeys.get(row.ticker) ?? new Set<string>();
        set.add(row.group_key);
        groupKeys.set(row.ticker, set);
      }
      const byTicker = new Map<
        string,
        {
          name: string | null;
          market_cap: number | null;
          cos: Set<string>;
          dirs: Set<string>;
          largest: number | null;
          cross: boolean;
        }
      >();
      for (const e of edges) {
        let rec = byTicker.get(e.target_ticker);
        if (!rec) {
          rec = {
            name: e.target_company,
            market_cap: e.target_market_cap,
            cos: new Set(),
            dirs: new Set(),
            largest: null,
            cross: false,
          };
          byTicker.set(e.target_ticker, rec);
        }
        rec.cos.add(e.connected_ticker);
        rec.dirs.add(e.person_id);
        if (
          e.connected_market_cap != null &&
          (rec.largest == null || e.connected_market_cap > rec.largest)
        ) {
          rec.largest = e.connected_market_cap;
        }
        if (
          pairGroupType(e.target_ticker, e.connected_ticker, groupKeys) ===
          "cross_group"
        ) {
          rec.cross = true;
        }
      }
      const qU = q.toUpperCase();
      const mcap = opts.mcap ?? "all";
      const signal = opts.signal ?? "all";
      const all = [...byTicker.entries()].map(([ticker, rec]) => ({
        ticker,
        name: rec.name,
        market_cap: rec.market_cap,
        connected_companies: rec.cos.size,
        directors: rec.dirs.size,
        board_directors: boardN.get(ticker) ?? rec.dirs.size,
        largest_connected_mcap: rec.largest,
        cross_group: rec.cross,
      }));
      const searched = all.filter((r) => {
        if (!qU) return true;
        return (
          r.ticker.toUpperCase().includes(qU) ||
          (r.name || "").toUpperCase().includes(qU)
        );
      });
      const banded = searched.filter((r) => discoveryMcapMatches(r.market_cap, mcap));
      const summary = discoveryCompanySummary(banded);
      const filtered = banded
        .filter((r) => discoverySignalMatches(r, signal))
        .sort((a, b) => {
          if (a.market_cap == null && b.market_cap == null) {
            return a.ticker.localeCompare(b.ticker);
          }
          if (a.market_cap == null) return 1;
          if (b.market_cap == null) return -1;
          return a.market_cap - b.market_cap || a.ticker.localeCompare(b.ticker);
        });
      const total = filtered.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, pages);
      return {
        rows: [],
        companies: filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
        summary,
        total,
        page: safePage,
        pages,
        max_target_mcap: DISCOVERY_MAX_TARGET_MCAP,
      };
    }
    const conds: string[] = [];
    const params: Record<string, string | number> = {};
    if (DISCOVERY_MAX_TARGET_MCAP != null) {
      conds.push("n.target_market_cap < @maxTarget");
      params.maxTarget = DISCOVERY_MAX_TARGET_MCAP;
    }
    if (q) {
      conds.push(`(n.target_ticker LIKE @like ESCAPE '\\'
        OR n.connected_ticker LIKE @like ESCAPE '\\'
        OR IFNULL(n.target_company, '') LIKE @like ESCAPE '\\'
        OR IFNULL(n.connected_company, '') LIKE @like ESCAPE '\\'
        OR IFNULL(n.director, '') LIKE @like ESCAPE '\\')`);
      params.like = likePattern(q);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const total = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM network_discovery n ${where}`)
        .get(params) as { n: number }
    ).n;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pages);
    const rows = db
      .prepare(
        `SELECT * FROM network_discovery n ${where}
         ORDER BY n.market_cap_ratio IS NULL, n.market_cap_ratio DESC,
                  n.target_ticker, n.director, n.connected_ticker
         LIMIT @limit OFFSET @offset`,
      )
      .all({
        ...params,
        limit: pageSize,
        offset: (safePage - 1) * pageSize,
      }) as NetworkDiscoveryRow[];
    return {
      rows,
      total,
      page: safePage,
      pages,
      max_target_mcap: DISCOVERY_MAX_TARGET_MCAP,
    };
  } finally {
    db.close();
  }
}

export function loadDirectorNetwork(opts?: {
  q?: string | null;
  page?: number;
  pageSize?: number;
}): { rows: DirectorNetworkRow[]; total: number; page: number; pages: number } {
  const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
  const page = Math.max(1, opts?.page ?? 1);
  const q = (opts?.q || "").trim();
  const db = openSqliteNamed("governance.db", { wal: true });
  try {
    db.exec(ifNotExists(DIRECTOR_NETWORK_VIEW_SQL, "director_network"));
    const search = q
      ? `AND (
           IFNULL(n.name, '') LIKE @like ESCAPE '\\'
           OR EXISTS (
             SELECT 1 FROM board_seats s
             LEFT JOIN companies c ON c.ticker = s.ticker
             WHERE s.person_id = n.person_id
               AND (s.ticker LIKE @like ESCAPE '\\'
                    OR IFNULL(c.name, '') LIKE @like ESCAPE '\\')
           )
         )`
      : "";
    const params = {
      min: DIRECTOR_NETWORK_MIN_COMPANIES,
      ...(q ? { like: likePattern(q) } : {}),
    };
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM director_network n
           WHERE n.company_count >= @min ${search}`,
        )
        .get(params) as { n: number }
    ).n;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pages);
    const raw = db
      .prepare(
        `SELECT
           n.person_id,
           n.name,
           n.company_count,
           (SELECT GROUP_CONCAT(t, ',') FROM (
              SELECT DISTINCT s.ticker AS t FROM board_seats s
              WHERE s.person_id = n.person_id ORDER BY s.ticker
           )) AS tickers
         FROM director_network n
         WHERE n.company_count >= @min ${search}
         ORDER BY n.company_count DESC, n.name
         LIMIT @limit OFFSET @offset`,
      )
      .all({
        ...params,
        limit: pageSize,
        offset: (safePage - 1) * pageSize,
      }) as Array<Omit<DirectorNetworkRow, "tickers"> & { tickers: string | null }>;
    const rows = raw.map((r) => ({
      ...r,
      tickers: (r.tickers || "").split(",").filter(Boolean),
    }));
    return { rows, total, page: safePage, pages };
  } finally {
    db.close();
  }
}

export type NewConnectionType = "same_group" | "cross_group" | "unclassified";

export type NewConnectionRow = {
  target_ticker: string;
  target_company: string | null;
  target_market_cap: number | null;
  director: string;
  person_id: string;
  event_date: string;
  connected_ticker: string;
  connected_company: string | null;
  connected_market_cap: number | null;
  market_cap_ratio: number | null;
  connection_type: NewConnectionType;
  board_count: number | null;
  target_designation: string | null;
  connected_designation: string | null;
  /** 1 = still on the existing board, 0 = resigned (tracked event). */
  connected_current: number;
  /** First tracked join on the existing board; null when the seat predates tracking. */
  connected_joined_at: string | null;
  connected_resigned_at: string | null;
};

export type NewConnectionTargetRow = {
  target_ticker: string;
  target_company: string | null;
  target_market_cap: number | null;
  connected_companies: number;
  n_10k: number;
  n_25k: number;
  n_50k: number;
  largest_connected_mcap: number | null;
  largest_connected_ticker: string | null;
  largest_connected_company: string | null;
  largest_ratio: number | null;
  cross_group_count: number;
  multi_board_director_count: number;
};

export type NewConnectionSummary = {
  edges: number;
  unique_targets: number;
  unique_directors: number;
  cross_group: number;
  mega_connections: number;
  n_10k_connections?: number;
  n_25k_connections?: number;
};

/** Connected mcap at or above this counts as a mega connection in the summary. */
export const NEW_CONNECTION_MEGA_MCAP_CR = 50_000;
export const NEW_CONNECTION_LARGE_MCAP_CR = 10_000;
export const NEW_CONNECTION_MID_MCAP_CR = 25_000;

export const GOVERNANCE_NETWORK_COVERAGE_NOTE =
  "Governance coverage: NSE / NSE SME network. BSE SME companies are included in the company universe and market-cap data but excluded from governance connections because reliable current board extraction is unavailable.";

export type NewConnectionSort =
  | "event"
  | "ratio"
  | "boards"
  | "connected"
  | "mcap"
  | "n10k"
  | "n25k"
  | "n50k"
  | "cross"
  | "multi";

const CONNECTION_CASE = `
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM company_groups g1 WHERE g1.ticker = lj.ticker)
      OR NOT EXISTS (SELECT 1 FROM company_groups g2 WHERE g2.ticker = o.ticker)
      THEN 'unclassified'
    WHEN EXISTS (
      SELECT 1
      FROM company_groups g1
      JOIN company_groups g2 ON g2.group_key = g1.group_key
      WHERE g1.ticker = lj.ticker AND g2.ticker = o.ticker
    ) THEN 'same_group'
    ELSE 'cross_group'
  END`;

export function loadNewConnections(opts?: {
  q?: string | null;
  page?: number;
  pageSize?: number;
  days?: number | null;
  connection?: NewConnectionType | "any";
  minConnectedMcap?: number;
  minRatio?: number;
  /** Upper bound exclusive. Null = no upper bound. Target still needs mcap > 0. */
  maxTargetMcap?: number | null;
  minBoards?: number;
  sort?: NewConnectionSort;
  aggregate?: "edges" | "targets" | "gap";
  /** For aggregate=targets: keep targets with this many distinct connected cos >= 10k Cr. */
  minN10k?: number;
  /** Restrict CTE output to one target ticker (drill-down). */
  targetTicker?: string | null;
  /** Also link boards the director resigned from (tracked resignation events). */
  includeFormerSeats?: boolean;
}): {
  rows: NewConnectionRow[];
  targets: NewConnectionTargetRow[];
  total: number;
  page: number;
  pages: number;
  max_target_mcap: number | null;
  summary: NewConnectionSummary;
} {
  const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
  const page = Math.max(1, opts?.page ?? 1);
  const q = (opts?.q || "").trim();
  const days = opts?.days != null && opts.days > 0 ? opts.days : null;
  const connection = opts?.connection || "any";
  const minConnected = opts?.minConnectedMcap ?? 0;
  const minRatio = opts?.minRatio ?? 0;
  const maxTarget =
    opts?.maxTargetMcap === undefined
      ? (DISCOVERY_MAX_TARGET_MCAP ?? 5000)
      : opts.maxTargetMcap;
  const minBoards = opts?.minBoards ?? 0;
  const sort: NewConnectionSort = opts?.sort || "event";
  const aggregate =
    opts?.aggregate === "targets"
      ? "targets"
      : opts?.aggregate === "gap"
        ? "gap"
        : "edges";
  const gapAgg = aggregate === "gap";
  const minN10k = opts?.minN10k ?? 0;
  const db = openSqliteNamed("governance.db", { wal: true });
  try {
    ensureCompanyGroupsTable(db);
    db.exec(ifNotExists(DIRECTOR_NETWORK_VIEW_SQL, "director_network"));
    const conds = ["tm.market_cap > 0", "cm.market_cap > 0"];
    const params: Record<string, string | number> = {
      mega: NEW_CONNECTION_MEGA_MCAP_CR,
      large: NEW_CONNECTION_LARGE_MCAP_CR,
      mid: NEW_CONNECTION_MID_MCAP_CR,
    };
    if (maxTarget != null && maxTarget > 0) {
      conds.push("tm.market_cap < @maxTarget");
      params.maxTarget = maxTarget;
    }
    if (days != null) {
      conds.push("julianday('now') - julianday(lj.detected_at) <= @days");
      params.days = days;
    }
    if (!gapAgg && minConnected > 0) {
      conds.push("cm.market_cap >= @minConnected");
      params.minConnected = minConnected;
    }
    if (!gapAgg && minRatio > 0) {
      conds.push("(cm.market_cap / tm.market_cap) >= @minRatio");
      params.minRatio = minRatio;
    }
    if (!gapAgg && connection !== "any") {
      conds.push(`(${CONNECTION_CASE}) = @connection`);
      params.connection = connection;
    }
    if (!gapAgg && minBoards > 0) {
      conds.push("IFNULL(dn.company_count, 0) >= @minBoards");
      params.minBoards = minBoards;
    }
    const targetTicker = (opts?.targetTicker || "").trim().toUpperCase();
    if (targetTicker) {
      conds.push("lj.ticker = @targetTicker");
      params.targetTicker = targetTicker;
    }
    if (q && !gapAgg) {
      conds.push(`(
        lj.ticker LIKE @like ESCAPE '\\'
        OR o.ticker LIKE @like ESCAPE '\\'
        OR IFNULL(c1.name, '') LIKE @like ESCAPE '\\'
        OR IFNULL(c2.name, '') LIKE @like ESCAPE '\\'
        OR IFNULL(d.name, lj.director_name) LIKE @like ESCAPE '\\'
      )`);
      params.like = likePattern(q);
    }
    const where = `WHERE ${conds.join(" AND ")}`;
    const formerSeats = opts?.includeFormerSeats
      ? `UNION ALL
         SELECT r.ticker, r.person_id, r.old_designation AS designation, 0 AS is_current, MAX(r.id) AS last_id
         FROM board_seat_events r
         WHERE r.event_type = 'resigned'
           AND NOT EXISTS (
             SELECT 1 FROM board_seats s
             WHERE s.ticker = r.ticker AND s.person_id = r.person_id
           )
         GROUP BY r.ticker, r.person_id`
      : "";
    const cte = `
      WITH latest_joined AS (
        SELECT e.ticker, e.person_id, e.director_name, e.detected_at, e.event_type, e.id
        FROM board_seat_events e
        JOIN (
          SELECT ticker, person_id, MAX(id) AS id
          FROM board_seat_events
          WHERE event_type = 'joined'
          GROUP BY ticker, person_id
        ) x ON x.id = e.id
      ),
      new_edges AS (
        SELECT
          lj.ticker AS target_ticker,
          c1.name AS target_company,
          tm.market_cap AS target_market_cap,
          IFNULL(d.name, lj.director_name) AS director,
          lj.person_id,
          lj.detected_at AS event_date,
          o.ticker AS connected_ticker,
          c2.name AS connected_company,
          cm.market_cap AS connected_market_cap,
          ROUND(cm.market_cap / tm.market_cap, 1) AS market_cap_ratio,
          ${CONNECTION_CASE} AS connection_type,
          dn.company_count AS board_count,
          here.designation AS target_designation,
          o.designation AS connected_designation,
          o.is_current AS connected_current,
          (
            SELECT MIN(j.detected_at) FROM board_seat_events j
            WHERE j.ticker = o.ticker AND j.person_id = o.person_id
              AND j.event_type = 'joined'
          ) AS connected_joined_at,
          CASE WHEN o.is_current = 1 THEN NULL ELSE (
            SELECT MAX(x.detected_at) FROM board_seat_events x
            WHERE x.ticker = o.ticker AND x.person_id = o.person_id
              AND x.event_type = 'resigned'
          ) END AS connected_resigned_at
        FROM latest_joined lj
        JOIN board_seats here
          ON here.ticker = lj.ticker AND here.person_id = lj.person_id
        JOIN (
          SELECT ticker, person_id, designation, 1 AS is_current, NULL AS last_id
          FROM board_seats
          ${formerSeats}
        ) o
          ON o.person_id = lj.person_id AND o.ticker <> lj.ticker
        JOIN company_metrics tm ON tm.ticker = lj.ticker
        JOIN company_metrics cm ON cm.ticker = o.ticker
        LEFT JOIN directors d ON d.person_id = lj.person_id
        LEFT JOIN companies c1 ON c1.ticker = lj.ticker
        LEFT JOIN companies c2 ON c2.ticker = o.ticker
        LEFT JOIN director_network dn ON dn.person_id = lj.person_id
        ${where}
      )`;
    const order =
      sort === "ratio"
        ? "market_cap_ratio DESC, event_date DESC, target_ticker, connected_ticker"
        : sort === "boards"
          ? "IFNULL(board_count, 0) DESC, market_cap_ratio DESC, target_ticker, connected_ticker"
          : "event_date DESC, market_cap_ratio DESC, target_ticker, connected_ticker";

    const edgeScope =
      aggregate === "targets" && minN10k > 0
        ? `FROM new_edges
           WHERE target_ticker IN (
             SELECT target_ticker FROM (
               SELECT
                 target_ticker,
                 COUNT(DISTINCT CASE WHEN connected_market_cap >= @large THEN connected_ticker END) AS n_10k
               FROM new_edges
               GROUP BY target_ticker
               HAVING n_10k >= @minN10k
             )
           )`
        : "FROM new_edges";
    if (minN10k > 0) params.minN10k = minN10k;

    if (aggregate === "gap") {
      params.minConnected = minConnected;
      params.minRatio = minRatio;
      if (q) params.like = likePattern(q);
      const having: string[] = ["1=1"];
      if (minConnected > 0) {
        having.push("MAX(connected_market_cap) >= @minConnected");
      }
      if (minRatio > 0) {
        having.push("MAX(market_cap_ratio) >= @minRatio");
      }
      const gapCte = `${cte.trim()},
      capital_gap AS (
        SELECT
          target_ticker,
          MAX(target_company) AS target_company,
          MAX(target_market_cap) AS target_market_cap,
          COUNT(DISTINCT connected_ticker) AS connected_companies,
          COUNT(DISTINCT CASE WHEN connected_market_cap >= @large THEN connected_ticker END) AS n_10k,
          COUNT(DISTINCT CASE WHEN connected_market_cap >= @mid THEN connected_ticker END) AS n_25k,
          COUNT(DISTINCT CASE WHEN connected_market_cap >= @mega THEN connected_ticker END) AS n_50k,
          MAX(connected_market_cap) AS largest_connected_mcap,
          MAX(market_cap_ratio) AS largest_ratio,
          COUNT(DISTINCT CASE WHEN connection_type = 'cross_group' THEN connected_ticker END) AS cross_group_count,
          COUNT(DISTINCT person_id) AS multi_board_director_count
        FROM new_edges
        GROUP BY target_ticker
        HAVING ${having.join(" AND ")}
      )`;
      const gapSearch = q
        ? `WHERE (
             g.target_ticker LIKE @like ESCAPE '\\'
             OR IFNULL(g.target_company, '') LIKE @like ESCAPE '\\'
             OR EXISTS (
               SELECT 1 FROM new_edges e
               WHERE e.target_ticker = g.target_ticker
                 AND (
                   e.connected_ticker LIKE @like ESCAPE '\\'
                   OR IFNULL(e.connected_company, '') LIKE @like ESCAPE '\\'
                   OR IFNULL(e.director, '') LIKE @like ESCAPE '\\'
                 )
             )
           )`
        : "";
      const gapOrder =
        sort === "mcap"
          ? "largest_connected_mcap DESC, largest_ratio DESC, target_ticker"
          : sort === "connected"
            ? "connected_companies DESC, largest_ratio DESC, target_ticker"
            : sort === "n10k"
              ? "n_10k DESC, largest_ratio DESC, target_ticker"
              : sort === "n25k"
                ? "n_25k DESC, largest_ratio DESC, target_ticker"
                : sort === "n50k"
                  ? "n_50k DESC, largest_ratio DESC, target_ticker"
                  : sort === "cross"
                    ? "cross_group_count DESC, largest_ratio DESC, target_ticker"
                    : sort === "multi"
                      ? "multi_board_director_count DESC, largest_ratio DESC, target_ticker"
                      : "largest_ratio DESC, largest_connected_mcap DESC, target_ticker";
      const grouped = db
        .prepare(
          `${gapCte}
           SELECT * FROM capital_gap g
           ${gapSearch}
           ORDER BY ${gapOrder}`,
        )
        .all(params) as NewConnectionTargetRow[];
      const mcapHits = db
        .prepare(
          `${cte}
           SELECT e.target_ticker, e.connected_ticker, e.connected_company
           FROM new_edges e
           JOIN (
             SELECT target_ticker, MAX(connected_market_cap) AS mx
             FROM new_edges
             GROUP BY target_ticker
           ) m
             ON m.target_ticker = e.target_ticker
            AND e.connected_market_cap = m.mx`,
        )
        .all(params) as Array<{
        target_ticker: string;
        connected_ticker: string;
        connected_company: string | null;
      }>;
      const maxByTarget = new Map<
        string,
        { connected_ticker: string; connected_company: string | null }
      >();
      for (const hit of mcapHits) {
        if (!maxByTarget.has(hit.target_ticker)) {
          maxByTarget.set(hit.target_ticker, hit);
        }
      }
      for (const row of grouped) {
        const hit = maxByTarget.get(row.target_ticker);
        row.largest_connected_ticker = hit?.connected_ticker ?? null;
        row.largest_connected_company = hit?.connected_company ?? null;
        row.cross_group_count = Number(row.cross_group_count || 0);
        row.multi_board_director_count = Number(
          row.multi_board_director_count || 0,
        );
      }
      const stats = db
        .prepare(
          `${gapCte}
           SELECT
             (SELECT COUNT(*) FROM capital_gap g ${gapSearch}) AS unique_targets,
             COUNT(*) AS edges,
             COUNT(DISTINCT e.person_id) AS unique_directors,
             SUM(CASE WHEN e.connection_type = 'cross_group' THEN 1 ELSE 0 END) AS cross_group,
             SUM(CASE WHEN e.connected_market_cap >= @mega THEN 1 ELSE 0 END) AS mega_connections,
             SUM(CASE WHEN e.connected_market_cap >= @large THEN 1 ELSE 0 END) AS n_10k_connections,
             SUM(CASE WHEN e.connected_market_cap >= @mid THEN 1 ELSE 0 END) AS n_25k_connections
           FROM new_edges e
           WHERE e.target_ticker IN (
             SELECT g.target_ticker FROM capital_gap g ${gapSearch}
           )`,
        )
        .get(params) as NewConnectionSummary;
      const total = grouped.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, pages);
      const start = (safePage - 1) * pageSize;
      return {
        rows: [],
        targets: grouped.slice(start, start + pageSize),
        total,
        page: safePage,
        pages,
        max_target_mcap: maxTarget,
        summary: {
          edges: Number(stats.edges || 0),
          unique_targets: Number(stats.unique_targets || 0),
          unique_directors: Number(stats.unique_directors || 0),
          cross_group: Number(stats.cross_group || 0),
          mega_connections: Number(stats.mega_connections || 0),
          n_10k_connections: Number(stats.n_10k_connections || 0),
          n_25k_connections: Number(stats.n_25k_connections || 0),
        },
      };
    }

    const summary = db
      .prepare(
        `${cte}
         SELECT
           COUNT(*) AS edges,
           COUNT(DISTINCT target_ticker) AS unique_targets,
           COUNT(DISTINCT person_id) AS unique_directors,
           SUM(CASE WHEN connection_type = 'cross_group' THEN 1 ELSE 0 END) AS cross_group,
           SUM(CASE WHEN connected_market_cap >= @mega THEN 1 ELSE 0 END) AS mega_connections
         ${edgeScope}`,
      )
      .get(params) as NewConnectionSummary;

    if (aggregate === "targets") {
      const having = minN10k > 0 ? "HAVING n_10k >= @minN10k" : "";
      const grouped = db
        .prepare(
          `${cte}
           SELECT
             target_ticker,
             MAX(target_company) AS target_company,
             MAX(target_market_cap) AS target_market_cap,
             COUNT(DISTINCT connected_ticker) AS connected_companies,
             COUNT(DISTINCT CASE WHEN connected_market_cap >= @large THEN connected_ticker END) AS n_10k,
             COUNT(DISTINCT CASE WHEN connected_market_cap >= @mid THEN connected_ticker END) AS n_25k,
             COUNT(DISTINCT CASE WHEN connected_market_cap >= @mega THEN connected_ticker END) AS n_50k,
             MAX(connected_market_cap) AS largest_connected_mcap,
             MAX(market_cap_ratio) AS largest_ratio,
             COUNT(DISTINCT CASE WHEN connection_type = 'cross_group' THEN connected_ticker END) AS cross_group_count,
             COUNT(DISTINCT CASE WHEN IFNULL(board_count, 0) >= 3 THEN person_id END) AS multi_board_director_count
           FROM new_edges
           GROUP BY target_ticker
           ${having}
           ORDER BY ${
             sort === "ratio"
               ? "largest_ratio DESC, largest_connected_mcap DESC, target_ticker"
               : "n_10k DESC, largest_ratio DESC, target_ticker"
           }`,
        )
        .all(params) as NewConnectionTargetRow[];
      const mcapHits = db
        .prepare(
          `${cte}
           SELECT e.target_ticker, e.connected_ticker, e.connected_company
           FROM new_edges e
           JOIN (
             SELECT target_ticker, MAX(connected_market_cap) AS mx
             FROM new_edges
             GROUP BY target_ticker
           ) m
             ON m.target_ticker = e.target_ticker
            AND e.connected_market_cap = m.mx`,
        )
        .all(params) as Array<{
        target_ticker: string;
        connected_ticker: string;
        connected_company: string | null;
      }>;
      const maxByTarget = new Map<
        string,
        { connected_ticker: string; connected_company: string | null }
      >();
      for (const hit of mcapHits) {
        if (!maxByTarget.has(hit.target_ticker)) {
          maxByTarget.set(hit.target_ticker, hit);
        }
      }
      for (const row of grouped) {
        const hit = maxByTarget.get(row.target_ticker);
        row.largest_connected_ticker = hit?.connected_ticker ?? null;
        row.largest_connected_company = hit?.connected_company ?? null;
        row.cross_group_count = Number(row.cross_group_count || 0);
        row.multi_board_director_count = Number(
          row.multi_board_director_count || 0,
        );
      }
      const total = grouped.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, pages);
      const start = (safePage - 1) * pageSize;
      return {
        rows: [],
        targets: grouped.slice(start, start + pageSize),
        total,
        page: safePage,
        pages,
        max_target_mcap: maxTarget,
        summary: {
          edges: Number(summary.edges || 0),
          unique_targets: Number(summary.unique_targets || 0),
          unique_directors: Number(summary.unique_directors || 0),
          cross_group: Number(summary.cross_group || 0),
          mega_connections: Number(summary.mega_connections || 0),
        },
      };
    }

    const total = Number(summary.edges || 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pages);
    const rows = db
      .prepare(
        `${cte}
         SELECT *
         FROM new_edges
         ORDER BY ${order}
         LIMIT @limit OFFSET @offset`,
      )
      .all({
        ...params,
        limit: pageSize,
        offset: (safePage - 1) * pageSize,
      }) as NewConnectionRow[];
    return {
      rows,
      targets: [],
      total,
      page: safePage,
      pages,
      max_target_mcap: maxTarget,
      summary: {
        edges: total,
        unique_targets: Number(summary.unique_targets || 0),
        unique_directors: Number(summary.unique_directors || 0),
        cross_group: Number(summary.cross_group || 0),
        mega_connections: Number(summary.mega_connections || 0),
      },
    };
  } finally {
    db.close();
  }
}

/** Exclusive upper bound for Tiny Capital Gap (canonical universe is still < ₹5,000 Cr). */
export const TINY_CAPITAL_GAP_MAX_TARGET_MCAP = 1000;

export type TinyCapitalGapBand = "lt100" | "100_250" | "250_500" | "500_1000";

export function tinyCapitalGapBand(
  mcap: number | null,
): TinyCapitalGapBand | null {
  if (mcap == null || mcap <= 0 || mcap >= TINY_CAPITAL_GAP_MAX_TARGET_MCAP) {
    return null;
  }
  if (mcap < 100) return "lt100";
  if (mcap < 250) return "100_250";
  if (mcap < 500) return "250_500";
  return "500_1000";
}

export type TinyCapitalGapSort =
  | "mcap"
  | "connected"
  | "directors"
  | "largest"
  | "ratio"
  | "n10k"
  | "n25k"
  | "n50k"
  | "cross";

export type TinyCapitalGapRow = {
  target_ticker: string;
  target_company: string | null;
  target_market_cap: number | null;
  band: TinyCapitalGapBand;
  connected_company_count: number;
  distinct_director_count: number;
  max_connected_market_cap: number | null;
  largest_connected_ticker: string | null;
  largest_connected_company: string | null;
  max_market_cap_ratio: number | null;
  connected_1000cr_count: number;
  connected_5000cr_count: number;
  connected_10000cr_count: number;
  connected_25000cr_count: number;
  connected_50000cr_count: number;
  connected_100000cr_count: number;
  cross_group_count: number;
  same_group_count: number;
  unclassified_count: number;
};

export type TinyCapitalGapSummary = {
  companies: number;
  band_lt100: number;
  band_100_250: number;
  band_250_500: number;
  band_500_1000: number;
  connected_10k: number;
  max_gap_50x: number;
  cross_group: number;
  canonical_edges: number;
  canonical_targets: number;
};

function aggregateTinyFromEdges(
  edges: NewConnectionRow[],
): TinyCapitalGapRow[] {
  type Acc = {
    company: string | null;
    mcap: number | null;
    tickers: Set<string>;
    people: Set<string>;
    maxMcap: number | null;
    maxTicker: string | null;
    maxCompany: string | null;
    maxRatio: number | null;
    n1k: Set<string>;
    n5k: Set<string>;
    n10k: Set<string>;
    n25k: Set<string>;
    n50k: Set<string>;
    n100k: Set<string>;
    xg: Set<string>;
    same: Set<string>;
    uncl: Set<string>;
  };
  const by = new Map<string, Acc>();
  for (const e of edges) {
    const band = tinyCapitalGapBand(e.target_market_cap);
    if (!band) continue;
    let acc = by.get(e.target_ticker);
    if (!acc) {
      acc = {
        company: e.target_company,
        mcap: e.target_market_cap,
        tickers: new Set(),
        people: new Set(),
        maxMcap: null,
        maxTicker: null,
        maxCompany: null,
        maxRatio: null,
        n1k: new Set(),
        n5k: new Set(),
        n10k: new Set(),
        n25k: new Set(),
        n50k: new Set(),
        n100k: new Set(),
        xg: new Set(),
        same: new Set(),
        uncl: new Set(),
      };
      by.set(e.target_ticker, acc);
    }
    acc.tickers.add(e.connected_ticker);
    acc.people.add(e.person_id);
    const cm = e.connected_market_cap;
    if (cm != null && (acc.maxMcap == null || cm > acc.maxMcap)) {
      acc.maxMcap = cm;
      acc.maxTicker = e.connected_ticker;
      acc.maxCompany = e.connected_company;
    }
    const ratio = e.market_cap_ratio;
    if (ratio != null && (acc.maxRatio == null || ratio > acc.maxRatio)) {
      acc.maxRatio = ratio;
    }
    if (cm != null && cm >= 1000) acc.n1k.add(e.connected_ticker);
    if (cm != null && cm >= 5000) acc.n5k.add(e.connected_ticker);
    if (cm != null && cm >= 10_000) acc.n10k.add(e.connected_ticker);
    if (cm != null && cm >= 25_000) acc.n25k.add(e.connected_ticker);
    if (cm != null && cm >= 50_000) acc.n50k.add(e.connected_ticker);
    if (cm != null && cm >= 100_000) acc.n100k.add(e.connected_ticker);
    if (e.connection_type === "cross_group") acc.xg.add(e.connected_ticker);
    else if (e.connection_type === "same_group") acc.same.add(e.connected_ticker);
    else acc.uncl.add(e.connected_ticker);
  }
  return [...by.entries()].map(([ticker, acc]) => {
    const band = tinyCapitalGapBand(acc.mcap)!;
    return {
      target_ticker: ticker,
      target_company: acc.company,
      target_market_cap: acc.mcap,
      band,
      connected_company_count: acc.tickers.size,
      distinct_director_count: acc.people.size,
      max_connected_market_cap: acc.maxMcap,
      largest_connected_ticker: acc.maxTicker,
      largest_connected_company: acc.maxCompany,
      max_market_cap_ratio: acc.maxRatio,
      connected_1000cr_count: acc.n1k.size,
      connected_5000cr_count: acc.n5k.size,
      connected_10000cr_count: acc.n10k.size,
      connected_25000cr_count: acc.n25k.size,
      connected_50000cr_count: acc.n50k.size,
      connected_100000cr_count: acc.n100k.size,
      cross_group_count: acc.xg.size,
      same_group_count: acc.same.size,
      unclassified_count: acc.uncl.size,
    };
  });
}

function canonicalNewConnectionOpts(days: number | null) {
  return {
    days,
    maxTargetMcap: DISCOVERY_MAX_TARGET_MCAP ?? 5000,
    includeFormerSeats: false as const,
    pageSize: 200,
  };
}

export function loadTinyCapitalGap(opts?: {
  q?: string | null;
  page?: number;
  pageSize?: number;
  days?: number | null;
  band?: TinyCapitalGapBand | "all";
  minConnectedMcap?: number;
  minRatio?: number;
  cross?: "any" | "yes" | "no";
  minConnectedCompanies?: number;
  minDirectors?: number;
  sort?: TinyCapitalGapSort;
}): {
  rows: TinyCapitalGapRow[];
  total: number;
  page: number;
  pages: number;
  summary: TinyCapitalGapSummary;
  edges: NewConnectionRow[];
} {
  const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
  const page = Math.max(1, opts?.page ?? 1);
  const days = opts?.days === undefined ? 180 : opts.days;
  const base = canonicalNewConnectionOpts(days);
  const canonical = loadNewConnections({ ...base, aggregate: "gap" });
  const edgePage = loadNewConnections(base);
  const rows = aggregateTinyFromEdges(edgePage.rows);
  const summary: TinyCapitalGapSummary = {
    companies: rows.length,
    band_lt100: rows.filter((r) => r.band === "lt100").length,
    band_100_250: rows.filter((r) => r.band === "100_250").length,
    band_250_500: rows.filter((r) => r.band === "250_500").length,
    band_500_1000: rows.filter((r) => r.band === "500_1000").length,
    connected_10k: rows.filter((r) => r.connected_10000cr_count > 0).length,
    max_gap_50x: rows.filter((r) => (r.max_market_cap_ratio ?? 0) >= 50).length,
    cross_group: rows.filter((r) => r.cross_group_count > 0).length,
    canonical_edges: canonical.summary.edges,
    canonical_targets: canonical.summary.unique_targets,
  };
  const q = (opts?.q || "").trim().toLowerCase();
  const band = opts?.band && opts.band !== "all" ? opts.band : null;
  const minConn = opts?.minConnectedMcap ?? 0;
  const minRatio = opts?.minRatio ?? 0;
  const cross = opts?.cross || "any";
  const minCos = opts?.minConnectedCompanies ?? 0;
  const minDirs = opts?.minDirectors ?? 0;
  const edgesByTarget = new Map<string, NewConnectionRow[]>();
  for (const e of edgePage.rows) {
    if (!tinyCapitalGapBand(e.target_market_cap)) continue;
    const list = edgesByTarget.get(e.target_ticker) || [];
    list.push(e);
    edgesByTarget.set(e.target_ticker, list);
  }
  let filtered = rows.filter((r) => {
    if (band && r.band !== band) return false;
    if (minConn > 0 && (r.max_connected_market_cap ?? 0) < minConn) return false;
    if (minRatio > 0 && (r.max_market_cap_ratio ?? 0) < minRatio) return false;
    if (cross === "yes" && r.cross_group_count <= 0) return false;
    if (cross === "no" && r.cross_group_count > 0) return false;
    if (minCos > 0 && r.connected_company_count < minCos) return false;
    if (minDirs > 0 && r.distinct_director_count < minDirs) return false;
    if (q) {
      if (r.target_ticker.toLowerCase().includes(q)) return true;
      if ((r.target_company || "").toLowerCase().includes(q)) return true;
      const eds = edgesByTarget.get(r.target_ticker) || [];
      if (
        eds.some(
          (e) =>
            e.director.toLowerCase().includes(q) ||
            e.person_id.toLowerCase().includes(q) ||
            e.connected_ticker.toLowerCase().includes(q) ||
            (e.connected_company || "").toLowerCase().includes(q),
        )
      ) {
        return true;
      }
      return false;
    }
    return true;
  });
  const sort = opts?.sort || "mcap";
  filtered.sort((a, b) => {
    const tie = a.target_ticker.localeCompare(b.target_ticker);
    if (sort === "connected") {
      return b.connected_company_count - a.connected_company_count || tie;
    }
    if (sort === "directors") {
      return b.distinct_director_count - a.distinct_director_count || tie;
    }
    if (sort === "largest") {
      return (b.max_connected_market_cap ?? 0) - (a.max_connected_market_cap ?? 0) || tie;
    }
    if (sort === "ratio") {
      return (b.max_market_cap_ratio ?? 0) - (a.max_market_cap_ratio ?? 0) || tie;
    }
    if (sort === "n10k") {
      return b.connected_10000cr_count - a.connected_10000cr_count || tie;
    }
    if (sort === "n25k") {
      return b.connected_25000cr_count - a.connected_25000cr_count || tie;
    }
    if (sort === "n50k") {
      return b.connected_50000cr_count - a.connected_50000cr_count || tie;
    }
    if (sort === "cross") {
      return b.cross_group_count - a.cross_group_count || tie;
    }
    return (a.target_market_cap ?? 0) - (b.target_market_cap ?? 0) || tie;
  });
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  return {
    rows: filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    total,
    page: safePage,
    pages,
    summary,
    edges: edgePage.rows.filter((e) => tinyCapitalGapBand(e.target_market_cap)),
  };
}

export function loadTinyCapitalGapDetail(
  ticker: string,
  opts?: { days?: number | null },
): {
  company: TinyCapitalGapRow | null;
  connections: NewConnectionRow[];
  directors: Array<{
    person_id: string;
    director: string;
    connected_companies: number;
  }>;
  groups: Array<{ group_key: string; group_name: string; tickers: string[] }>;
} {
  const key = ticker.trim().toUpperCase();
  const empty = {
    company: null as TinyCapitalGapRow | null,
    connections: [] as NewConnectionRow[],
    directors: [] as Array<{
      person_id: string;
      director: string;
      connected_companies: number;
    }>,
    groups: [] as Array<{ group_key: string; group_name: string; tickers: string[] }>,
  };
  if (!key) return empty;
  const days = opts?.days === undefined ? 180 : opts.days;
  const all = loadTinyCapitalGap({ days, pageSize: 200 });
  const company = all.rows.find((r) => r.target_ticker === key) ?? null;
  if (!company) return empty;
  const connections = all.edges
    .filter((e) => e.target_ticker === key)
    .sort(
      (a, b) =>
        (b.market_cap_ratio ?? 0) - (a.market_cap_ratio ?? 0) ||
        a.connected_ticker.localeCompare(b.connected_ticker),
    );
  const dirMap = new Map<string, { director: string; tickers: Set<string> }>();
  for (const e of connections) {
    let d = dirMap.get(e.person_id);
    if (!d) {
      d = { director: e.director, tickers: new Set() };
      dirMap.set(e.person_id, d);
    }
    d.tickers.add(e.connected_ticker);
  }
  const directors = [...dirMap.entries()].map(([person_id, d]) => ({
    person_id,
    director: d.director,
    connected_companies: d.tickers.size,
  }));
  directors.sort((a, b) => b.connected_companies - a.connected_companies || a.director.localeCompare(b.director));
  const tickers = [key, ...connections.map((e) => e.connected_ticker)];
  const db = openSqliteNamed("governance.db", { wal: true });
  try {
    ensureCompanyGroupsTable(db);
    const placeholders = tickers.map(() => "?").join(",");
    const groupRows = db
      .prepare(
        `SELECT ticker, group_key, group_name FROM company_groups
         WHERE ticker IN (${placeholders})
         ORDER BY group_name, group_key, ticker`,
      )
      .all(...tickers) as Array<{
      ticker: string;
      group_key: string;
      group_name: string;
    }>;
    const gmap = new Map<string, { group_name: string; tickers: string[] }>();
    for (const g of groupRows) {
      let row = gmap.get(g.group_key);
      if (!row) {
        row = { group_name: g.group_name, tickers: [] };
        gmap.set(g.group_key, row);
      }
      if (!row.tickers.includes(g.ticker)) row.tickers.push(g.ticker);
    }
    const groups = [...gmap.entries()].map(([group_key, row]) => ({
      group_key,
      group_name: row.group_name,
      tickers: row.tickers,
    }));
    return { company, connections, directors, groups };
  } finally {
    db.close();
  }
}

export type DirectorHubSort =
  | "boards"
  | "groups"
  | "largest"
  | "smallest"
  | "spread"
  | "new"
  | "cross";

export type DirectorHubRow = {
  person_id: string;
  director: string;
  boards: number;
  groups: number;
  largest_mcap: number | null;
  smallest_mcap: number | null;
  mcap_spread: number | null;
  new_connections: number;
  /** Distinct current boards that have a group while the director also sits on another grouped board in a different group. Unclassified boards are omitted. */
  cross_group: number;
};

export type DirectorHubSeatRow = {
  ticker: string;
  company: string | null;
  market_cap: number | null;
  group_name: string | null;
  designation: string | null;
};

export type DirectorHubSummary = {
  directors: number;
  boards_3: number;
  boards_5: number;
  boards_7: number;
  groups_2: number;
  cross_group: number;
};

const CANONICAL_NEW_CONNECTION_DAYS = 180;

/**
 * Canonical latest-join × current other seats, matching loadNewConnections
 * defaults (180 days, target mcap < DISCOVERY_MAX_TARGET_MCAP, no former seats).
 */
function canonicalNewEdgesSql(): string {
  const maxTarget = DISCOVERY_MAX_TARGET_MCAP ?? 5000;
  return `
      latest_joined AS (
        SELECT e.ticker, e.person_id, e.director_name, e.detected_at, e.event_type, e.id
        FROM board_seat_events e
        JOIN (
          SELECT ticker, person_id, MAX(id) AS id
          FROM board_seat_events
          WHERE event_type = 'joined'
          GROUP BY ticker, person_id
        ) x ON x.id = e.id
      ),
      canonical_new_edges AS (
        SELECT
          lj.ticker AS target_ticker,
          lj.person_id,
          o.ticker AS connected_ticker
        FROM latest_joined lj
        JOIN board_seats here
          ON here.ticker = lj.ticker AND here.person_id = lj.person_id
        JOIN board_seats o
          ON o.person_id = lj.person_id AND o.ticker <> lj.ticker
        JOIN company_metrics tm ON tm.ticker = lj.ticker
        JOIN company_metrics cm ON cm.ticker = o.ticker
        WHERE tm.market_cap > 0 AND cm.market_cap > 0
          AND tm.market_cap < ${maxTarget}
          AND julianday('now') - julianday(lj.detected_at) <= ${CANONICAL_NEW_CONNECTION_DAYS}
      )`;
}

export function loadDirectorHubs(opts?: {
  q?: string | null;
  page?: number;
  pageSize?: number;
  minBoards?: number;
  minGroups?: number;
  minSpread?: number;
  cross?: "any" | "yes" | "no";
  sort?: DirectorHubSort;
}): {
  rows: DirectorHubRow[];
  total: number;
  page: number;
  pages: number;
  summary: DirectorHubSummary;
} {
  const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
  const page = Math.max(1, opts?.page ?? 1);
  const q = (opts?.q || "").trim();
  const minBoards = Math.max(2, opts?.minBoards ?? 3);
  const minGroups = opts?.minGroups ?? 0;
  const minSpread = opts?.minSpread ?? 0;
  const cross = opts?.cross || "any";
  const sort: DirectorHubSort = opts?.sort || "boards";
  const db = openSqliteNamed("governance.db", { wal: true });
  try {
    ensureCompanyGroupsTable(db);
    const params: Record<string, string | number> = {
      minBoards,
      minGroups,
      minSpread,
    };
    const search = q
      ? `AND (
           IFNULL(h.director, '') LIKE @like ESCAPE '\\'
           OR EXISTS (
             SELECT 1 FROM board_seats s
             LEFT JOIN companies c ON c.ticker = s.ticker
             WHERE s.person_id = h.person_id
               AND (s.ticker LIKE @like ESCAPE '\\'
                    OR IFNULL(c.name, '') LIKE @like ESCAPE '\\')
           )
         )`
      : "";
    if (q) params.like = likePattern(q);
    const having: string[] = ["boards >= @minBoards"];
    if (minGroups > 0) having.push("groups >= @minGroups");
    if (minSpread > 0) having.push("IFNULL(mcap_spread, 0) >= @minSpread");
    if (cross === "yes") having.push("cross_group > 0");
    if (cross === "no") having.push("cross_group = 0");
    const order =
      sort === "groups"
        ? "groups DESC, boards DESC, director"
        : sort === "largest"
          ? "IFNULL(largest_mcap, 0) DESC, boards DESC, director"
          : sort === "smallest"
            ? "IFNULL(smallest_mcap, 0) DESC, boards DESC, director"
            : sort === "spread"
              ? "IFNULL(mcap_spread, 0) DESC, boards DESC, director"
              : sort === "new"
                ? "new_connections DESC, boards DESC, director"
                : sort === "cross"
                  ? "cross_group DESC, boards DESC, director"
                  : "boards DESC, groups DESC, director";
    const cte = `
      WITH ${canonicalNewEdgesSql()},
      seats AS (
        SELECT DISTINCT s.person_id, s.ticker, d.name AS director,
               m.market_cap
        FROM board_seats s
        JOIN directors d ON d.person_id = s.person_id
        LEFT JOIN company_metrics m ON m.ticker = s.ticker
      ),
      dir_groups AS (
        SELECT s.person_id, COUNT(DISTINCT g.group_key) AS groups
        FROM seats s
        JOIN company_groups g ON g.ticker = s.ticker
        GROUP BY s.person_id
      ),
      dir_cross AS (
        SELECT s.person_id, COUNT(DISTINCT s.ticker) AS cross_group
        FROM seats s
        JOIN company_groups g ON g.ticker = s.ticker
        JOIN dir_groups dg ON dg.person_id = s.person_id AND dg.groups >= 2
        GROUP BY s.person_id
        HAVING COUNT(DISTINCT s.ticker) >= 2
      ),
      dir_new AS (
        SELECT person_id,
               COUNT(DISTINCT target_ticker || '|' || connected_ticker) AS new_connections
        FROM canonical_new_edges
        GROUP BY person_id
      ),
      hubs AS (
        SELECT
          s.person_id,
          MAX(s.director) AS director,
          COUNT(DISTINCT s.ticker) AS boards,
          IFNULL(dg.groups, 0) AS groups,
          MAX(CASE WHEN s.market_cap > 0 THEN s.market_cap END) AS largest_mcap,
          MIN(CASE WHEN s.market_cap > 0 THEN s.market_cap END) AS smallest_mcap,
          CASE
            WHEN MAX(CASE WHEN s.market_cap > 0 THEN s.market_cap END) > 0
             AND MIN(CASE WHEN s.market_cap > 0 THEN s.market_cap END) > 0
            THEN ROUND(
              MAX(CASE WHEN s.market_cap > 0 THEN s.market_cap END) /
              MIN(CASE WHEN s.market_cap > 0 THEN s.market_cap END),
              1
            )
            ELSE NULL
          END AS mcap_spread,
          IFNULL(dn.new_connections, 0) AS new_connections,
          IFNULL(dc.cross_group, 0) AS cross_group
        FROM seats s
        LEFT JOIN dir_groups dg ON dg.person_id = s.person_id
        LEFT JOIN dir_new dn ON dn.person_id = s.person_id
        LEFT JOIN dir_cross dc ON dc.person_id = s.person_id
        GROUP BY s.person_id
        HAVING COUNT(DISTINCT s.ticker) >= 2
      )`;
    const summary = db
      .prepare(
        `${cte}
         SELECT
           COUNT(*) AS directors,
           SUM(CASE WHEN boards >= 3 THEN 1 ELSE 0 END) AS boards_3,
           SUM(CASE WHEN boards >= 5 THEN 1 ELSE 0 END) AS boards_5,
           SUM(CASE WHEN boards >= 7 THEN 1 ELSE 0 END) AS boards_7,
           SUM(CASE WHEN groups >= 2 THEN 1 ELSE 0 END) AS groups_2,
           SUM(CASE WHEN cross_group > 0 THEN 1 ELSE 0 END) AS cross_group
         FROM hubs h
         WHERE 1=1 ${search}`,
      )
      .get(params) as DirectorHubSummary;
    const total = (
      db
        .prepare(
          `${cte}
           SELECT COUNT(*) AS n FROM hubs h
           WHERE ${having.join(" AND ")} ${search}`,
        )
        .get(params) as { n: number }
    ).n;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pages);
    const rows = db
      .prepare(
        `${cte}
         SELECT * FROM hubs h
         WHERE ${having.join(" AND ")} ${search}
         ORDER BY ${order}
         LIMIT @limit OFFSET @offset`,
      )
      .all({
        ...params,
        limit: pageSize,
        offset: (safePage - 1) * pageSize,
      }) as DirectorHubRow[];
    return {
      rows,
      total,
      page: safePage,
      pages,
      summary: {
        directors: Number(summary.directors || 0),
        boards_3: Number(summary.boards_3 || 0),
        boards_5: Number(summary.boards_5 || 0),
        boards_7: Number(summary.boards_7 || 0),
        groups_2: Number(summary.groups_2 || 0),
        cross_group: Number(summary.cross_group || 0),
      },
    };
  } finally {
    db.close();
  }
}

export function loadDirectorHubSeats(personId: string): DirectorHubSeatRow[] {
  const id = (personId || "").trim();
  if (!id) return [];
  const db = openSqliteNamed("governance.db", { wal: true });
  try {
    ensureCompanyGroupsTable(db);
    return db
      .prepare(
        `SELECT
           s.ticker,
           c.name AS company,
           m.market_cap,
           (
             SELECT GROUP_CONCAT(DISTINCT g.group_name)
             FROM company_groups g
             WHERE g.ticker = s.ticker
           ) AS group_name,
           s.designation
         FROM board_seats s
         LEFT JOIN companies c ON c.ticker = s.ticker
         LEFT JOIN company_metrics m ON m.ticker = s.ticker
         WHERE s.person_id = ?
         ORDER BY CASE WHEN m.market_cap > 0 THEN m.market_cap ELSE 0 END DESC, s.ticker`,
      )
      .all(id) as DirectorHubSeatRow[];
  } finally {
    db.close();
  }
}

/**
 * Current-seat cross-group bridges: same person_id, two grouped tickers that
 * share no group_key, normalized ticker_a < ticker_b. Unclassified companies
 * are excluded. Independent of new_edges / board_seat_events.
 */
function crossGroupPairsCte(): string {
  return `
    WITH seats AS (
      SELECT DISTINCT
        bs.person_id,
        bs.ticker,
        IFNULL(d.name, bs.person_id) AS director,
        c.name AS company,
        cm.market_cap
      FROM board_seats bs
      JOIN company_groups cg ON cg.ticker = bs.ticker
      LEFT JOIN directors d ON d.person_id = bs.person_id
      LEFT JOIN companies c ON c.ticker = bs.ticker
      LEFT JOIN company_metrics cm ON cm.ticker = bs.ticker
    ),
    pairs AS (
      SELECT
        a.person_id,
        a.director,
        a.ticker AS company_a_ticker,
        a.company AS company_a,
        a.market_cap AS company_a_mcap,
        b.ticker AS company_b_ticker,
        b.company AS company_b,
        b.market_cap AS company_b_mcap
      FROM seats a
      JOIN seats b
        ON b.person_id = a.person_id
       AND a.ticker < b.ticker
      WHERE NOT EXISTS (
        SELECT 1
        FROM company_groups ga
        JOIN company_groups gb ON gb.group_key = ga.group_key
        WHERE ga.ticker = a.ticker AND gb.ticker = b.ticker
      )
    )`;
}

export type CrossGroupPane = "groups" | "companies" | "directors";

export type CrossGroupSummary = {
  relationships: number;
  directors: number;
  companies: number;
  group_pairs: number;
  groups: number;
};

export type CrossGroupPairRow = {
  group_a_key: string;
  group_a: string;
  group_b_key: string;
  group_b: string;
  directors: number;
  companies: number;
  relationships: number;
  largest_mcap: number | null;
  smallest_mcap: number | null;
};

export type CrossGroupCompanyRow = {
  ticker: string;
  company: string | null;
  market_cap: number | null;
  group_name: string | null;
  connected_groups: number;
  cross_group_companies: number;
  cross_group_directors: number;
  largest_connected_mcap: number | null;
  bridge_directors: string | null;
};

export type CrossGroupDirectorRow = {
  person_id: string;
  director: string;
  boards: number;
  groups: number;
  cross_group_groups: number;
  cross_group_companies: number;
  cross_group_relationships: number;
};

export type CrossGroupEdgeRow = {
  person_id: string;
  director: string;
  company_a_ticker: string;
  company_a: string | null;
  company_a_mcap: number | null;
  group_a: string;
  company_b_ticker: string;
  company_b: string | null;
  company_b_mcap: number | null;
  group_b: string;
};

export type CrossGroupOption = { key: string; name: string };

export function loadCrossGroupNetwork(opts?: {
  pane?: CrossGroupPane;
  q?: string | null;
  page?: number;
  pageSize?: number;
  groupKey?: string | null;
  minMcap?: number;
  minXgCompanies?: number;
}): {
  pane: CrossGroupPane;
  summary: CrossGroupSummary;
  pairs: CrossGroupPairRow[];
  companies: CrossGroupCompanyRow[];
  directors: CrossGroupDirectorRow[];
  groups: CrossGroupOption[];
  total: number;
  page: number;
  pages: number;
} {
  const pane: CrossGroupPane =
    opts?.pane === "companies" || opts?.pane === "directors"
      ? opts.pane
      : "groups";
  const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
  const page = Math.max(1, opts?.page ?? 1);
  const q = (opts?.q || "").trim();
  const groupKey = (opts?.groupKey || "").trim();
  const minMcap = opts?.minMcap ?? 0;
  const minXg = opts?.minXgCompanies ?? 0;
  const db = openSqliteNamed("governance.db", { wal: true });
  try {
    ensureCompanyGroupsTable(db);
    const cte = crossGroupPairsCte();
    const params: Record<string, string | number> = {};
    if (q) params.like = likePattern(q);
    if (groupKey) params.groupKey = groupKey;
    if (minMcap > 0) params.minMcap = minMcap;
    if (minXg > 0) params.minXg = minXg;

    const summary = db
      .prepare(
        `${cte},
         gp AS (
           SELECT DISTINCT
             CASE WHEN ga.group_key < gb.group_key THEN ga.group_key ELSE gb.group_key END AS g1,
             CASE WHEN ga.group_key < gb.group_key THEN gb.group_key ELSE ga.group_key END AS g2
           FROM pairs p
           JOIN company_groups ga ON ga.ticker = p.company_a_ticker
           JOIN company_groups gb ON gb.ticker = p.company_b_ticker
           WHERE ga.group_key <> gb.group_key
         )
         SELECT
           (SELECT COUNT(*) FROM pairs) AS relationships,
           (SELECT COUNT(DISTINCT person_id) FROM pairs) AS directors,
           (SELECT COUNT(*) FROM (
              SELECT company_a_ticker AS t FROM pairs
              UNION SELECT company_b_ticker FROM pairs
           )) AS companies,
           (SELECT COUNT(*) FROM gp) AS group_pairs,
           (SELECT COUNT(*) FROM (
              SELECT g1 AS g FROM gp UNION SELECT g2 FROM gp
           )) AS groups`,
      )
      .get() as CrossGroupSummary;

    const groupOptions = db
      .prepare(
        `${cte},
         keys AS (
           SELECT DISTINCT g.group_key AS key, g.group_name AS name
           FROM pairs p
           JOIN company_groups g
             ON g.ticker IN (p.company_a_ticker, p.company_b_ticker)
         )
         SELECT key, name FROM keys ORDER BY name, key`,
      )
      .all() as CrossGroupOption[];

    const empty = {
      pane,
      summary: {
        relationships: Number(summary.relationships || 0),
        directors: Number(summary.directors || 0),
        companies: Number(summary.companies || 0),
        group_pairs: Number(summary.group_pairs || 0),
        groups: Number(summary.groups || 0),
      },
      pairs: [] as CrossGroupPairRow[],
      companies: [] as CrossGroupCompanyRow[],
      directors: [] as CrossGroupDirectorRow[],
      groups: groupOptions,
      total: 0,
      page: 1,
      pages: 1,
    };

    if (pane === "groups") {
      const agg = db
        .prepare(
          `${cte},
           bridge AS (
             SELECT
               CASE WHEN ga.group_key < gb.group_key THEN ga.group_key ELSE gb.group_key END AS g1,
               CASE WHEN ga.group_key < gb.group_key THEN gb.group_key ELSE ga.group_key END AS g2,
               p.person_id,
               p.director,
               p.company_a_ticker,
               p.company_a,
               p.company_a_mcap,
               p.company_b_ticker,
               p.company_b,
               p.company_b_mcap
             FROM pairs p
             JOIN company_groups ga ON ga.ticker = p.company_a_ticker
             JOIN company_groups gb ON gb.ticker = p.company_b_ticker
             WHERE ga.group_key <> gb.group_key
           ),
           cos AS (
             SELECT g1, g2, t FROM (
               SELECT g1, g2, company_a_ticker AS t FROM bridge
               UNION
               SELECT g1, g2, company_b_ticker FROM bridge
             )
           )
           SELECT
             b.g1 AS group_a_key,
             IFNULL((SELECT group_name FROM company_groups WHERE group_key = b.g1 LIMIT 1), b.g1) AS group_a,
             b.g2 AS group_b_key,
             IFNULL((SELECT group_name FROM company_groups WHERE group_key = b.g2 LIMIT 1), b.g2) AS group_b,
             COUNT(DISTINCT b.person_id) AS directors,
             (SELECT COUNT(*) FROM cos c WHERE c.g1 = b.g1 AND c.g2 = b.g2) AS companies,
             COUNT(DISTINCT b.person_id || '|' || b.company_a_ticker || '|' || b.company_b_ticker) AS relationships,
             MAX(CASE WHEN IFNULL(b.company_a_mcap,0) >= IFNULL(b.company_b_mcap,0)
               THEN b.company_a_mcap ELSE b.company_b_mcap END) AS largest_mcap,
             MIN(CASE
               WHEN b.company_a_mcap > 0 AND (b.company_b_mcap IS NULL OR b.company_b_mcap <= 0 OR b.company_a_mcap <= b.company_b_mcap)
               THEN b.company_a_mcap
               WHEN b.company_b_mcap > 0 THEN b.company_b_mcap
             END) AS smallest_mcap
           FROM bridge b
           GROUP BY b.g1, b.g2
           ORDER BY directors DESC, relationships DESC, group_a, group_b`,
        )
        .all() as CrossGroupPairRow[];
      const qHits = new Set<string>();
      if (q) {
        const hits = db
          .prepare(
            `${cte}
             SELECT DISTINCT
               CASE WHEN ga.group_key < gb.group_key THEN ga.group_key ELSE gb.group_key END AS g1,
               CASE WHEN ga.group_key < gb.group_key THEN gb.group_key ELSE ga.group_key END AS g2
             FROM pairs p
             JOIN company_groups ga ON ga.ticker = p.company_a_ticker
             JOIN company_groups gb ON gb.ticker = p.company_b_ticker
             WHERE ga.group_key <> gb.group_key
               AND (
                 p.director LIKE @like ESCAPE '\\'
                 OR p.company_a_ticker LIKE @like ESCAPE '\\'
                 OR p.company_b_ticker LIKE @like ESCAPE '\\'
                 OR IFNULL(p.company_a,'') LIKE @like ESCAPE '\\'
                 OR IFNULL(p.company_b,'') LIKE @like ESCAPE '\\'
                 OR IFNULL(ga.group_name,'') LIKE @like ESCAPE '\\'
                 OR IFNULL(gb.group_name,'') LIKE @like ESCAPE '\\'
               )`,
          )
          .all({ like: likePattern(q) }) as Array<{ g1: string; g2: string }>;
        for (const h of hits) qHits.add(`${h.g1}|${h.g2}`);
      }
      const filtered = agg.filter((r) => {
        if (groupKey && r.group_a_key !== groupKey && r.group_b_key !== groupKey) {
          return false;
        }
        if (minMcap > 0 && (r.largest_mcap == null || r.largest_mcap < minMcap)) {
          return false;
        }
        if (minXg > 0 && r.companies < minXg) return false;
        if (q && !qHits.has(`${r.group_a_key}|${r.group_b_key}`)) return false;
        return true;
      });
      const total = filtered.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, pages);
      return {
        ...empty,
        pairs: filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
        total,
        page: safePage,
        pages,
      };
    }

    if (pane === "companies") {
      const all = db
        .prepare(
          `${cte},
           sides AS (
             SELECT person_id, director, company_a_ticker AS ticker,
                    company_a AS company, company_a_mcap AS market_cap,
                    company_b_ticker AS other, company_b_mcap AS other_mcap
             FROM pairs
             UNION ALL
             SELECT person_id, director, company_b_ticker, company_b, company_b_mcap,
                    company_a_ticker, company_a_mcap
             FROM pairs
           )
           SELECT
             s.ticker,
             MAX(s.company) AS company,
             MAX(s.market_cap) AS market_cap,
             (SELECT GROUP_CONCAT(DISTINCT g.group_name)
              FROM company_groups g WHERE g.ticker = s.ticker) AS group_name,
             (SELECT COUNT(DISTINCT g.group_key)
              FROM company_groups g
              JOIN sides s2 ON s2.other = g.ticker
              WHERE s2.ticker = s.ticker) AS connected_groups,
             COUNT(DISTINCT s.other) AS cross_group_companies,
             COUNT(DISTINCT s.person_id) AS cross_group_directors,
             MAX(s.other_mcap) AS largest_connected_mcap,
             GROUP_CONCAT(DISTINCT s.director) AS bridge_directors
           FROM sides s
           GROUP BY s.ticker`,
        )
        .all() as CrossGroupCompanyRow[];
      const groupTickers = new Set<string>();
      if (groupKey) {
        const gt = db
          .prepare(
            `${cte}
             SELECT DISTINCT t FROM (
               SELECT p.company_a_ticker AS t FROM pairs p
               JOIN company_groups g ON g.ticker IN (p.company_a_ticker, p.company_b_ticker)
               WHERE g.group_key = @groupKey
               UNION
               SELECT p.company_b_ticker FROM pairs p
               JOIN company_groups g ON g.ticker IN (p.company_a_ticker, p.company_b_ticker)
               WHERE g.group_key = @groupKey
             )`,
          )
          .all({ groupKey }) as Array<{ t: string }>;
        for (const row of gt) groupTickers.add(row.t);
      }
      const filtered = all.filter((r) => {
        if (groupKey && !groupTickers.has(r.ticker)) return false;
        if (minMcap > 0 && (r.market_cap == null || r.market_cap < minMcap)) {
          return false;
        }
        if (minXg > 0 && r.cross_group_companies < minXg) return false;
        if (q) {
          const blob =
            `${r.ticker} ${r.company || ""} ${r.group_name || ""} ${r.bridge_directors || ""}`.toLowerCase();
          if (!blob.includes(q.toLowerCase())) return false;
        }
        return true;
      });
      filtered.sort(
        (a, b) =>
          b.connected_groups - a.connected_groups ||
          b.cross_group_directors - a.cross_group_directors ||
          a.ticker.localeCompare(b.ticker),
      );
      const total = filtered.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, pages);
      return {
        ...empty,
        companies: filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
        total,
        page: safePage,
        pages,
      };
    }

    const allDirs = db
      .prepare(
        `${cte}
         SELECT
           p.person_id,
           MAX(p.director) AS director,
           (SELECT COUNT(DISTINCT ticker) FROM board_seats s WHERE s.person_id = p.person_id) AS boards,
           (SELECT COUNT(DISTINCT g.group_key)
            FROM board_seats s
            JOIN company_groups g ON g.ticker = s.ticker
            WHERE s.person_id = p.person_id) AS groups,
           (SELECT COUNT(DISTINCT g.group_key)
            FROM pairs p2
            JOIN company_groups g ON g.ticker IN (p2.company_a_ticker, p2.company_b_ticker)
            WHERE p2.person_id = p.person_id) AS cross_group_groups,
           (SELECT COUNT(*) FROM (
              SELECT company_a_ticker AS t FROM pairs p2 WHERE p2.person_id = p.person_id
              UNION
              SELECT company_b_ticker FROM pairs p2 WHERE p2.person_id = p.person_id
           )) AS cross_group_companies,
           COUNT(*) AS cross_group_relationships
         FROM pairs p
         GROUP BY p.person_id`,
      )
      .all() as CrossGroupDirectorRow[];
    const groupPeople = new Set<string>();
    const mcapPeople = new Set<string>();
    const qPeople = new Set<string>();
    if (groupKey) {
      for (const row of db
        .prepare(
          `${cte}
           SELECT DISTINCT p.person_id AS id FROM pairs p
           JOIN company_groups g ON g.ticker IN (p.company_a_ticker, p.company_b_ticker)
           WHERE g.group_key = @groupKey`,
        )
        .all({ groupKey }) as Array<{ id: string }>) {
        groupPeople.add(row.id);
      }
    }
    if (minMcap > 0) {
      for (const row of db
        .prepare(
          `${cte}
           SELECT DISTINCT person_id AS id FROM pairs
           WHERE IFNULL(company_a_mcap,0) >= @minMcap
              OR IFNULL(company_b_mcap,0) >= @minMcap`,
        )
        .all({ minMcap }) as Array<{ id: string }>) {
        mcapPeople.add(row.id);
      }
    }
    if (q) {
      for (const row of db
        .prepare(
          `${cte}
           SELECT DISTINCT p.person_id AS id FROM pairs p
           LEFT JOIN company_groups ga ON ga.ticker = p.company_a_ticker
           LEFT JOIN company_groups gb ON gb.ticker = p.company_b_ticker
           WHERE p.director LIKE @like ESCAPE '\\'
              OR p.company_a_ticker LIKE @like ESCAPE '\\'
              OR p.company_b_ticker LIKE @like ESCAPE '\\'
              OR IFNULL(p.company_a,'') LIKE @like ESCAPE '\\'
              OR IFNULL(p.company_b,'') LIKE @like ESCAPE '\\'
              OR IFNULL(ga.group_name,'') LIKE @like ESCAPE '\\'
              OR IFNULL(gb.group_name,'') LIKE @like ESCAPE '\\'`,
        )
        .all({ like: likePattern(q) }) as Array<{ id: string }>) {
        qPeople.add(row.id);
      }
    }
    const filtered = allDirs.filter((r) => {
      if (groupKey && !groupPeople.has(r.person_id)) return false;
      if (minMcap > 0 && !mcapPeople.has(r.person_id)) return false;
      if (minXg > 0 && r.cross_group_companies < minXg) return false;
      if (q && !qPeople.has(r.person_id)) return false;
      return true;
    });
    filtered.sort(
      (a, b) =>
        b.cross_group_relationships - a.cross_group_relationships ||
        b.cross_group_groups - a.cross_group_groups ||
        a.director.localeCompare(b.director),
    );
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pages);
    return {
      ...empty,
      directors: filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
      total,
      page: safePage,
      pages,
    };
  } finally {
    db.close();
  }
}

export function loadCrossGroupPairEdges(opts: {
  groupA: string;
  groupB: string;
}): CrossGroupEdgeRow[] {
  const a = (opts.groupA || "").trim();
  const b = (opts.groupB || "").trim();
  if (!a || !b) return [];
  const db = openSqliteNamed("governance.db", { wal: true });
  try {
    ensureCompanyGroupsTable(db);
    const cte = crossGroupPairsCte();
    return db
      .prepare(
        `${cte}
         SELECT
           p.person_id,
           p.director,
           p.company_a_ticker,
           p.company_a,
           p.company_a_mcap,
           CASE WHEN ga.group_key = @a THEN ga.group_name ELSE gb.group_name END AS group_a,
           p.company_b_ticker,
           p.company_b,
           p.company_b_mcap,
           CASE WHEN ga.group_key = @a THEN gb.group_name ELSE ga.group_name END AS group_b
         FROM pairs p
         JOIN company_groups ga ON ga.ticker = p.company_a_ticker
         JOIN company_groups gb ON gb.ticker = p.company_b_ticker
         WHERE (ga.group_key = @a AND gb.group_key = @b)
            OR (ga.group_key = @b AND gb.group_key = @a)
         GROUP BY p.person_id, p.company_a_ticker, p.company_b_ticker
         ORDER BY p.director, p.company_a_ticker, p.company_b_ticker`,
      )
      .all({ a, b }) as CrossGroupEdgeRow[];
  } finally {
    db.close();
  }
}

export type CompanyPair = {
  ticker_a: string;
  ticker_b: string;
  shared_directors: number;
};

/** Normalize an undirected company pair. Returns null for a self-pair. */
export function normalizeCompanyPair(
  a: string,
  b: string,
): { ticker_a: string; ticker_b: string } | null {
  if (a === b) return null;
  return a < b ? { ticker_a: a, ticker_b: b } : { ticker_a: b, ticker_b: a };
}

/**
 * Company–company edges from current seats: one undirected pair per
 * (ticker_a < ticker_b), with the count of distinct shared person_ids.
 */
export function companyPairsFromSeats(
  seats: Array<{ person_id: string; ticker: string }>,
): CompanyPair[] {
  const byPerson = new Map<string, Set<string>>();
  for (const s of seats) {
    let set = byPerson.get(s.person_id);
    if (!set) {
      set = new Set();
      byPerson.set(s.person_id, set);
    }
    set.add(s.ticker);
  }
  const counts = new Map<string, number>();
  for (const tickers of byPerson.values()) {
    const list = [...tickers].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = `${list[i]}|${list[j]}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return [...counts.entries()].map(([key, shared_directors]) => {
    const [ticker_a, ticker_b] = key.split("|");
    return { ticker_a, ticker_b, shared_directors };
  });
}

export type CompanyCluster = {
  /** Lexicographically smallest ticker in the component. */
  cluster: string;
  tickers: string[];
};

/**
 * Connected components of the undirected company graph.
 * Isolated tickers (no edges) are returned as size-1 components.
 */
export function connectedCompanyClusters(
  pairs: Array<{ ticker_a: string; ticker_b: string }>,
  tickers: string[],
): CompanyCluster[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x)!;
    if (p !== x) {
      const r = find(p);
      parent.set(x, r);
      return r;
    }
    return x;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const t of tickers) find(t);
  for (const p of pairs) {
    if (p.ticker_a === p.ticker_b) continue;
    union(p.ticker_a, p.ticker_b);
  }
  const groups = new Map<string, string[]>();
  for (const t of tickers) {
    const r = find(t);
    const list = groups.get(r);
    if (list) list.push(t);
    else groups.set(r, [t]);
  }
  return [...groups.values()].map((members) => {
    const tickersSorted = [...new Set(members)].sort();
    return { cluster: tickersSorted[0], tickers: tickersSorted };
  });
}

export function clusterDensity(companies: number, edges: number): number | null {
  if (companies < 2) return null;
  const possible = (companies * (companies - 1)) / 2;
  return Math.round((edges / possible) * 1000) / 10;
}

export function pairGroupType(
  a: string,
  b: string,
  keys: Map<string, Set<string>>,
): "same_group" | "cross_group" | "unclassified" {
  const ga = keys.get(a);
  const gb = keys.get(b);
  if (!ga?.size || !gb?.size) return "unclassified";
  for (const k of ga) {
    if (gb.has(k)) return "same_group";
  }
  return "cross_group";
}

export type NetworkClusterRow = {
  cluster: string;
  companies: number;
  companies_with_groups: number;
  companies_without_groups: number;
  directors: number;
  groups: number;
  direct_relationships: number;
  same_group_relationships: number;
  cross_group_relationships: number;
  unclassified_relationships: number;
  largest_mcap: number | null;
  smallest_mcap: number | null;
  total_mcap: number | null;
  density: number | null;
  multi_director_relationships: number;
  max_shared_directors: number;
};

export type NetworkClusterSummary = {
  clusters: number;
  companies: number;
  isolated_companies: number;
  directors: number;
  groups: number;
  governance_connections: number;
  cross_group_relationships: number;
};

export type NetworkClusterCompanyRow = {
  ticker: string;
  company: string | null;
  market_cap: number | null;
  group_name: string | null;
  directors_in_cluster: number;
  connections_in_cluster: number;
};

export type NetworkClusterDirectorRow = {
  person_id: string;
  director: string;
  boards_in_cluster: number;
  total_boards: number;
  groups_represented: number;
  companies_connected: number;
};

export type NetworkClusterConnectionRow = {
  ticker_a: string;
  company_a: string | null;
  mcap_a: number | null;
  group_a: string | null;
  ticker_b: string;
  company_b: string | null;
  mcap_b: number | null;
  group_b: string | null;
  shared_directors: number;
  shared_people: Array<{ person_id: string; director: string }>;
  relationship_type: "same_group" | "cross_group" | "unclassified";
};

export type NetworkClusterGroupRow = {
  group_key: string;
  group_name: string;
  companies: number;
  directors: number;
  connections: number;
  cross_group_connections: number;
};

export type NetworkClusterSharedDirector = {
  person_id: string;
  director: string;
  designation_a: string | null;
  designation_b: string | null;
};

type ClusterGraph = {
  pairs: CompanyPair[];
  clusters: CompanyCluster[];
  seats: Array<{ person_id: string; ticker: string; designation: string | null }>;
  names: Map<string, string>;
  companies: Map<string, { name: string | null; market_cap: number | null }>;
  groupKeys: Map<string, Set<string>>;
  groupNames: Map<string, string>;
  tickerGroups: Map<string, string>;
};

function loadClusterGraph(): ClusterGraph {
  const db = openSqliteNamed("governance.db", { wal: true });
  try {
    const seats = db
      .prepare(
        `SELECT DISTINCT person_id, ticker, designation FROM board_seats`,
      )
      .all() as Array<{
      person_id: string;
      ticker: string;
      designation: string | null;
    }>;
    const names = new Map(
      (
        db.prepare(`SELECT person_id, name FROM directors`).all() as Array<{
          person_id: string;
          name: string;
        }>
      ).map((r) => [r.person_id, r.name]),
    );
    const companies = new Map(
      (
        db
          .prepare(
            `SELECT c.ticker, c.name, m.market_cap
             FROM companies c
             LEFT JOIN company_metrics m ON m.ticker = c.ticker`,
          )
          .all() as Array<{
          ticker: string;
          name: string | null;
          market_cap: number | null;
        }>
      ).map((r) => [r.ticker, { name: r.name, market_cap: r.market_cap }]),
    );
    const groupKeys = new Map<string, Set<string>>();
    const groupNames = new Map<string, string>();
    const tickerGroups = new Map<string, string>();
    for (const g of db
      .prepare(`SELECT ticker, group_key, group_name FROM company_groups`)
      .all() as Array<{ ticker: string; group_key: string; group_name: string }>) {
      let set = groupKeys.get(g.ticker);
      if (!set) {
        set = new Set();
        groupKeys.set(g.ticker, set);
      }
      set.add(g.group_key);
      if (!groupNames.has(g.group_key)) groupNames.set(g.group_key, g.group_name);
      const shown = tickerGroups.get(g.ticker);
      tickerGroups.set(
        g.ticker,
        shown ? `${shown}, ${g.group_name}` : g.group_name,
      );
    }
    const pairs = companyPairsFromSeats(seats);
    const tickers = [...new Set(seats.map((s) => s.ticker))];
    const clusters = connectedCompanyClusters(pairs, tickers);
    return {
      pairs,
      clusters,
      seats,
      names,
      companies,
      groupKeys,
      groupNames,
      tickerGroups,
    };
  } finally {
    db.close();
  }
}

function clusterMetrics(
  cluster: CompanyCluster,
  graph: ClusterGraph,
): NetworkClusterRow {
  const set = new Set(cluster.tickers);
  const people = new Set<string>();
  const groups = new Set<string>();
  const mcaps: number[] = [];
  for (const s of graph.seats) {
    if (!set.has(s.ticker)) continue;
    people.add(s.person_id);
  }
  let companies_with_groups = 0;
  for (const t of cluster.tickers) {
    const keys = graph.groupKeys.get(t);
    if (keys && keys.size) {
      companies_with_groups += 1;
      for (const k of keys) groups.add(k);
    }
    const m = graph.companies.get(t)?.market_cap;
    if (m != null && m > 0) mcaps.push(m);
  }
  let edges = 0;
  let xg = 0;
  let same = 0;
  let unclassified = 0;
  let multi = 0;
  let maxShared = 0;
  for (const p of graph.pairs) {
    if (!set.has(p.ticker_a) || !set.has(p.ticker_b)) continue;
    edges += 1;
    maxShared = Math.max(maxShared, p.shared_directors);
    if (p.shared_directors >= 2) multi += 1;
    const rel = pairGroupType(p.ticker_a, p.ticker_b, graph.groupKeys);
    if (rel === "cross_group") xg += 1;
    else if (rel === "same_group") same += 1;
    else unclassified += 1;
  }
  return {
    cluster: cluster.cluster,
    companies: cluster.tickers.length,
    companies_with_groups,
    companies_without_groups: cluster.tickers.length - companies_with_groups,
    directors: people.size,
    groups: groups.size,
    direct_relationships: edges,
    same_group_relationships: same,
    cross_group_relationships: xg,
    unclassified_relationships: unclassified,
    largest_mcap: mcaps.length ? Math.max(...mcaps) : null,
    smallest_mcap: mcaps.length ? Math.min(...mcaps) : null,
    total_mcap: mcaps.length ? mcaps.reduce((a, b) => a + b, 0) : null,
    density: clusterDensity(cluster.tickers.length, edges),
    multi_director_relationships: multi,
    max_shared_directors: maxShared,
  };
}

export function loadNetworkClusters(opts?: {
  q?: string | null;
  qCompany?: string | null;
  qTicker?: string | null;
  qDirector?: string | null;
  qGroup?: string | null;
  page?: number;
  pageSize?: number;
  minCompanies?: number;
  minDirectors?: number;
  minGroups?: number;
  minConnections?: number;
  multiGroups?: boolean;
  cross?: "any" | "yes" | "no";
  minLargestMcap?: number;
}): {
  rows: NetworkClusterRow[];
  total: number;
  page: number;
  pages: number;
  summary: NetworkClusterSummary;
} {
  const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
  const page = Math.max(1, opts?.page ?? 1);
  const q = (opts?.q || "").trim().toLowerCase();
  const qCompany = (opts?.qCompany || "").trim().toLowerCase();
  const qTicker = (opts?.qTicker || "").trim().toLowerCase();
  const qDirector = (opts?.qDirector || "").trim().toLowerCase();
  const qGroup = (opts?.qGroup || "").trim().toLowerCase();
  const minCompanies = Math.max(2, opts?.minCompanies ?? 2);
  const minDirectors = opts?.minDirectors ?? 0;
  const minGroups = opts?.minGroups ?? 0;
  const minConnections = opts?.minConnections ?? 0;
  const multiGroups = opts?.multiGroups === true;
  const cross = opts?.cross || "any";
  const minLargest = opts?.minLargestMcap ?? 0;
  const graph = loadClusterGraph();
  const twoPlus = graph.clusters.filter((c) => c.tickers.length >= 2);
  const metrics = twoPlus.map((c) => clusterMetrics(c, graph));
  const summaryTickers = new Set(twoPlus.flatMap((c) => c.tickers));
  const summaryPeople = new Set<string>();
  const summaryGroups = new Set<string>();
  for (const s of graph.seats) {
    if (summaryTickers.has(s.ticker)) summaryPeople.add(s.person_id);
  }
  for (const t of summaryTickers) {
    const keys = graph.groupKeys.get(t);
    if (keys) for (const k of keys) summaryGroups.add(k);
  }
  const seatTickers = new Set(graph.seats.map((s) => s.ticker));
  const isolated = [...seatTickers].filter((t) => !summaryTickers.has(t)).length;
  const summary: NetworkClusterSummary = {
    clusters: twoPlus.length,
    companies: summaryTickers.size,
    isolated_companies: isolated,
    directors: summaryPeople.size,
    groups: summaryGroups.size,
    governance_connections: graph.pairs.length,
    cross_group_relationships: metrics.reduce(
      (n, r) => n + r.cross_group_relationships,
      0,
    ),
  };

  const clusterHasDirector = (tickers: Set<string>, needle: string): boolean => {
    if (!needle) return true;
    for (const s of graph.seats) {
      if (!tickers.has(s.ticker)) continue;
      const name = graph.names.get(s.person_id) || s.person_id;
      if (name.toLowerCase().includes(needle) || s.person_id.toLowerCase().includes(needle)) {
        return true;
      }
    }
    return false;
  };

  const clusterHasCompanyName = (tickers: string[], needle: string): boolean => {
    if (!needle) return true;
    for (const t of tickers) {
      const name = graph.companies.get(t)?.name || "";
      if (name.toLowerCase().includes(needle)) return true;
    }
    return false;
  };

  const clusterHasTicker = (tickers: string[], needle: string): boolean => {
    if (!needle) return true;
    return tickers.some((t) => t.toLowerCase().includes(needle));
  };

  const clusterHasGroup = (tickers: string[], needle: string): boolean => {
    if (!needle) return true;
    for (const t of tickers) {
      const g = graph.tickerGroups.get(t) || "";
      if (g.toLowerCase().includes(needle)) return true;
      const keys = graph.groupKeys.get(t);
      if (keys) {
        for (const k of keys) {
          if (k.toLowerCase().includes(needle)) return true;
          const gn = graph.groupNames.get(k) || "";
          if (gn.toLowerCase().includes(needle)) return true;
        }
      }
    }
    return false;
  };

  const matchAny = (row: NetworkClusterRow, cl: CompanyCluster): boolean => {
    if (!q) return true;
    if (row.cluster.toLowerCase().includes(q)) return true;
    if (clusterHasTicker(cl.tickers, q)) return true;
    if (clusterHasCompanyName(cl.tickers, q)) return true;
    if (clusterHasGroup(cl.tickers, q)) return true;
    return clusterHasDirector(new Set(cl.tickers), q);
  };

  const matchCluster = (row: NetworkClusterRow): boolean => {
    const cl = twoPlus.find((c) => c.cluster === row.cluster);
    if (!cl) return false;
    if (!matchAny(row, cl)) return false;
    if (!clusterHasCompanyName(cl.tickers, qCompany)) return false;
    if (!clusterHasTicker(cl.tickers, qTicker)) return false;
    if (!clusterHasGroup(cl.tickers, qGroup)) return false;
    if (!clusterHasDirector(new Set(cl.tickers), qDirector)) return false;
    return true;
  };

  const filtered = metrics.filter((r) => {
    if (r.companies < minCompanies) return false;
    if (minDirectors > 0 && r.directors < minDirectors) return false;
    if (minGroups > 0 && r.groups < minGroups) return false;
    if (minConnections > 0 && r.direct_relationships < minConnections) return false;
    if (multiGroups && r.groups < 2) return false;
    if (cross === "yes" && r.cross_group_relationships <= 0) return false;
    if (cross === "no" && r.cross_group_relationships > 0) return false;
    if (minLargest > 0 && (r.largest_mcap == null || r.largest_mcap < minLargest)) {
      return false;
    }
    return matchCluster(r);
  });
  filtered.sort(
    (a, b) => b.companies - a.companies || a.cluster.localeCompare(b.cluster),
  );
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  return {
    rows: filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    total,
    page: safePage,
    pages,
    summary,
  };
}

export function loadNetworkClusterDetail(cluster: string): {
  cluster: NetworkClusterRow | null;
  companies: NetworkClusterCompanyRow[];
  directors: NetworkClusterDirectorRow[];
  connections: NetworkClusterConnectionRow[];
  groups: NetworkClusterGroupRow[];
} {
  const key = (cluster || "").trim();
  const empty = {
    cluster: null as NetworkClusterRow | null,
    companies: [] as NetworkClusterCompanyRow[],
    directors: [] as NetworkClusterDirectorRow[],
    connections: [] as NetworkClusterConnectionRow[],
    groups: [] as NetworkClusterGroupRow[],
  };
  if (!key) return empty;
  const graph = loadClusterGraph();
  const found = graph.clusters.find((c) => c.cluster === key && c.tickers.length >= 2);
  if (!found) return empty;
  const set = new Set(found.tickers);
  const metrics = clusterMetrics(found, graph);

  const dirByTicker = new Map<string, Set<string>>();
  const tickerByDir = new Map<string, Set<string>>();
  const allBoards = new Map<string, Set<string>>();
  for (const s of graph.seats) {
    let all = allBoards.get(s.person_id);
    if (!all) {
      all = new Set();
      allBoards.set(s.person_id, all);
    }
    all.add(s.ticker);
    if (!set.has(s.ticker)) continue;
    let ds = dirByTicker.get(s.ticker);
    if (!ds) {
      ds = new Set();
      dirByTicker.set(s.ticker, ds);
    }
    ds.add(s.person_id);
    let ts = tickerByDir.get(s.person_id);
    if (!ts) {
      ts = new Set();
      tickerByDir.set(s.person_id, ts);
    }
    ts.add(s.ticker);
  }

  const connCount = new Map<string, number>();
  const connections: NetworkClusterConnectionRow[] = [];
  for (const p of graph.pairs) {
    if (!set.has(p.ticker_a) || !set.has(p.ticker_b)) continue;
    connCount.set(p.ticker_a, (connCount.get(p.ticker_a) || 0) + 1);
    connCount.set(p.ticker_b, (connCount.get(p.ticker_b) || 0) + 1);
    const peopleA = dirByTicker.get(p.ticker_a);
    const peopleB = dirByTicker.get(p.ticker_b);
    const shared_people: Array<{ person_id: string; director: string }> = [];
    if (peopleA && peopleB) {
      for (const pid of peopleA) {
        if (!peopleB.has(pid)) continue;
        shared_people.push({
          person_id: pid,
          director: graph.names.get(pid) || pid,
        });
      }
      shared_people.sort((a, b) => a.director.localeCompare(b.director));
    }
    connections.push({
      ticker_a: p.ticker_a,
      company_a: graph.companies.get(p.ticker_a)?.name ?? null,
      mcap_a: graph.companies.get(p.ticker_a)?.market_cap ?? null,
      group_a: graph.tickerGroups.get(p.ticker_a) ?? null,
      ticker_b: p.ticker_b,
      company_b: graph.companies.get(p.ticker_b)?.name ?? null,
      mcap_b: graph.companies.get(p.ticker_b)?.market_cap ?? null,
      group_b: graph.tickerGroups.get(p.ticker_b) ?? null,
      shared_directors: p.shared_directors,
      shared_people,
      relationship_type: pairGroupType(p.ticker_a, p.ticker_b, graph.groupKeys),
    });
  }
  connections.sort(
    (a, b) =>
      b.shared_directors - a.shared_directors ||
      a.ticker_a.localeCompare(b.ticker_a) ||
      a.ticker_b.localeCompare(b.ticker_b),
  );

  const companies = found.tickers.map((ticker) => ({
    ticker,
    company: graph.companies.get(ticker)?.name ?? null,
    market_cap: graph.companies.get(ticker)?.market_cap ?? null,
    group_name: graph.tickerGroups.get(ticker) ?? null,
    directors_in_cluster: dirByTicker.get(ticker)?.size ?? 0,
    connections_in_cluster: connCount.get(ticker) ?? 0,
  }));
  companies.sort(
    (a, b) =>
      (b.market_cap ?? 0) - (a.market_cap ?? 0) || a.ticker.localeCompare(b.ticker),
  );

  const directors: NetworkClusterDirectorRow[] = [...tickerByDir.entries()].map(
    ([person_id, tickers]) => {
      const groups = new Set<string>();
      for (const t of tickers) {
        const keys = graph.groupKeys.get(t);
        if (keys) for (const k of keys) groups.add(k);
      }
      return {
        person_id,
        director: graph.names.get(person_id) || person_id,
        boards_in_cluster: tickers.size,
        total_boards: allBoards.get(person_id)?.size ?? tickers.size,
        groups_represented: groups.size,
        companies_connected: tickers.size,
      };
    },
  );
  directors.sort(
    (a, b) =>
      b.boards_in_cluster - a.boards_in_cluster ||
      a.director.localeCompare(b.director),
  );

  const groupRows = new Map<
    string,
    { companies: Set<string>; directors: Set<string> }
  >();
  for (const t of found.tickers) {
    const keys = graph.groupKeys.get(t);
    if (!keys) continue;
    for (const k of keys) {
      let row = groupRows.get(k);
      if (!row) {
        row = { companies: new Set(), directors: new Set() };
        groupRows.set(k, row);
      }
      row.companies.add(t);
      for (const pid of dirByTicker.get(t) || []) row.directors.add(pid);
    }
  }
  const groups: NetworkClusterGroupRow[] = [...groupRows.entries()].map(
    ([group_key, row]) => {
      let connectionsN = 0;
      let xg = 0;
      for (const p of graph.pairs) {
        const aIn = row.companies.has(p.ticker_a);
        const bIn = row.companies.has(p.ticker_b);
        if (!aIn && !bIn) continue;
        if (aIn && bIn) connectionsN += 1;
        if (pairGroupType(p.ticker_a, p.ticker_b, graph.groupKeys) === "cross_group") {
          xg += 1;
        }
      }
      return {
        group_key,
        group_name: graph.groupNames.get(group_key) || group_key,
        companies: row.companies.size,
        directors: row.directors.size,
        connections: connectionsN,
        cross_group_connections: xg,
      };
    },
  );
  groups.sort((a, b) => b.companies - a.companies || a.group_name.localeCompare(b.group_name));

  return { cluster: metrics, companies, directors, connections, groups };
}

export function loadNetworkClusterSharedDirectors(
  tickerA: string,
  tickerB: string,
): {
  pair: NetworkClusterConnectionRow | null;
  directors: NetworkClusterSharedDirector[];
} {
  const norm = normalizeCompanyPair(tickerA.trim(), tickerB.trim());
  if (!norm) return { pair: null, directors: [] };
  const graph = loadClusterGraph();
  const pair = graph.pairs.find(
    (p) => p.ticker_a === norm.ticker_a && p.ticker_b === norm.ticker_b,
  );
  if (!pair) return { pair: null, directors: [] };
  const onA = new Map<string, string | null>();
  const onB = new Map<string, string | null>();
  for (const s of graph.seats) {
    if (s.ticker === pair.ticker_a) onA.set(s.person_id, s.designation);
    if (s.ticker === pair.ticker_b) onB.set(s.person_id, s.designation);
  }
  const directors: NetworkClusterSharedDirector[] = [];
  for (const [pid, desA] of onA) {
    if (!onB.has(pid)) continue;
    directors.push({
      person_id: pid,
      director: graph.names.get(pid) || pid,
      designation_a: desA,
      designation_b: onB.get(pid) ?? null,
    });
  }
  directors.sort((a, b) => a.director.localeCompare(b.director));
  return {
    pair: {
      ticker_a: pair.ticker_a,
      company_a: graph.companies.get(pair.ticker_a)?.name ?? null,
      mcap_a: graph.companies.get(pair.ticker_a)?.market_cap ?? null,
      group_a: graph.tickerGroups.get(pair.ticker_a) ?? null,
      ticker_b: pair.ticker_b,
      company_b: graph.companies.get(pair.ticker_b)?.name ?? null,
      mcap_b: graph.companies.get(pair.ticker_b)?.market_cap ?? null,
      group_b: graph.tickerGroups.get(pair.ticker_b) ?? null,
      shared_directors: pair.shared_directors,
      shared_people: directors.map((d) => ({
        person_id: d.person_id,
        director: d.director,
      })),
      relationship_type: pairGroupType(pair.ticker_a, pair.ticker_b, graph.groupKeys),
    },
    directors,
  };
}
