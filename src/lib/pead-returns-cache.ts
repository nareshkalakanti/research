import { openSqliteNamed } from "./sqlite-utils";

export type PeadReturnsRow = {
  ticker: string;
  returns_pct: number | null;
  daily_ret_pct: number | null;
  updated_at: string;
};

function db() {
  const handle = openSqliteNamed("metrics.db", { wal: true });
  handle.exec(`
    CREATE TABLE IF NOT EXISTS pead_returns (
      ticker TEXT PRIMARY KEY,
      returns_pct REAL,
      daily_ret_pct REAL,
      updated_at TEXT NOT NULL
    );
  `);
  return handle;
}

export function loadPeadReturnsMap(): Map<string, PeadReturnsRow> {
  const map = new Map<string, PeadReturnsRow>();
  try {
    const handle = db();
    try {
      const rows = handle
        .prepare(
          `SELECT ticker, returns_pct, daily_ret_pct, updated_at FROM pead_returns`,
        )
        .all() as PeadReturnsRow[];
      for (const row of rows) {
        map.set(row.ticker.toUpperCase(), row);
      }
    } finally {
      handle.close();
    }
  } catch {
    /* missing db */
  }
  return map;
}

export function savePeadReturns(
  ticker: string,
  returns_pct: number | null,
  daily_ret_pct: number | null,
): void {
  const handle = db();
  try {
    handle
      .prepare(
        `INSERT INTO pead_returns (ticker, returns_pct, daily_ret_pct, updated_at)
         VALUES (@ticker, @returns_pct, @daily_ret_pct, @updated_at)
         ON CONFLICT(ticker) DO UPDATE SET
           returns_pct = excluded.returns_pct,
           daily_ret_pct = excluded.daily_ret_pct,
           updated_at = excluded.updated_at`,
      )
      .run({
        ticker: ticker.trim().toUpperCase(),
        returns_pct,
        daily_ret_pct,
        updated_at: new Date().toISOString(),
      });
  } finally {
    handle.close();
  }
}
