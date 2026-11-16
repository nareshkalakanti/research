import { buildFaPage, runFaPriceCheck } from "./fallen-angels";
import { buildLvPage } from "./listed-ventures";
import { buildNanoPage, nanoFillJob, startNanoFill, type FillResult, type Progress } from "./nanocap-champs";
import { fetchScreenerQuarterlyFundamentals } from "./screener-quarters";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Background refresh for the Nano tab baskets while the app is open (pinged
 * from the browser on load and every 30 min). Only does what is due:
 *  - NSE surveillance lists (refreshed inside buildFaPage when > 12h old)
 *  - Fallen Angels price check when the last one is > 1 day old
 *  - quarterly results for holdings and listed candidates whose latest
 *    quarter is out of date (Screener cache refetches once > 7 days old)
 */

const PRICE_DUE_MS = 86_400_000;
const RESULTS_PER_RUN = 40;
const META_KEY = "baskets_refresh_last";

/** Latest quarter end that every company should have reported by now (60-day window). */
function expectedQuarter(now = new Date()): string {
  const d = new Date(now.getTime() - 60 * 86_400_000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const qEndMonth = m >= 12 ? 12 : m >= 9 ? 9 : m >= 6 ? 6 : m >= 3 ? 3 : 0;
  if (qEndMonth === 0) return `${y - 1}-12-31`;
  const day = qEndMonth === 6 || qEndMonth === 9 ? 30 : 31;
  return `${y}-${String(qEndMonth).padStart(2, "0")}-${day}`;
}

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

function priceCheckAge(): number {
  return withMeta((db) => {
    try {
      const r = db.prepare(`SELECT MAX(checked_at) AS at FROM fa_price`).get() as { at: string | null } | undefined;
      return r?.at ? Date.now() - Date.parse(r.at) : Infinity;
    } catch {
      return Infinity;
    }
  });
}

/** Holdings and listed candidates across the three baskets whose results are out of date. */
async function staleResultTickers(): Promise<string[]> {
  const want = expectedQuarter();
  const nano = buildNanoPage();
  const lv = buildLvPage();
  const fa = await buildFaPage();
  const rows = [
    ...nano.current,
    ...nano.candidates,
    ...nano.quality,
    ...lv.current,
    ...lv.candidates,
    ...fa.current,
    ...fa.on_list,
    ...fa.candidates,
  ];
  const out = new Set<string>();
  for (const r of rows) if (!r.latest_quarter || r.latest_quarter < want) out.add(r.ticker);
  return [...out];
}

async function runRefresh(onProgress?: Progress): Promise<FillResult> {
  let done = 0;
  let filled = 0;
  // 1) Surveillance lists + holdings prices refresh inside buildFaPage.
  const stale = (await staleResultTickers()).slice(0, RESULTS_PER_RUN);
  const priceDue = priceCheckAge() > PRICE_DUE_MS;
  const total = stale.length + (priceDue ? 1 : 0);
  onProgress?.(0, total, 0);
  // 2) Fallen Angels price check (whole shortlist, fast).
  if (priceDue) {
    await runFaPriceCheck();
    done += 1;
    filled += 1;
    onProgress?.(done, total, filled);
  }
  // 3) New quarterly results (Screener; cached copies refetch once > 7 days old).
  for (const t of stale) {
    try {
      const qs = await fetchScreenerQuarterlyFundamentals(t);
      if (qs.length) filled += 1;
    } catch (e) {
      if (String(e).toLowerCase().includes("paused")) break;
    }
    done += 1;
    onProgress?.(done, total, filled);
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
