import { openSqliteNamed } from "./sqlite-utils";

/** Ret = result-day close → LTP (Drift-style); Day = announce session only. */
export const PEAD_RETURNS_FORMULA = 3;

export type PeadReturnsRow = {
  ticker: string;
  returns_pct: number | null;
  daily_ret_pct: number | null;
  /** Announcement date these returns were computed for (YYYY-MM-DD). */
  result_date: string | null;
  /** Result-session close — Ret baseline (same idea as Drift call-day close). */
  entry_close: number | null;
  /** Formula id; ignore rows below PEAD_RETURNS_FORMULA. */
  formula: number;
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
  // Bind returns to the announcement they belong to — stale % vs new result_date.
  const cols = handle.prepare(`PRAGMA table_info(pead_returns)`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "result_date")) {
    handle.exec(`ALTER TABLE pead_returns ADD COLUMN result_date TEXT`);
  }
  if (!cols.some((c) => c.name === "entry_close")) {
    handle.exec(`ALTER TABLE pead_returns ADD COLUMN entry_close REAL`);
  }
  if (!cols.some((c) => c.name === "formula")) {
    handle.exec(`ALTER TABLE pead_returns ADD COLUMN formula INTEGER`);
  }
  return handle;
}

function isoDay(raw: string | null | undefined): string | null {
  const d = (raw || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

export function loadPeadReturnsMap(): Map<string, PeadReturnsRow> {
  const map = new Map<string, PeadReturnsRow>();
  try {
    const handle = db();
    try {
      const rows = handle
        .prepare(
          `SELECT ticker, returns_pct, daily_ret_pct, result_date, entry_close, formula, updated_at FROM pead_returns`,
        )
        .all() as Array<{
        ticker: string;
        returns_pct: number | null;
        daily_ret_pct: number | null;
        result_date: string | null;
        entry_close: number | null;
        formula: number | null;
        updated_at: string;
      }>;
      for (const row of rows) {
        const formula =
          row.formula != null && Number.isFinite(row.formula)
            ? Number(row.formula)
            : 0;
        // Drop pre-v3 rows (old Ret entry / Day = max later move).
        if (formula < PEAD_RETURNS_FORMULA) continue;
        const entry =
          row.entry_close != null &&
          Number.isFinite(row.entry_close) &&
          row.entry_close > 0
            ? row.entry_close
            : null;
        map.set(row.ticker.toUpperCase(), {
          ticker: row.ticker,
          returns_pct: row.returns_pct,
          daily_ret_pct: row.daily_ret_pct,
          result_date: isoDay(row.result_date),
          entry_close: entry,
          formula,
          updated_at: row.updated_at,
        });
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
  resultDate?: string | null,
  entryClose?: number | null,
): void {
  const handle = db();
  try {
    const entry =
      entryClose != null && Number.isFinite(entryClose) && entryClose > 0
        ? entryClose
        : null;
    handle
      .prepare(
        `INSERT INTO pead_returns (ticker, returns_pct, daily_ret_pct, result_date, entry_close, formula, updated_at)
         VALUES (@ticker, @returns_pct, @daily_ret_pct, @result_date, @entry_close, @formula, @updated_at)
         ON CONFLICT(ticker) DO UPDATE SET
           returns_pct = excluded.returns_pct,
           daily_ret_pct = excluded.daily_ret_pct,
           result_date = excluded.result_date,
           entry_close = excluded.entry_close,
           formula = excluded.formula,
           updated_at = excluded.updated_at`,
      )
      .run({
        ticker: ticker.trim().toUpperCase(),
        returns_pct,
        daily_ret_pct,
        result_date: isoDay(resultDate),
        entry_close: entry,
        formula: PEAD_RETURNS_FORMULA,
        updated_at: new Date().toISOString(),
      });
  } finally {
    handle.close();
  }
}
