import { cacheBseScripCode } from "./bse-investor-discover";
import { fetchBseMainListings } from "./bse-main";
import { bseMainListLoaded, saveBseMainListings, trustedBseCode } from "./bse-codes";
import { scoreReviewTicker } from "./portfolio-review";
import { screenerPausedUntil } from "./screener-fetch";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Finds stocks whose saved fundamentals belong to another company and re-reads
 * them from Screener with the identity check on (see screener-fetch).
 *
 * Suspects:
 *   wrong_code  — saved BSE code differs from the trusted list
 *   shared_code — one BSE code saved against several tickers
 *   same_data   — Screener annual figures identical to another ticker's
 */

export type Suspect = { ticker: string; reasons: string[]; saved_code: string | null; trusted_code: string | null };

export type RepairJob = {
  running: boolean;
  total: number;
  done: number;
  fixed_codes: number;
  refreshed: number;
  failed: number;
  stopped_reason: string | null;
  started_at: string;
  finished_at: string | null;
};

const JOB_KEY = Symbol.for("research.identityRepairJob");
type Holder = { [JOB_KEY]?: RepairJob };

export function identityRepairJob(): RepairJob | null {
  return (globalThis as Holder)[JOB_KEY] ?? null;
}

function savedCodes(): Map<string, string> {
  const out = new Map<string, string>();
  const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
  try {
    for (const r of db.prepare(`SELECT UPPER(ticker) AS t, scrip_code AS c FROM company_bse_scrip`).all() as Array<{
      t: string;
      c: string;
    }>) {
      if (r.c) out.set(r.t, r.c.trim());
    }
  } finally {
    db.close();
  }
  return out;
}

/** Tickers whose saved annual sales series is identical to another ticker's (real revenue only). */
function sameDataGroups(): string[][] {
  const groups = new Map<string, string[]>();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    for (const r of db.prepare(`SELECT UPPER(ticker) AS t, annual_json AS j FROM screener_annual_cache`).all() as Array<{
      t: string;
      j: string;
    }>) {
      if (/^\d+$/.test(r.t)) continue; // a scrip-code alias of its own ticker
      try {
        const a = JSON.parse(r.j) as { dates: string[]; sales: Array<number | null> };
        const sales = a.sales.slice(-4);
        if (sales.filter((v) => v != null && v > 0).length < 3) continue; // shells read 0: not a mix-up
        const key = `${a.dates.slice(-4).join(",")}|${sales.join(",")}`;
        groups.set(key, [...(groups.get(key) ?? []), r.t]);
      } catch {
        /* bad row */
      }
    }
  } finally {
    db.close();
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export function findIdentitySuspects(): Suspect[] {
  const saved = savedCodes();
  const out = new Map<string, Suspect>();
  const add = (t: string, reason: string) => {
    const s = out.get(t) ?? { ticker: t, reasons: [], saved_code: saved.get(t) ?? null, trusted_code: trustedBseCode(t) };
    if (!s.reasons.includes(reason)) s.reasons.push(reason);
    out.set(t, s);
  };
  const byCode = new Map<string, string[]>();
  for (const [t, c] of saved) {
    const trusted = trustedBseCode(t);
    if (trusted && trusted !== c) add(t, "wrong_code");
    byCode.set(c, [...(byCode.get(c) ?? []), t]);
  }
  for (const tickers of byCode.values()) {
    if (tickers.length < 2) continue;
    // The ticker the code truly belongs to is fine; the others are not.
    for (const t of tickers) if (trustedBseCode(t) !== saved.get(t)) add(t, "shared_code");
  }
  for (const group of sameDataGroups()) {
    // Same company under two names (code alias) is fine: only flag when trusted codes differ.
    const codes = new Set(group.map((t) => trustedBseCode(t) ?? `?${t}`));
    if (codes.size > 1) for (const t of group) add(t, "same_data");
  }
  return [...out.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** Refresh the BSE list, fix saved codes, re-read each suspect's Screener page (background). */
export function startIdentityRepair(opts?: { refreshList?: boolean }): RepairJob {
  const holder = globalThis as Holder;
  const cur = holder[JOB_KEY];
  if (cur?.running) return cur;
  const job: RepairJob = {
    running: true,
    total: 0,
    done: 0,
    fixed_codes: 0,
    refreshed: 0,
    failed: 0,
    stopped_reason: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  holder[JOB_KEY] = job;
  void (async () => {
    try {
      if (opts?.refreshList !== false || !bseMainListLoaded()) {
        saveBseMainListings(await fetchBseMainListings());
      }
      const suspects = findIdentitySuspects();
      job.total = suspects.length;
      for (const s of suspects) {
        const paused = screenerPausedUntil();
        if (paused) {
          job.stopped_reason = `Screener paused until ${paused}`;
          break;
        }
        if (s.trusted_code && s.trusted_code !== s.saved_code) {
          cacheBseScripCode(s.ticker, s.trusted_code);
          job.fixed_codes++;
        }
        try {
          await scoreReviewTicker(s.ticker, { fresh: true });
          job.refreshed++;
        } catch {
          job.failed++;
        }
        job.done++;
      }
    } catch (e) {
      job.stopped_reason = e instanceof Error ? e.message : String(e);
    } finally {
      job.running = false;
      job.finished_at = new Date().toISOString();
    }
  })();
  return job;
}
