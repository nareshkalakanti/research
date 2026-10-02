/**
 * Board-seat network views on governance.db. The views are the only definition
 * of the counts; a high count marks a connector, not a quality signal.
 */
import type Database from "better-sqlite3";
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

/** Small targets linked through a director to other boards, by market_cap_ratio. */
export function loadNetworkDiscovery(opts?: {
  q?: string | null;
  page?: number;
  pageSize?: number;
  refresh?: boolean;
}): {
  rows: NetworkDiscoveryRow[];
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
