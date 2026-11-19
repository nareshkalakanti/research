import { inactiveListingTickers } from "./listing-sync";
import { loadCtx, type FillResult } from "./nanocap-champs";
import { scanHolders, withStakeDb } from "./nse-holders";
import { fetchMonthlyBars, fetchNiftyDailyBars, monthlyBarsFromDaily } from "./ohlc";
import { buildMatcher, nameKey } from "./smart-entities";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Smart-money model, run on the whole NSE universe (₹100–6,000 Cr).
 *
 * Question it learns: after a quarter's shareholding filing is public, does the
 * stock beat the Nifty over the next HORIZON months?
 *
 * Inputs use only what was public on that date (filing = quarter end + 21 days):
 * who bought / added / cut / left among named (1%+) holders, promoter change,
 * the tracked investors, each holder's past skill (from results already known),
 * and 6-month momentum vs the Nifty. Logistic regression, tested on the newest
 * quarters it never saw, then refit on everything and used to score every stock.
 */

export const MODEL = {
  quarters: 12,
  horizon: 6,
  minMcapCr: 100,
  maxMcapCr: 6000,
  /** SEBI: shareholding pattern due within 21 days of quarter end. */
  lagDays: 21,
  testQuarters: 2,
  l2: 1,
  /** Skill shrink: k pseudo-events at zero excess. */
  skillK: 3,
} as const;

export const FEATURES = [
  ["n_new", "new named holders"],
  ["n_up", "holders adding"],
  ["n_down", "holders cutting"],
  ["n_exit", "holders leaving"],
  ["new_pct", "stake taken by new holders (%)"],
  ["net_pct", "net change in named non-promoter stake (pp)"],
  ["prom_chg", "promoter stake change (pp)"],
  ["tracked_buy", "tracked investors buying"],
  ["tracked_hold", "tracked investors holding"],
  ["skill_buy", "skill of holders buying"],
  ["skill_max", "best buyer's skill"],
  ["mom6", "6-month return vs Nifty"],
  ["n_named", "named non-promoter holders"],
] as const;
type FeatureId = (typeof FEATURES)[number][0];
type Row = { sym: string; bucket: string; entry: string; x: Record<FeatureId, number>; y: number | null; excess: number | null };

// ---- Store ----------------------------------------------------------------------

function withModelDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T, readonly = false): T {
  const db = openSqliteNamed("smart_money.db", { readonly, wal: true });
  try {
    if (!readonly) {
      db.pragma("busy_timeout = 5000");
      db.exec(`CREATE TABLE IF NOT EXISTS px_monthly (
        ticker TEXT NOT NULL, month TEXT NOT NULL, close REAL NOT NULL, PRIMARY KEY (ticker, month)
      );
      CREATE TABLE IF NOT EXISTS px_fetch (ticker TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trained_at TEXT NOT NULL,
        horizon INTEGER NOT NULL,
        report_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_scores (
        ticker TEXT PRIMARY KEY,
        bucket TEXT NOT NULL,
        prob REAL NOT NULL,
        pct_rank REAL NOT NULL,
        why_json TEXT NOT NULL,
        run_id INTEGER NOT NULL
      );`);
    }
    return fn(db);
  } finally {
    db.close();
  }
}

// ---- Universe --------------------------------------------------------------------

export function modelUniverse(): Array<{ t: string; market: string; mcap: number }> {
  const ctx = loadCtx();
  const inactive = inactiveListingTickers();
  const out: Array<{ t: string; market: string; mcap: number }> = [];
  for (const [t, co] of ctx.cos) {
    if ((co.market !== "NSE" && co.market !== "NSE SME") || inactive.has(t)) continue;
    const m = ctx.mcap.get(t);
    if (m == null || m < MODEL.minMcapCr || m > MODEL.maxMcapCr) continue;
    out.push({ t, market: co.market, mcap: m });
  }
  return out.sort((a, b) => a.t.localeCompare(b.t));
}

// ---- Time helpers ------------------------------------------------------------------

