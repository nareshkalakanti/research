import { buildMomPage, fillMomRatios } from "./momentum";
import {
  expectedQuarter,
  markTried,
  nanoFillJob,
  recentlyTried,
  startNanoFill,
  type FillResult,
  type Progress,
} from "./nanocap-champs";
import { upsertQuartersCache } from "./screener-quarters";
import { fetchScreenerAllAnnual, screenerPagesTriedSince } from "./screener-annual";
import { screenerBulkDeferred, screenerPausedUntil } from "./screener-fetch";
import { buildValueUniverse } from "./value-tools";
import {
  fillHtIvFromYahoo,
  invalidateRotationRank,
  missingHtIvQueue,
} from "./sector-rotation-board";
import { hasScreenerLogin, pullAllPeople } from "./screener-people";
import { openSqliteNamed } from "./sqlite-utils";
import { fetchQuarterlyFundamentals } from "./yahoo-quarters";

/**
 * Background refresh while the app is open (pinged on load + every ~30 min).
 *
 * Momentum quarters / ROCE·ROE: Yahoo + Groww + Tickertape — not Screener.
 * Rotation quality gaps: Yahoo only (Screener path removed).
 * Value ranking gaps: tiny Screener leftover budget only.
 */

const RESULTS_PER_RUN = 40;
/** Tickertape ROCE / ROE fills per run (no Screener). */
const RATIOS_PER_RUN = 40;
/** Yahoo tries per run for Rotation quality legs. */
const ROTATION_YAHOO_PER_RUN = 60;
const YAHOO_GAP_MS = 800;
/** Keep tiny — Value fill used to eat Screener budget and trip the pause. */
const VALUE_PER_RUN = 4;
const META_KEY = "baskets_refresh_last";

function withMeta<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(
      `CREATE TABLE IF NOT EXISTS baskets_refresh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    return fn(db);
  } finally {
    db.close();
  }
}

export function lastBasketsRefresh(): string | null {
  return withMeta(
    (db) =>
      (
        db
          .prepare(`SELECT value FROM baskets_refresh_meta WHERE key = ?`)
          .get(META_KEY) as { value: string } | undefined
      )?.value ?? null,
  );
}

/** Momentum names whose results are out of date. */
function staleResultTickers(): string[] {
  const want = expectedQuarter();
  const mom = buildMomPage();
  const out = new Set<string>();
  for (const r of [...mom.strong, ...mom.near]) {
    if (!r.latest_quarter || r.latest_quarter < want) out.add(r.ticker);
  }
  return [...out];
}

async function runRefresh(onProgress?: Progress): Promise<FillResult> {
  let done = 0;
  let filled = 0;
  const stale = staleResultTickers().slice(0, RESULTS_PER_RUN);
  const ratioSlots = RATIOS_PER_RUN;
  let total = stale.length + ratioSlots;
  onProgress?.(0, total, 0);

  // 1) Stale Momentum quarters — Yahoo / NSE / BSE / Groww (no Screener).
  let paused = false;
  for (const t of stale) {
    try {
      const live = await fetchQuarterlyFundamentals(t, null, {
        skipChart: true,
        skipScreener: true,
        yahooFirst: true,
      });
      if (live.quarters.length >= 2) {
        upsertQuartersCache(t, live.quarters);
        filled += 1;
      }
    } catch {
      /* next ticker */
    }
    markTried("auto", t);
    done += 1;
    onProgress?.(done, total, filled);
    await new Promise((r) => setTimeout(r, YAHOO_GAP_MS));
  }

  // 2) ROCE / ROE via Tickertape (quiet = no Screener fallback).
  {
    const base = done;
    try {
      const r = await fillMomRatios(
        ratioSlots,
        (d, tot, f) => {
          total = base + tot;
          onProgress?.(base + d, total, filled + f);
        },
        true,
        { preferTape: true },
      );
      done = base + r.tried;
      filled += r.filled;
    } catch {
      /* next section */
    }
  }

  // 3) Rotation quality — Yahoo only (Screener fill removed).
  {
    let got = 0;
    const yQueue = missingHtIvQueue(recentlyTried("rotqy")).slice(
      0,
      ROTATION_YAHOO_PER_RUN,
    );
    total += yQueue.length;
    for (const m of yQueue) {
      try {
        if (await fillHtIvFromYahoo(m)) {
          filled += 1;
          got += 1;
        }
      } catch {
        break; // Yahoo throttling
      }
      markTried("rotqy", m.ticker.toUpperCase());
      done += 1;
      onProgress?.(done, total, filled);
      await new Promise((r) => setTimeout(r, YAHOO_GAP_MS));
    }
    if (got) invalidateRotationRank();
  }

  // 4) Value-tab ranking gaps — one consolidated Screener page each; yield to Portfolio.
  if (!paused && !screenerBulkDeferred() && !screenerPausedUntil()) {
    const slots = VALUE_PER_RUN;
    const tried = screenerPagesTriedSince(30 * 86_400_000);
    const gaps = buildValueUniverse()
      .rows.filter((r) => (r.sales3y == null || r.roce3y == null) && !tried.has(r.t.toUpperCase()))
      .sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0))
      .slice(0, slots);
    total += gaps.length;
    for (const r of gaps) {
      if (screenerPausedUntil() || screenerBulkDeferred()) {
        paused = true;
        break;
      }
      try {
        const res = await fetchScreenerAllAnnual(r.t, {
          standaloneIfShort: false,
        });
        if (res.annual && res.bs) filled += 1;
      } catch {
        paused = true;
        break;
      }
      markTried("valq", r.t.toUpperCase());
      done += 1;
      onProgress?.(done, total, filled);
    }
  }

  // 5) Fund watchlists from Screener people pages — once a day, only with a login.
  if (!paused && !screenerPausedUntil() && hasScreenerLogin()) {
    try {
      await pullAllPeople({ onlyStale: true });
    } catch {
      /* next run retries */
    }
  }

  withMeta((db) =>
    db
      .prepare(
        `INSERT INTO baskets_refresh_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(META_KEY, new Date().toISOString()),
  );
  return { tried: total, filled, left: 0, not_found: total - filled };
}

/** Start the background refresh unless another Nano job is running. */
export function startBasketsRefresh(): { started: boolean; reason?: string } {
  const cur = nanoFillJob();
  if (cur?.running) return { started: false, reason: "busy" };
  startNanoFill("auto", (p) => runRefresh(p));
  return { started: true };
}
