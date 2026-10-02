/**
 * Fill missing Candidates fundamentals: Screener annual series (EPS, sales,
 * ROCE) and Yahoo P/E, a small batch per call. Screener blocks pause the
 * Screener side (see screener-fetch); P/E keeps going. Misses are remembered so
 * the queue does not loop on names a source does not have.
 */
import { syncCompanyMetrics } from "@/lib/company-metrics";
import { buildNetworkCandidates, type NetworkCandidate } from "@/lib/network-profile";
import { refreshPeForTickers } from "@/lib/napkin/scan-refresh";
import { fetchScreenerAnnual } from "@/lib/screener-annual";
import { screenerPausedUntil } from "@/lib/screener-fetch";
import { openSqliteNamed } from "@/lib/sqlite-utils";

export const FILL_SCREENER_BATCH = 6;
export const FILL_PE_BATCH = 16;
const SCREENER_MISS_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const PE_MISS_RETRY_MS = 24 * 60 * 60 * 1000;

type FillKind = "screener" | "pe";

export type NetworkFillStatus = {
  candidates: number;
  screener_remaining: number;
  pe_remaining: number;
  screener_paused_until: string | null;
};

export type NetworkFillBatch = NetworkFillStatus & {
  screener_tried: number;
  screener_filled: number;
  pe_tried: number;
  pe_found: number;
  /** Yahoo answered none of a non-empty P/E batch. */
  pe_stalled: boolean;
  done: boolean;
};

function openAttempts() {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS network_fill_attempts (
      ticker TEXT NOT NULL,
      kind TEXT NOT NULL,
      attempted_at TEXT NOT NULL,
      ok INTEGER NOT NULL,
      PRIMARY KEY (ticker, kind)
    );
  `);
  return db;
}

/** Tickers tried within the window; `missesOnly` skips successful attempts. */
function recentAttempts(kind: FillKind, retryMs: number, missesOnly: boolean): Set<string> {
  const db = openAttempts();
  try {
    const cutoff = new Date(Date.now() - retryMs).toISOString();
    const rows = db
      .prepare(
        `SELECT ticker FROM network_fill_attempts
         WHERE kind = ? AND attempted_at > ? ${missesOnly ? "AND ok = 0" : ""}`,
      )
      .all(kind, cutoff) as Array<{ ticker: string }>;
    return new Set(rows.map((r) => r.ticker));
  } finally {
    db.close();
  }
}

function recordAttempts(kind: FillKind, results: Array<{ ticker: string; ok: boolean }>) {
  if (!results.length) return;
  const db = openAttempts();
  try {
    const stmt = db.prepare(
      `INSERT INTO network_fill_attempts (ticker, kind, attempted_at, ok)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ticker, kind) DO UPDATE SET
         attempted_at = excluded.attempted_at,
         ok = excluded.ok`,
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const r of results) stmt.run(r.ticker, kind, now, r.ok ? 1 : 0);
    })();
  } finally {
    db.close();
  }
}

/** Tickers with a Screener annual series that has sales. */
function usefulAnnualTickers(): Set<string> {
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const exists = db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'screener_annual_cache'`,
      )
      .get();
    if (!exists) return new Set();
    const rows = db
      .prepare(`SELECT ticker, annual_json FROM screener_annual_cache`)
      .all() as Array<{ ticker: string; annual_json: string }>;
    const out = new Set<string>();
    for (const r of rows) {
      try {
        const sales = (JSON.parse(r.annual_json) as { sales?: unknown[] }).sales ?? [];
        if (sales.some((s) => typeof s === "number" && s > 0)) {
          out.add(r.ticker.toUpperCase());
        }
      } catch {
        /* unreadable row counts as missing */
      }
    }
    return out;
  } finally {
    db.close();
  }
}

/** Most-connected candidates first, so the interesting names fill first. */
function byNetwork(a: NetworkCandidate, b: NetworkCandidate): number {
  return (
    b.cross_group_directors - a.cross_group_directors ||
    b.large_connections - a.large_connections ||
    b.external_directors - a.external_directors ||
    a.ticker.localeCompare(b.ticker)
  );
}

function fillQueues(): {
  candidates: number;
  screener: string[];
  pe: string[];
} {
  const rows = buildNetworkCandidates().sort(byNetwork);
  const annual = usefulAnnualTickers();
  const screenerMiss = recentAttempts("screener", SCREENER_MISS_RETRY_MS, true);
  const peMiss = recentAttempts("pe", PE_MISS_RETRY_MS, false);
  return {
    candidates: rows.length,
    screener: rows
      .filter((r) => !annual.has(r.ticker) && !screenerMiss.has(r.ticker))
      .map((r) => r.ticker),
    pe: rows.filter((r) => r.pe == null && !peMiss.has(r.ticker)).map((r) => r.ticker),
  };
}

export function networkFillStatus(): NetworkFillStatus {
  const q = fillQueues();
  return {
    candidates: q.candidates,
    screener_remaining: q.screener.length,
    pe_remaining: q.pe.length,
    screener_paused_until: screenerPausedUntil(),
  };
}

/** One fill step: a few Screener pages (unless paused) and one Yahoo P/E batch. */
export async function runNetworkFillBatch(): Promise<NetworkFillBatch> {
  const q = fillQueues();

  const screenerResults: Array<{ ticker: string; ok: boolean }> = [];
  if (!screenerPausedUntil()) {
    for (const ticker of q.screener.slice(0, FILL_SCREENER_BATCH)) {
      const series = await fetchScreenerAnnual(ticker);
      const ok = series.sales.some((s) => s != null && s > 0);
      if (!ok && screenerPausedUntil()) break;
      screenerResults.push({ ticker, ok });
    }
    recordAttempts("screener", screenerResults);
  }

  const peBatch = q.pe.slice(0, FILL_PE_BATCH);
  const pe = await refreshPeForTickers(peBatch);
  const withPe = new Set(pe.with_pe);
  const peStalled = peBatch.length > 0 && pe.answered.length === 0;
  if (!peStalled) {
    recordAttempts(
      "pe",
      peBatch.map((ticker) => ({ ticker, ok: withPe.has(ticker) })),
    );
  }

  const screenerFilled = screenerResults.filter((r) => r.ok).length;
  if (screenerFilled > 0 || pe.answered.length > 0) {
    const gov = openSqliteNamed("governance.db", { wal: true });
    try {
      syncCompanyMetrics(gov);
    } finally {
      gov.close();
    }
  }

  const status = networkFillStatus();
  return {
    ...status,
    screener_tried: screenerResults.length,
    screener_filled: screenerFilled,
    pe_tried: peBatch.length,
    pe_found: pe.with_pe.length,
    pe_stalled: peStalled,
    done: status.screener_remaining === 0 && status.pe_remaining === 0,
  };
}