/** "2026-08-14" → "2026-09-30" (calendar quarter end). */
function bucketOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const qm = Math.ceil(m / 3) * 3;
  const last = new Date(Date.UTC(y, qm, 0)).getUTCDate();
  return `${y}-${String(qm).padStart(2, "0")}-${last}`;
}
function prevBucket(b: string): string {
  const y = Number(b.slice(0, 4));
  const m = Number(b.slice(5, 7)) - 3;
  return bucketOf(m <= 0 ? `${y - 1}-${String(m + 12).padStart(2, "0")}-01` : `${y}-${String(m).padStart(2, "0")}-01`);
}
function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}
/** Month in which the filing is public (quarter end + lag). */
function entryMonth(bucket: string): string {
  const d = new Date(`${bucket}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + MODEL.lagDays);
  return d.toISOString().slice(0, 7);
}

// ---- Pipeline steps --------------------------------------------------------------------

const STOP_KEY = "__smModelStop";
type StopHolder = { [STOP_KEY]?: boolean };
export function stopModelRun(): void {
  (globalThis as StopHolder)[STOP_KEY] = true;
}

type Progress = (done: number, total: number, filled: number) => void;

/** Steps: shareholding history → monthly prices → train → score the universe. */
export async function runModelPipeline(
  onProgress: Progress,
  opts?: { skipData?: boolean },
): Promise<FillResult> {
  const holder = globalThis as StopHolder;
  holder[STOP_KEY] = false;
  const uni = modelUniverse();
  let done = 0;
  let filled = 0;
  let failed = 0;

  // 1. Filings: how many quarters each symbol already has.
  const have = withStakeDb((db) => {
    const m = new Map<string, Set<string>>();
    for (const r of db.prepare(`SELECT DISTINCT symbol, quarter FROM holder_stakes`).all() as Array<{
      symbol: string;
      quarter: string;
    }>) {
      if (!m.has(r.symbol)) m.set(r.symbol, new Set());
      m.get(r.symbol)!.add(bucketOf(r.quarter));
    }
    return m;
  }, true);
  const tried = withModelDb((db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS backfill_done (ticker TEXT PRIMARY KEY, at TEXT NOT NULL, quarters INTEGER)`);
    return new Set(
      (db.prepare(`SELECT ticker FROM backfill_done`).all() as Array<{ ticker: string }>).map((r) => r.ticker),
    );
  });
  const fillTodo = opts?.skipData
    ? []
    : uni.filter((u) => !tried.has(u.t) && (have.get(u.t)?.size ?? 0) < MODEL.quarters);

  // 2. Prices: anything not fetched in 7 days.
  const freshPx = withModelDb(
    (db) =>
      new Set(
        (
          db
            .prepare(`SELECT ticker FROM px_fetch WHERE fetched_at >= ?`)
            .all(new Date(Date.now() - 7 * 86_400_000).toISOString()) as Array<{ ticker: string }>
        ).map((r) => r.ticker),
      ),
  );
  const pxTodo = opts?.skipData ? [] : uni.filter((u) => !freshPx.has(u.t));
  const total = fillTodo.length + pxTodo.length + 2;
  onProgress(0, total, 0);

  // Two companies at a time (four got us blocked); stop on a run of refusals.
  let refusedRun = 0;
  let blocked = false;
  for (let i = 0; i < fillTodo.length && !blocked; i += 2) {
    if (holder[STOP_KEY]) return { tried: done, filled, left: total - done, not_found: failed };
    await Promise.all(
      fillTodo.slice(i, i + 2).map(async (u) => {
        try {
          await scanHolders(u.t, u.market, MODEL.quarters - 1);
          filled++;
          withModelDb((db) =>
            db
              .prepare(`INSERT OR REPLACE INTO backfill_done (ticker, at, quarters) VALUES (?, ?, ?)`)
              .run(u.t, new Date().toISOString(), MODEL.quarters),
          );
          refusedRun = 0;
        } catch (e) {
          failed++;
          if (/NSE 4(03|29)|XBRL 4(03|29)/.test(String(e))) refusedRun++;
        }
        done++;
      }),
    );
    if (refusedRun >= 5) {
      // NSE is refusing us: note it, skip the rest of the history step, retry on a later run.
      blocked = true;
      withModelDb((db) => {
        db.exec(`CREATE TABLE IF NOT EXISTS model_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
        db.prepare(`INSERT OR REPLACE INTO model_meta (k, v) VALUES ('nse_blocked_at', ?)`).run(new Date().toISOString());
      });
      done += fillTodo.length - Math.min(fillTodo.length, i + 2);
    }
    onProgress(done, total, filled);
    await new Promise((r) => setTimeout(r, 600));
  }

  const savePx = (ticker: string, bars: Array<{ date: string; close: number }>) => {
    const byMonth = new Map<string, number>();
    for (const b of bars) if (Number.isFinite(b.close) && b.close > 0) byMonth.set(b.date.slice(0, 7), b.close);
    withModelDb((db) => {
      db.transaction(() => {
        const ins = db.prepare(`INSERT OR REPLACE INTO px_monthly (ticker, month, close) VALUES (?, ?, ?)`);
        for (const [m, c] of byMonth) ins.run(ticker, m, c);
        db.prepare(`INSERT OR REPLACE INTO px_fetch (ticker, fetched_at, n) VALUES (?, ?, ?)`).run(
          ticker,
          new Date().toISOString(),
          byMonth.size,
        );
      })();
    });
  };
  if (!opts?.skipData) {
    try {
      savePx("^NIFTY", monthlyBarsFromDaily(await fetchNiftyDailyBars(4)));
    } catch {
      /* retried next run */
    }
  }
  for (let i = 0; i < pxTodo.length; i += 3) {
    if (holder[STOP_KEY]) return { tried: done, filled, left: total - done, not_found: failed };
    await Promise.all(
      pxTodo.slice(i, i + 3).map(async (u) => {
        try {
          savePx(u.t, await fetchMonthlyBars(u.t, u.market, 4));
        } catch {
          failed++;
        }
        done++;
      }),
    );
    onProgress(done, total, filled);
  }

  // 3–4. Train, test, refit, score.
  trainAndScore();
  done += 2;
  onProgress(done, total, filled);
  return { tried: done, filled, left: 0, not_found: failed };
}

// ---- Dataset ------------------------------------------------------------------------------

type Snap = { named: Map<string, number>; promoter: number };

function loadSnaps(syms: Set<string>): Map<string, Map<string, Snap>> {
  const out = new Map<string, Map<string, Snap>>();
  // Latest filing date wins within a quarter bucket.
  const pickDate = new Map<string, string>();
  const rows = withStakeDb(
    (db) =>
      db.prepare(`SELECT symbol, quarter, holder, category, pct FROM holder_stakes`).all() as Array<{
        symbol: string;
        quarter: string;
        holder: string;
        category: string | null;
        pct: number | null;
      }>,
    true,
  );
  for (const r of rows) {
    if (!syms.has(r.symbol)) continue;
    const k = `${r.symbol}|${bucketOf(r.quarter)}`;
    const cur = pickDate.get(k);
    if (!cur || r.quarter > cur) pickDate.set(k, r.quarter);
  }
  for (const r of rows) {
    if (!syms.has(r.symbol)) continue;
    const b = bucketOf(r.quarter);
    if (pickDate.get(`${r.symbol}|${b}`) !== r.quarter) continue;
    if (!out.has(r.symbol)) out.set(r.symbol, new Map());
    const m = out.get(r.symbol)!;
    if (!m.has(b)) m.set(b, { named: new Map(), promoter: 0 });
    const s = m.get(b)!;
    const pct = r.pct ?? 0;
    if (/promoter/i.test(r.category ?? "")) s.promoter += pct;
    else {
      const key = nameKey(r.holder);
      s.named.set(key, (s.named.get(key) ?? 0) + pct);
    }
  }
  return out;
}

function loadPx(): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  withModelDb((db) => {
    for (const r of db.prepare(`SELECT ticker, month, close FROM px_monthly`).all() as Array<{
      ticker: string;
      month: string;
      close: number;
    }>) {
      if (!out.has(r.ticker)) out.set(r.ticker, new Map());
      out.get(r.ticker)!.set(r.month, r.close);
    }
  });
  return out;
}

function ret(px: Map<string, number> | undefined, from: string, to: string): number | null {
  const a = px?.get(from);
  const b = px?.get(to);
  return a && b ? b / a - 1 : null;
}

function buildRows(): { rows: Row[]; lastMonth: string } {
  const uni = modelUniverse();
  const syms = new Set(uni.map((u) => u.t));
  const snaps = loadSnaps(syms);
  const px = loadPx();
  const nifty = px.get("^NIFTY");
  const lastMonth = [...(nifty?.keys() ?? [])].sort().at(-1) ?? new Date().toISOString().slice(0, 7);
  const match = buildMatcher();
  // Matcher works on raw names; keys are normalised the same way, so it still hits.
  const trackedOf = (key: string) => match(key);

  type Draft = Row & { buyers: string[] };
  const drafts: Draft[] = [];
  for (const [sym, byB] of snaps) {
    for (const [b, cur] of byB) {
      const prev = byB.get(prevBucket(b));
      if (!prev) continue;
      let nNew = 0, nUp = 0, nDown = 0, nExit = 0, newPct = 0, tBuy = 0, tHold = 0;
      const buyers: string[] = [];
      let sumCur = 0, sumPrev = 0;
      const tb = new Set<string>(), th = new Set<string>();
      for (const [h, p] of cur.named) {
        sumCur += p;
        const pp = prev.named.get(h);
        const inv = trackedOf(h);
        if (inv) th.add(inv);
        if (pp == null) {
          nNew++;
          newPct += p;
          buyers.push(h);
          if (inv) tb.add(inv);
        } else if (p - pp > 0.05) {
          nUp++;
          buyers.push(h);
          if (inv) tb.add(inv);
        } else if (pp - p > 0.05) nDown++;
      }
      for (const [h, pp] of prev.named) {
        sumPrev += pp;
        if (!cur.named.has(h)) nExit++;
      }
      tBuy = tb.size;
      tHold = th.size;
      const entry = entryMonth(b);
      const p = px.get(sym);
      const m6 = ret(p, addMonths(entry, -7), addMonths(entry, -1));
      const n6 = ret(nifty, addMonths(entry, -7), addMonths(entry, -1));
      const exit = addMonths(entry, MODEL.horizon);
      const r = exit <= lastMonth ? ret(p, entry, exit) : null;
      const rn = exit <= lastMonth ? ret(nifty, entry, exit) : null;
      const excess = r != null && rn != null ? r - rn : null;
      drafts.push({
        sym,
        bucket: b,
        entry,
        buyers,
        x: {
          n_new: nNew,
          n_up: nUp,
          n_down: nDown,
          n_exit: nExit,
          new_pct: newPct,
          net_pct: sumCur - sumPrev,
          prom_chg: cur.promoter - prev.promoter,
          tracked_buy: tBuy,
          tracked_hold: tHold,
          skill_buy: 0,
          skill_max: 0,
          mom6: m6 != null && n6 != null ? m6 - n6 : 0,
          n_named: Math.log1p(cur.named.size),
        },
        y: excess == null ? null : excess > 0 ? 1 : 0,
        excess,
      });
    }
  }

  // Holder skill, walk-forward: only outcomes whose window closed before this entry.
  drafts.sort((a, b) => a.entry.localeCompare(b.entry));
  const outcomes: Array<{ holder: string; closes: string; excess: number }> = [];
  for (const d of drafts)
    if (d.excess != null)
      for (const h of d.buyers) outcomes.push({ holder: h, closes: addMonths(d.entry, MODEL.horizon), excess: d.excess });
  outcomes.sort((a, b) => a.closes.localeCompare(b.closes));
  const acc = new Map<string, { s: number; n: number }>();
  let oi = 0;
  for (const d of drafts) {
    while (oi < outcomes.length && outcomes[oi]!.closes <= d.entry) {
      const o = outcomes[oi++]!;
      const a = acc.get(o.holder) ?? { s: 0, n: 0 };
      a.s += Math.max(-1, Math.min(2, o.excess));
      a.n++;
      acc.set(o.holder, a);
    }
    let sum = 0, max = 0;
    for (const h of d.buyers) {
      const a = acc.get(h);
      if (!a) continue;
      const sk = a.s / (a.n + MODEL.skillK);
      sum += sk;
      max = Math.max(max, sk);
    }
    d.x.skill_buy = sum;
    d.x.skill_max = max;
  }
  return {
    rows: drafts.map((d) => ({ sym: d.sym, bucket: d.bucket, entry: d.entry, x: d.x, y: d.y, excess: d.excess })),
    lastMonth,
  };
}

// ---- Logistic regression --------------------------------------------------------------------

type Fit = { w: number[]; b: number; mean: number[]; sd: number[] };

const clip = (v: number) => Math.max(-50, Math.min(50, v));
function vec(r: Row): number[] {
  return FEATURES.map(([id]) => clip(Number.isFinite(r.x[id]) ? r.x[id] : 0));
}

function fit(rows: Row[]): Fit {
  const X = rows.map(vec);
  const y = rows.map((r) => r.y ?? 0);
  const k = FEATURES.length;
  const mean = Array.from({ length: k }, (_, j) => X.reduce((s, x) => s + x[j]!, 0) / X.length);
  const sd = Array.from({ length: k }, (_, j) => {
    const v = X.reduce((s, x) => s + (x[j]! - mean[j]!) ** 2, 0) / X.length;
    return Math.sqrt(v) || 1;
  });
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]!) / sd[j]!));
  let w = new Array(k).fill(0) as number[];
  let b = Math.log((y.reduce((s, v) => s + v, 0) + 1) / (y.length - y.reduce((s, v) => s + v, 0) + 1));
  const lr = 0.1;
  for (let it = 0; it < 800; it++) {
    const gw = new Array(k).fill(0) as number[];
    let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      const z = Z[i]!;
      const p = 1 / (1 + Math.exp(-(b + z.reduce((s, v, j) => s + v * w[j]!, 0))));
      const e = p - y[i]!;
      gb += e;
      for (let j = 0; j < k; j++) gw[j]! += e * z[j]!;
    }
    w = w.map((wj, j) => wj - lr * (gw[j]! / Z.length + (MODEL.l2 * wj) / Z.length));
    b -= lr * (gb / Z.length);
  }
  return { w, b, mean, sd };
}

function predict(f: Fit, r: Row): { p: number; contrib: number[] } {
  const z = vec(r).map((v, j) => (v - f.mean[j]!) / f.sd[j]!);
  const contrib = z.map((v, j) => v * f.w[j]!);
  const s = f.b + contrib.reduce((a, c) => a + c, 0);
  return { p: 1 / (1 + Math.exp(-s)), contrib };
}

function auc(scored: Array<{ p: number; y: number }>): number | null {
  const pos = scored.filter((s) => s.y === 1).length;
  const neg = scored.length - pos;
  if (!pos || !neg) return null;
  const sorted = [...scored].sort((a, b) => a.p - b.p);
  let rank = 0, sumPos = 0;
  for (const s of sorted) {
    rank++;
    if (s.y === 1) sumPos += rank;
  }
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

export type ModelReport = {
  trained_at: string;
  horizon: number;
  rows_total: number;
  rows_labeled: number;
  buckets: string[];
  train_buckets: string[];
  test_buckets: string[];
  n_train: number;
  n_test: number;
  test_auc: number | null;
  /** Average 6-month excess return vs Nifty in the test quarters. */
  test_avg_excess: number | null;
  /** Same, for the model's top 10% / bottom 10% in the test quarters. */
  test_top_excess: number | null;
  test_bottom_excess: number | null;
  test_top_hit: number | null;
  test_avg_hit: number | null;
  weights: Array<{ id: string; label: string; w: number }>;
  scored: number;
  score_bucket: string | null;
  note: string;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function trainAndScore(): ModelReport {
  const { rows } = buildRows();
  const labeled = rows.filter((r) => r.y != null);
  const buckets = [...new Set(labeled.map((r) => r.bucket))].sort();
  const testB = buckets.slice(-MODEL.testQuarters);
  const trainB = buckets.slice(0, -MODEL.testQuarters);
  const train = labeled.filter((r) => trainB.includes(r.bucket));
  const test = labeled.filter((r) => testB.includes(r.bucket));
  const report: ModelReport = {
    trained_at: new Date().toISOString(),
    horizon: MODEL.horizon,
    rows_total: rows.length,
    rows_labeled: labeled.length,
    buckets,
    train_buckets: trainB,
    test_buckets: testB,
    n_train: train.length,
    n_test: test.length,
    test_auc: null,
    test_avg_excess: null,
    test_top_excess: null,
    test_bottom_excess: null,
    test_top_hit: null,
    test_avg_hit: null,
    weights: [],
    scored: 0,
    score_bucket: null,
    note: "",
  };
  if (train.length >= 200 && test.length >= 50) {
    const f = fit(train);
    const sc = test.map((r) => ({ ...predict(f, r), y: r.y!, excess: r.excess! }));
    report.test_auc = auc(sc);
    const sorted = [...sc].sort((a, b) => b.p - a.p);
    const dec = Math.max(1, Math.round(sorted.length / 10));
    report.test_avg_excess = mean(sc.map((s) => s.excess));
    report.test_top_excess = mean(sorted.slice(0, dec).map((s) => s.excess));
    report.test_bottom_excess = mean(sorted.slice(-dec).map((s) => s.excess));
    report.test_top_hit = mean(sorted.slice(0, dec).map((s) => s.y));
    report.test_avg_hit = mean(sc.map((s) => s.y));
  } else {
    report.note = `Not enough history to test yet (${train.length} training rows, ${test.length} test rows) — run the data steps first.`;
  }

  // Refit on everything labeled; score each symbol's newest quarter.
  if (labeled.length >= 200) {
    const f = fit(labeled);
    report.weights = FEATURES.map(([id, label], j) => ({ id, label, w: f.w[j]! })).sort(
      (a, b) => Math.abs(b.w) - Math.abs(a.w),
    );
    const latest = new Map<string, Row>();
    for (const r of rows) {
      const cur = latest.get(r.sym);
      if (!cur || r.bucket > cur.bucket) latest.set(r.sym, r);
    }
    // Only quarters recent enough to act on.
    const newest = [...latest.values()].map((r) => r.bucket).sort().at(-1) ?? null;
    const live = [...latest.values()].filter((r) => newest && r.bucket >= prevBucket(newest));
    const preds = live.map((r) => ({ r, ...predict(f, r) })).sort((a, b) => a.p - b.p);
    report.scored = preds.length;
    report.score_bucket = newest;
    withModelDb((db) => {
      const run = db
        .prepare(`INSERT INTO model_runs (trained_at, horizon, report_json) VALUES (?, ?, ?)`)
        .run(report.trained_at, MODEL.horizon, JSON.stringify(report));
      const runId = Number(run.lastInsertRowid);
      db.transaction(() => {
        db.prepare(`DELETE FROM model_scores`).run();
        const ins = db.prepare(
          `INSERT INTO model_scores (ticker, bucket, prob, pct_rank, why_json, run_id) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        preds.forEach((x, i) => {
          const why = FEATURES.map(([id, label], j) => ({ id, label, c: x.contrib[j]!, v: x.r.x[id] }))
            .filter((w) => Math.abs(w.c) > 0.05)
            .sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
            .slice(0, 4);
          ins.run(x.r.sym, x.r.bucket, x.p, preds.length > 1 ? i / (preds.length - 1) : 0.5, JSON.stringify(why), runId);
        });
      })();
    });
  } else {
    withModelDb((db) =>
      db
        .prepare(`INSERT INTO model_runs (trained_at, horizon, report_json) VALUES (?, ?, ?)`)
        .run(report.trained_at, MODEL.horizon, JSON.stringify(report)),
    );
  }
  return report;
}

