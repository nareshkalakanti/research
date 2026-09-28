/**
 * Groww + Tickertape fill for PEAD blanks (quarters, TTM PE) — cached.
 */
import { openSqliteNamed } from "./sqlite-utils";
import { fetchGrowwPeadFill } from "./groww-quarters";
import { tickertapeValuation } from "./web-mcap";
import { runConcurrent } from "./scrape-pool";
import type { QuarterPoint } from "./quarter-panel";

function usablePe(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v >= 500) return null;
  return v;
}

export type PeadWebMetrics = {
  ticker: string;
  pe_ratio: number | null;
  eps_ttm: number | null;
  quarters: QuarterPoint[];
};

function db() {
  const handle = openSqliteNamed("metrics.db", { wal: true });
  handle.exec(`
    CREATE TABLE IF NOT EXISTS pead_web_metrics (
      ticker TEXT PRIMARY KEY,
      pe_ratio REAL,
      eps_ttm REAL,
      quarters_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return handle;
}

function finite(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v;
}

export function loadPeadWebMetricsMap(): Map<string, PeadWebMetrics> {
  const map = new Map<string, PeadWebMetrics>();
  try {
    const handle = db();
    try {
      const rows = handle
        .prepare(
          `SELECT ticker, pe_ratio, eps_ttm, quarters_json FROM pead_web_metrics`,
        )
        .all() as Array<{
        ticker: string;
        pe_ratio: number | null;
        eps_ttm: number | null;
        quarters_json: string;
      }>;
      for (const row of rows) {
        let quarters: QuarterPoint[] = [];
        try {
          const parsed = JSON.parse(row.quarters_json) as QuarterPoint[];
          if (Array.isArray(parsed)) quarters = parsed;
        } catch {
          quarters = [];
        }
        map.set(row.ticker.toUpperCase(), {
          ticker: row.ticker.toUpperCase(),
          pe_ratio: usablePe(finite(row.pe_ratio)),
          eps_ttm: finite(row.eps_ttm),
          quarters,
        });
      }
    } finally {
      handle.close();
    }
  } catch {
    /* missing */
  }
  return map;
}

export function savePeadWebMetrics(row: PeadWebMetrics): void {
  const handle = db();
  try {
    handle
      .prepare(
        `INSERT INTO pead_web_metrics (ticker, pe_ratio, eps_ttm, quarters_json, updated_at)
         VALUES (@ticker, @pe_ratio, @eps_ttm, @quarters_json, @updated_at)
         ON CONFLICT(ticker) DO UPDATE SET
           pe_ratio = excluded.pe_ratio,
           eps_ttm = excluded.eps_ttm,
           quarters_json = excluded.quarters_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        ticker: row.ticker.trim().toUpperCase(),
        pe_ratio: row.pe_ratio,
        eps_ttm: row.eps_ttm,
        quarters_json: JSON.stringify(row.quarters),
        updated_at: new Date().toISOString(),
      });
  } finally {
    handle.close();
  }
}

export async function refreshPeadWebMetrics(
  rows: Array<{ ticker: string; name: string }>,
): Promise<number> {
  if (!rows.length) return 0;
  let updated = 0;
  await runConcurrent(rows, 3, async (row) => {
    const groww = await fetchGrowwPeadFill(row.ticker, row.name);
    let tape = null as Awaited<ReturnType<typeof tickertapeValuation>>;
    try {
      tape = await tickertapeValuation(row.ticker, row.name);
    } catch {
      tape = null;
    }
    const pe_ratio =
      usablePe(groww?.pe_ttm ?? null) ??
      usablePe(tape?.ttm_pe ?? null) ??
      usablePe(tape?.pe ?? null);
    const eps_ttm = finite(groww?.eps_ttm) ?? finite(tape?.eps);
    const quarters = groww?.quarters ?? [];
    if (pe_ratio == null && eps_ttm == null && !quarters.length) return;
    savePeadWebMetrics({
      ticker: row.ticker,
      pe_ratio,
      eps_ttm,
      quarters,
    });
    updated += 1;
  });
  return updated;
}
