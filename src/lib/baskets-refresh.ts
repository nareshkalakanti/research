import { buildMomPage, fillMomRatios, screenerBudgetLeft } from "./momentum";
import {
  expectedQuarter,
  markTried,
  nanoFillJob,
  recentlyTried,
  startNanoFill,
  type FillResult,
  type Progress,
} from "./nanocap-champs";
import { fetchScreenerQuarterlyFundamentals } from "./screener-quarters";
import { fillHtIvForMember, fillHtIvFromYahoo, invalidateRotationRank, missingHtIvQueue } from "./sector-rotation-board";
import { hasScreenerLogin, pullAllPeople } from "./screener-people";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Background refresh for the Nano tab (Momentum) while the app is open (pinged
 * from the browser on load and every 30 min). Only does what is due:
 *  - quarterly results for Momentum names whose latest quarter is out of
 *    date (Screener cache refetches once > 7 days old)
 *  - ROCE / ROE for stocks with results but no ratios (Momentum scoring)
 * Screener work shares one hourly budget (see momentum.ts) on top of the
 * global 2.5–5 s gap and automatic pause.
 */

const RESULTS_PER_RUN = 40;
/** ROCE / ROE pages per run for stocks that can't be scored yet (2 runs an hour). */
const RATIOS_PER_RUN = 25;
/**
 * Rotation quality (Sales growth / ROCE / P/B) stocks per run, from whatever
 * hourly budget is left (3 pages each). 2 runs an hour → ≤ 16 stocks/hour.
 */
const ROTATION_QUALITY_PER_RUN = 8;
/** Yahoo tries per run (~0.5 s each + gap) — Yahoo goes first; Screener only gets what Yahoo missed. */
const ROTATION_YAHOO_PER_RUN = 60;
const YAHOO_GAP_MS = 800;
const META_KEY = "baskets_refresh_last";

function withMeta<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS baskets_refresh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    return fn(db);
  } finally {
    db.close();
  }
}

export function lastBasketsRefresh(): string | null {
  return withMeta(
    (db) =>
      (db.prepare(`SELECT value FROM baskets_refresh_meta WHERE key = ?`).get(META_KEY) as { value: string } | undefined)
        ?.value ?? null,
  );
}

/** Momentum names whose results are out of date. */
function staleResultTickers(): string[] {
  const want = expectedQuarter();
  const mom = buildMomPage();
  const out = new Set<string>();
  for (const r of [...mom.strong, ...mom.near]) if (!r.latest_quarter || r.latest_quarter < want) out.add(r.ticker);
  return [...out];
}

async function runRefresh(onProgress?: Progress): Promise<FillResult> {
  let done = 0;
  let filled = 0;
  const stale = staleResultTickers().slice(0, Math.min(RESULTS_PER_RUN, screenerBudgetLeft()));
  const ratioSlots = Math.max(0, Math.min(RATIOS_PER_RUN, screenerBudgetLeft() - stale.length));
  let total = stale.length + ratioSlots;
  onProgress?.(0, total, 0);
  // 1) New quarterly results (Screener; cached copies refetch once > 7 days old).
  let paused = false;
  for (const t of stale) {
    try {
      const qs = await fetchScreenerQuarterlyFundamentals(t);
      if (qs.length) filled += 1;
    } catch (e) {
      if (String(e).toLowerCase().includes("paused")) {
        paused = true;
        break;
      }
    }
    markTried("auto", t);
    done += 1;
    onProgress?.(done, total, filled);
  }
  // 2) ROCE / ROE so more stocks can be scored on the 7 rules (whatever budget is left).
  if (!paused && ratioSlots > 0) {
    const base = done;
    try {
      const r = await fillMomRatios(
        ratioSlots,
        (d, t, f) => {
          total = base + t;
          onProgress?.(base + d, total, filled + f);
        },
        true,
      );
      done = base + r.tried;
      filled += r.filled;
    } catch {
      /* paused mid-run — next run continues */
    }
  }
  // 3) Rotation quality legs (Sales growth / ROCE / P/B) for stocks Top stocks
  //    can't rank yet: Yahoo first (fast, own limits), then Screener — leftover
  //    hourly budget only — for the ones Yahoo had nothing for.
  {
    let got = 0;
    const yQueue = missingHtIvQueue(recentlyTried("rotqy")).slice(0, ROTATION_YAHOO_PER_RUN);
    total += yQueue.length;
    for (const m of yQueue) {
      try {
        if (await fillHtIvFromYahoo(m)) {
          filled += 1;
          got += 1;
        }
      } catch {
        break; // Yahoo throttling — next run continues
      }
      markTried("rotqy", m.ticker.toUpperCase());
      done += 1;
      onProgress?.(done, total, filled);
      await new Promise((r) => setTimeout(r, YAHOO_GAP_MS));
    }
    if (!paused) {
      const yTried = recentlyTried("rotqy");
      const slots = Math.min(ROTATION_QUALITY_PER_RUN, Math.floor(screenerBudgetLeft() / 3));
      const queue =
        slots > 0
          ? missingHtIvQueue(recentlyTried("rotq"))
              .filter((m) => yTried.has(m.ticker.toUpperCase()))
              .slice(0, slots)
          : [];
      total += queue.length;
      for (const m of queue) {
        try {
          if (await fillHtIvForMember(m)) {
            filled += 1;
            got += 1;
          }
        } catch {
          paused = true;
          break;
        }
        markTried("rotq", m.ticker.toUpperCase());
        done += 1;
        onProgress?.(done, total, filled);
      }
    }
    if (got) invalidateRotationRank();
  }
  // 4) Fund watchlists from Screener people pages — once a day, only with a login.
  if (!paused && hasScreenerLogin()) {
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