// ---- Read side ------------------------------------------------------------------------

export type ModelScore = {
  ticker: string;
  bucket: string;
  prob: number;
  pct_rank: number;
  why: Array<{ id: string; label: string; c: number; v: number }>;
};

export function loadModelScores(): Map<string, ModelScore> {
  try {
    return withModelDb((db) => {
      const rows = db.prepare(`SELECT ticker, bucket, prob, pct_rank, why_json FROM model_scores`).all() as Array<{
        ticker: string;
        bucket: string;
        prob: number;
        pct_rank: number;
        why_json: string;
      }>;
      return new Map(rows.map((r) => [r.ticker, { ...r, why: JSON.parse(r.why_json) as ModelScore["why"] }]));
    });
  } catch {
    return new Map();
  }
}

export function latestReport(): ModelReport | null {
  try {
    return withModelDb((db) => {
      const r = db.prepare(`SELECT report_json FROM model_runs ORDER BY id DESC LIMIT 1`).get() as
        | { report_json: string }
        | undefined;
      return r ? (JSON.parse(r.report_json) as ModelReport) : null;
    });
  } catch {
    return null;
  }
}

export function dataStatus(): { universe: number; backfilled: number; priced: number; nse_blocked_at: string | null } {
  const uni = modelUniverse();
  return withModelDb((db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS backfill_done (ticker TEXT PRIMARY KEY, at TEXT NOT NULL, quarters INTEGER)`);
    const bf = new Set((db.prepare(`SELECT ticker FROM backfill_done`).all() as Array<{ ticker: string }>).map((r) => r.ticker));
    const px = new Set((db.prepare(`SELECT ticker FROM px_fetch WHERE n > 0`).all() as Array<{ ticker: string }>).map((r) => r.ticker));
    db.exec(`CREATE TABLE IF NOT EXISTS model_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    const blk = db.prepare(`SELECT v FROM model_meta WHERE k = 'nse_blocked_at'`).get() as { v: string } | undefined;
    return {
      universe: uni.length,
      backfilled: uni.filter((u) => bf.has(u.t)).length,
      priced: uni.filter((u) => px.has(u.t)).length,
      // A block only matters until the next successful fetch.
      nse_blocked_at:
        blk?.v &&
        blk.v > ((db.prepare(`SELECT MAX(at) AS at FROM backfill_done`).get() as { at: string | null }).at ?? "")
          ? blk.v
          : null,
    };
  });
}

