import { loadAllCompanies } from "./db";
import { fillRolesFromAnnualReport, recentlyTriedAr } from "./governance-annual-report";
import { runGovernanceScanBatch } from "./governance-scan";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Data tab: re-fetch NSE boards for main-board companies whose directors have
 * no category (boards that came from MCA / Zauba screenshots only say
 * "Director", so independence is unknown). NSE SME companies are exempt from
 * the NSE governance report, so they are not attempted.
 */

export type BlankFixJob = {
  running: boolean;
  stopping: boolean;
  done: number;
  total: number;
  saved: number;
  empty: number;
  failed: number;
  current: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

export type BlankFixStatus = {
  job: BlankFixJob | null;
  /** Companies with at least one director missing a category. */
  blank_total: number;
  /** Of those, NSE main board not yet tried (or tried over a week ago). */
  blank_nse: number;
  /** NSE main board that NSE returned no filing for in the last week. */
  blank_no_filing: number;
  /** NSE SME / BSE — no NSE governance report. */
  blank_other: number;
  /** NSE / NSE SME companies whose annual report hasn't been read yet (30 days). */
  ar_to_try: number;
  /** Delisted / renamed — not counted above. */
  blank_unlisted: number;
  ar_job: BlankFixJob | null;
};

const KEY = "__govBlankFixJob";
const AR_KEY = "__govArFillJob";
type Holder = { [KEY]?: BlankFixJob; [AR_KEY]?: BlankFixJob };

function blankTickers(): string[] {
  const db = openSqliteNamed("governance.db", { readonly: true, wal: true });
  try {
    return (
      db
        .prepare(
          `SELECT DISTINCT UPPER(ticker) AS t FROM board_seats
           WHERE TRIM(COALESCE(category, '')) = ''`,
        )
        .all() as Array<{ t: string }>
    ).map((r) => r.t);
  } finally {
    db.close();
  }
}

/** Tickers NSE returned no governance filing for within the last week. */
function recentlyEmpty(): Set<string> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const db = openSqliteNamed("governance.db", { readonly: true, wal: true });
  try {
    return new Set(
      (
        db
          .prepare(`SELECT UPPER(ticker) AS t FROM scan_log WHERE status = 'empty' AND fetched_at >= ?`)
          .all(since) as Array<{ t: string }>
      ).map((r) => r.t),
    );
  } catch {
    return new Set();
  } finally {
    db.close();
  }
}

function split() {
  const market = new Map(loadAllCompanies().map((c) => [c.ticker.toUpperCase(), c.market]));
  const raw = blankTickers();
  // Delisted / renamed companies are no longer in the universe — don't count them.
  const all = raw.filter((t) => market.has(t));
  const unlisted = raw.length - all.length;
  const empty = recentlyEmpty();
  const nseAll = all.filter((t) => market.get(t) === "NSE");
  const nse = nseAll.filter((t) => !empty.has(t)).sort();
  const tried = recentlyTriedAr();
  const arTodo = all
    .filter((t) => (market.get(t) === "NSE" || market.get(t) === "NSE SME") && !tried.has(t))
    .sort()
    .map((t) => ({ t, m: market.get(t) as string }));
  return { all, nse, noFiling: nseAll.length - nse.length, unlisted, arTodo };
}

export function blankFixStatus(): BlankFixStatus {
  const { all, nse, noFiling, unlisted, arTodo } = split();
  return {
    job: (globalThis as Holder)[KEY] ?? null,
    blank_total: all.length,
    blank_nse: nse.length,
    blank_no_filing: noFiling,
    blank_other: all.length - nse.length - noFiling,
    ar_to_try: arTodo.length,
    blank_unlisted: unlisted,
    ar_job: (globalThis as Holder)[AR_KEY] ?? null,
  };
}

export function startBlankFix(): BlankFixJob {
  const holder = globalThis as Holder;
  const cur = holder[KEY];
  if (cur?.running) return cur;
  const { nse } = split();
  const job: BlankFixJob = {
    running: true,
    stopping: false,
    done: 0,
    total: nse.length,
    saved: 0,
    empty: 0,
    failed: 0,
    current: null,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  holder[KEY] = job;
  void (async () => {
    try {
      // Small, one-at-a-time batches with a fresh NSE session each — long
      // shared sessions get throttled and come back empty.
      for (let i = 0; i < nse.length; i += 5) {
        if (job.stopping) break;
        const chunk = nse.slice(i, i + 5);
        job.current = chunk[0] ?? null;
        const r = await runGovernanceScanBatch({
          tickers: chunk,
          missingOnly: false,
          limit: chunk.length,
          concurrency: 1,
        });
        job.saved += r.saved;
        job.empty += r.skipped_empty;
        job.failed += r.failed + r.skipped_protected;
        job.done += chunk.length;
        await new Promise((res) => setTimeout(res, 2000));
      }
    } catch (e) {
      job.error = e instanceof Error ? e.message : String(e);
    } finally {
      job.running = false;
      job.current = null;
      job.finished_at = new Date().toISOString();
    }
  })();
  return job;
}

export function stopBlankFix(): void {
  const job = (globalThis as Holder)[KEY];
  if (job?.running) job.stopping = true;
}

/** Background job: fill roles from each company's latest NSE annual report. */
export function startArFill(): BlankFixJob {
  const holder = globalThis as Holder;
  const cur = holder[AR_KEY];
  if (cur?.running) return cur;
  const { arTodo } = split();
  const job: BlankFixJob = {
    running: true,
    stopping: false,
    done: 0,
    total: arTodo.length,
    saved: 0,
    empty: 0,
    failed: 0,
    current: null,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  holder[AR_KEY] = job;
  void (async () => {
    try {
      for (const { t, m } of arTodo) {
        if (job.stopping) break;
        job.current = t;
        try {
          const r = await fillRolesFromAnnualReport(t, m);
          if (r.filled) job.saved += 1;
          else job.empty += 1;
        } catch {
          job.failed += 1;
        }
        job.done += 1;
      }
    } catch (e) {
      job.error = e instanceof Error ? e.message : String(e);
    } finally {
      job.running = false;
      job.current = null;
      job.finished_at = new Date().toISOString();
    }
  })();
  return job;
}

export function stopArFill(): void {
  const job = (globalThis as Holder)[AR_KEY];
  if (job?.running) job.stopping = true;
}
