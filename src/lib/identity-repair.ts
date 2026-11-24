import { cacheBseScripCode, deleteBseScripCode } from "./bse-investor-discover";
import { fetchBseMainListings } from "./bse-main";
import { bseMainListLoaded, saveBseMainListings, trustedBseCode } from "./bse-codes";
import { scoreReviewTicker } from "./portfolio-review";
import { clearScreenerStatementCaches } from "./screener-annual";
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
 *   quarter_mismatch — saved quarters disagree with the annual report (last
 *                 12 months outside 0.5–2× annual sales, or a 50× jump), e.g.
 *                 Infosys's quarters saved in US dollars
 */

/**
 * retire  — not an active stock (old alias / replaced ticker): drop its saved data, no fetch
 * clear   — holds another company's data: drop it first, then re-fetch (blank beats wrong)
 * refresh — re-fetch with the identity check
 */
export type RepairAction = "retire" | "clear" | "refresh";

export type Suspect = {
  ticker: string;
  reasons: string[];
  saved_code: string | null;
  trusted_code: string | null;
  action: RepairAction;
};

export type RepairJob = {
  running: boolean;
  total: number;
  done: number;
  fixed_codes: number;
  /** Saved data dropped (old alias, or another company's figures). */
  cleared: number;
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

/** Active tickers in the stock master, with market cap (owner of shared data = largest). */
function activeTickers(): Map<string, number> {
  const active = new Set<string>();
  const sm = openSqliteNamed("stock_master.db", { readonly: true, wal: true });
  try {
    for (const r of sm.prepare(`SELECT UPPER(ticker) AS t FROM stocks WHERE active = 1`).all() as Array<{ t: string }>) {
      active.add(r.t);
    }
  } finally {
    sm.close();
  }
  const out = new Map<string, number>();
  const m = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const caps = new Map(
      (m.prepare(`SELECT UPPER(ticker) AS t, market_cap_cr AS c FROM stock_metrics`).all() as Array<{ t: string; c: number | null }>).map(
        (r) => [r.t, r.c ?? 0],
      ),
    );
    for (const t of active) out.set(t, caps.get(t) ?? 0);
  } finally {
    m.close();
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
        // Screener rounds to ₹1 Cr: tiny sales (1, 1, 1) match by coincidence.
        if (Math.max(...sales.map((v) => v ?? 0)) < 10) continue;
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

/** Saved quarterly series that disagree with the annual report (₹5 Cr+ companies). */
function quarterMismatchTickers(): string[] {
  const out: string[] = [];
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    const annual = new Map<string, number>();
    for (const r of db.prepare(`SELECT UPPER(ticker) AS t, annual_json AS j FROM screener_annual_cache`).all() as Array<{
      t: string;
      j: string;
    }>) {
      try {
        const a = JSON.parse(r.j) as { sales: Array<number | null> };
        const last = [...a.sales].reverse().find((v) => v != null && v > 0);
        if (last != null) annual.set(r.t, last);
      } catch {
        /* bad row */
      }
    }
    const mi = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
    for (const r of db.prepare(`SELECT UPPER(ticker) AS t, quarters_json AS j FROM screener_quarters_cache`).all() as Array<{
      t: string;
      j: string;
    }>) {
      const ann = annual.get(r.t);
      if (ann == null || ann < 5) continue;
      try {
        const qs = (JSON.parse(r.j) as Array<{ date: string; revenue: number | null }>)
          .filter((q) => q.date && q.revenue != null)
          .sort((a, b) => a.date.localeCompare(b.date))
          // Same rule as the chart: only a series with a ₹1 Cr+ rupee amount is in rupees.
          .map((q, _i, all) => ({
            ...q,
            revenue: all.some((x) => Math.abs(x.revenue!) >= 1e7) && Math.abs(q.revenue!) >= 1e5 ? q.revenue! / 1e7 : q.revenue!,
          }));
        if (qs.length < 2) continue;
        let jump = false;
        for (let i = 1; i < qs.length; i++) {
          const a = qs[i - 1]!.revenue!;
          const b = qs[i]!.revenue!;
          if (a > 0 && b > 0 && (b / a > 50 || a / b > 50)) jump = true;
        }
        const four = qs.slice(-4);
        const two = qs.slice(-2);
        const steps = (xs: typeof qs, g: number) => xs.every((x, i) => i === 0 || Math.abs(mi(x.date) - mi(xs[i - 1]!.date) - g) <= 1);
        const year = four.length === 4 && steps(four, 3) ? four : steps(two, 6) ? two : null;
        const ratio = year ? year.reduce((t, q) => t + q.revenue!, 0) / ann : null;
        if (jump || (ratio != null && (ratio < 0.5 || ratio > 2))) out.push(r.t);
      } catch {
        /* bad row */
      }
    }
  } finally {
    db.close();
  }
  return out;
}

export function findIdentitySuspects(): Suspect[] {
  const saved = savedCodes();
  const active = activeTickers();
  const out = new Map<string, Suspect>();
  const add = (t: string, reason: string, action: RepairAction = "refresh") => {
    const s =
      out.get(t) ??
      ({ ticker: t, reasons: [], saved_code: saved.get(t) ?? null, trusted_code: trustedBseCode(t), action } as Suspect);
    if (!s.reasons.includes(reason)) s.reasons.push(reason);
    // Strongest action wins: retire > clear > refresh.
    const rank: Record<RepairAction, number> = { refresh: 0, clear: 1, retire: 2 };
    if (rank[action] > rank[s.action]) s.action = action;
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
    // The ticker the code truly belongs to is fine; the others are not — and
    // with no trusted code of their own, the saved one is someone else's.
    for (const t of tickers) if (trustedBseCode(t) !== saved.get(t)) add(t, "shared_code", trustedBseCode(t) ? "refresh" : "clear");
  }
  for (const group of sameDataGroups()) {
    // Same company under two names (code alias) is fine: only flag when trusted codes differ.
    const codes = new Set(group.map((t) => trustedBseCode(t) ?? `?${t}`));
    if (codes.size < 2) continue;
    // The data most likely belongs to the largest active member; the rest hold a copy.
    const owner = group
      .filter((t) => active.has(t))
      .sort((a, b) => (active.get(b) ?? 0) - (active.get(a) ?? 0))[0];
    for (const t of group) add(t, "same_data", t === owner ? "refresh" : "clear");
  }
  // Quarters that disagree with the annual report: re-read the company page with the identity check.
  for (const t of quarterMismatchTickers()) if (active.has(t)) add(t, "quarter_mismatch");
  // Old aliases / replaced tickers: nothing to fetch, just drop what they hold.
  for (const s of out.values()) if (!active.has(s.ticker)) s.action = "retire";
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
    cleared: 0,
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
        if (s.action === "retire" || s.action === "clear") {
          clearScreenerStatementCaches(s.ticker);
          if (!s.trusted_code && s.saved_code) deleteBseScripCode(s.ticker);
          job.cleared++;
        }
        if (s.trusted_code && s.trusted_code !== s.saved_code) {
          cacheBseScripCode(s.ticker, s.trusted_code);
          job.fixed_codes++;
        }
        if (s.action === "retire") {
          job.done++;
          continue;
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