// ---- Combination test: trusted boards × smart money ---------------------------------------

export type ComboCell = { n: number; avg: number | null; median: number | null; hit: number | null };
export type ComboTest = {
  horizon: number;
  trust_cut: number;
  periods: Array<{
    id: "all" | "recent";
    label: string;
    buckets: string[];
    /** smart = what counts as "smart money" for that table. */
    tables: Array<{ smart: "tracked" | "buyer"; label: string; cells: Record<"hi_yes" | "hi_no" | "lo_yes" | "lo_no" | "all", ComboCell> }>;
  }>;
  caveat: string;
};

function cell(xs: number[]): ComboCell {
  if (!xs.length) return { n: 0, avg: null, median: null, hit: null };
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  const r1 = (v: number) => Math.round(v * 1000) / 10;
  return {
    n: xs.length,
    avg: r1(xs.reduce((a, b) => a + b, 0) / xs.length),
    median: r1(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2),
    hit: Math.round((xs.filter((v) => v > 0).length / xs.length) * 1000) / 10,
  };
}

/**
 * Does smart money add anything on top of a trusted board? Every past quarter with
 * a known 6-month result, split by board trust (Shortlist score, top half vs bottom
 * half) and by smart money (tracked investors holding / any 1%+ holder buying).
 */
export function comboTest(trustOf: Map<string, number>): ComboTest {
  const { rows } = buildRows();
  const known = rows.filter((r) => r.excess != null && trustOf.has(r.sym));
  const ts = [...new Set(known.map((r) => r.sym))].map((s) => trustOf.get(s)!).sort((a, b) => a - b);
  const cut = ts.length ? ts[ts.length >> 1]! : 50;
  const buckets = [...new Set(known.map((r) => r.bucket))].sort();
  const recent = buckets.slice(-MODEL.testQuarters);
  const table = (rs: Row[], smart: "tracked" | "buyer") => {
    const isSmart = (r: Row) => (smart === "tracked" ? r.x.tracked_hold > 0 : r.x.n_new + r.x.n_up > 0);
    const pick = (hi: boolean, yes: boolean) =>
      rs.filter((r) => trustOf.get(r.sym)! >= cut === hi && isSmart(r) === yes).map((r) => r.excess!);
    return {
      smart,
      label: smart === "tracked" ? "Your 6 tracked investors hold it" : "A new or adding 1%+ holder this quarter",
      cells: {
        hi_yes: cell(pick(true, true)),
        hi_no: cell(pick(true, false)),
        lo_yes: cell(pick(false, true)),
        lo_no: cell(pick(false, false)),
        all: cell(rs.map((r) => r.excess!)),
      },
    };
  };
  const period = (id: "all" | "recent", label: string, bs: string[]) => {
    const set = new Set(bs);
    const rs = known.filter((r) => set.has(r.bucket));
    return { id, label, buckets: bs, tables: [table(rs, "tracked"), table(rs, "buyer")] };
  };
  return {
    horizon: MODEL.horizon,
    trust_cut: cut,
    periods: [period("all", "All past quarters", buckets), period("recent", "Newest quarters only", recent)],
    caveat:
      "Board trust is today's board, not the board at the time — a small look-ahead. Only stocks that pass today's Shortlist safety checks are included.",
  };
}
