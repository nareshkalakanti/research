import { inactiveListingTickers } from "./listing-sync";
import {
  buildStock,
  expectedQuarter,
  loadCtx,
  recentQuarter,
  runFill,
  type FillResult,
  type Progress,
} from "./nanocap-champs";
import { quarterRankFromPanel } from "./quarter-rank";
import { buildQuarterPanel, qoqFromPanel, yoyFromPanel, type QuarterPanel, type QuarterPoint } from "./quarter-panel";
import { screenerPausedUntil } from "./screener-fetch";
import { fetchScreenerQuarterlyFundamentals } from "./screener-quarters";
import { loadScreenerRatiosMap } from "./screener-ratios";
import { sevenRuleFromPanel } from "./seven-rule-score";
import { openSqliteNamed } from "./sqlite-utils";
import { loadTickertapeRatiosMap } from "./tickertape-ratios-cache";

/**
 * Momentum basket: stocks that pass all 7 rules (ROCE, ROE, sales and profit
 * up on last quarter and last year, margin up) AND score Strong (7+/10) on the
 * Quarters growth score — then five checks that weed out one-off jumps.
 */

export const MOM_RULES = {
  minQuarterScore: 7,
  /** Sales up this much in one quarter, or this much on last year → check for a merger / one-off. */
  bigJumpQoq: 50,
  bigJumpYoy: 150,
  /** Share count (profit ÷ EPS) changed more than this vs a year ago → merger or new shares. */
  maxShareChangePct: 15,
  /** Other income above this share of net profit → profit is not from the business. */
  maxOtherIncomeShare: 0.25,
  /** P/E ÷ yearly profit growth. */
  maxPeg: 1.5,
  minIndependentShare: 1 / 3,
  /** Screener pages fetched per hour for this basket (on top of the global 2.5–5 s gap). */
  fetchesPerHour: 60,
} as const;

export type MomCheck = { id: "sustained" | "organic" | "clean" | "value" | "board"; ok: boolean | null; note: string };

export type MomStock = {
  ticker: string;
  name: string;
  market: string;
  mcap_cr: number | null;
  pe: number | null;
  roce: number | null;
  roe: number | null;
  passed: number;
  quarter_score: number;
  sales_yoy: number | null;
  np_yoy: number | null;
  sales_qoq: number | null;
  np_qoq: number | null;
  latest_quarter: string | null;
  /** 7-rule passes one quarter earlier. */
  prev_passed: number | null;
  peg: number | null;
  checks: MomCheck[];
  checks_ok: number;
  group: string | null;
};

export type MomPage = {
  basket: "mom";
  strong: MomStock[];
  near: MomStock[];
  coverage: { scored: number; fresh: number; to_try: number; paused_until: string | null; used_last_hour: number };
  rules: typeof MOM_RULES;
};

const FILL_KIND = "mom" as const;

function loadRawQuarters(): Map<string, { qs: QuarterPoint[]; fetched_at: string }> {
  const out = new Map<string, { qs: QuarterPoint[]; fetched_at: string }>();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    for (const r of db
      .prepare(`SELECT ticker, quarters_json, fetched_at FROM screener_quarters_cache`)
      .all() as Array<{ ticker: string; quarters_json: string; fetched_at: string | null }>) {
      try {
        const qs = JSON.parse(r.quarters_json) as QuarterPoint[];
        if (Array.isArray(qs) && qs.length >= 2) {
          out.set(r.ticker.toUpperCase(), {
            qs: [...qs].sort((a, b) => a.date.localeCompare(b.date)),
            fetched_at: r.fetched_at || "",
          });
        }
      } catch {
        /* skip bad row */
      }
    }
  } finally {
    db.close();
  }
  return out;
}

function rowVals(panel: QuarterPanel, label: string): Array<number | null> {
  return panel.rows.find((r) => r.label === label)?.values ?? [];
}

function finite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/** Profit ÷ EPS ≈ share count; % change latest vs a year ago (same panel, same units). */
function shareChangePct(panel: QuarterPanel): number | null {
  const np = rowVals(panel, "Net Profit");
  const eps = rowVals(panel, "EPS in Rs");
  const n = np.length;
  if (n < 5) return null;
  const a = np[n - 5], ae = eps[n - 5], b = np[n - 1], be = eps[n - 1];
  if (!finite(a) || !finite(ae) || !finite(b) || !finite(be) || a <= 0 || ae <= 0 || b <= 0 || be <= 0) return null;
  return ((b / be) / (a / ae) - 1) * 100;
}

/** Last 4 quarters' profit vs the 4 before (needs 8 consecutive quarters). */
function ttmProfitGrowth(qs: QuarterPoint[]): number | null {
  if (qs.length < 8) return null;
  const last8 = qs.slice(-8);
  const m = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
  if (m(last8[7]!.date) - m(last8[0]!.date) !== 21) return null;
  if (last8.some((q) => !finite(q.netIncome))) return null;
  const prev = last8.slice(0, 4).reduce((s, q) => s + (q.netIncome as number), 0);
  const now = last8.slice(4).reduce((s, q) => s + (q.netIncome as number), 0);
  if (prev <= 0 || now <= 0) return null;
  const g = (now / prev - 1) * 100;
  return g > -90 && g < 1000 ? g : null;
}

function scoreOne(
  qs: QuarterPoint[],
  ratios: { roe: number | null; roce: number | null },
): { panel: QuarterPanel; passed: number; provisional: boolean; quarterScore: number } | null {
  const panel = buildQuarterPanel(qs);
  if (!panel?.labels?.length) return null;
  const seven = sevenRuleFromPanel(panel, ratios);
  const rank = quarterRankFromPanel(panel);
  if (!seven || !rank) return null;
  return { panel, passed: seven.passed, provisional: seven.provisional, quarterScore: rank.score };
}

type Scored = { t: string; qs: QuarterPoint[]; panel: QuarterPanel; passed: number; quarterScore: number };

function scoreUniverse() {
  const raw = loadRawQuarters();
  const screener = loadScreenerRatiosMap();
  const tape = loadTickertapeRatiosMap();
  const inactive = inactiveListingTickers();
  const ratiosOf = (t: string) => ({
    roe: screener.get(t)?.roe ?? tape.get(t)?.roe ?? null,
    roce: screener.get(t)?.roce ?? tape.get(t)?.roce ?? null,
  });
  const scored: Scored[] = [];
  for (const [t, { qs }] of raw) {
    if (inactive.has(t)) continue;
    const s = scoreOne(qs, ratiosOf(t));
    if (!s || s.provisional) continue;
    scored.push({ t, qs, panel: s.panel, passed: s.passed, quarterScore: s.quarterScore });
  }
  return { raw, scored, ratiosOf };
}

function buildRow(s: Scored, ctx: ReturnType<typeof loadCtx>, ratiosOf: (t: string) => { roe: number | null; roce: number | null }): MomStock {
  const base = buildStock(s.t, ctx);
  const { roe, roce } = ratiosOf(s.t);
  const yoy = yoyFromPanel(s.panel);
  const qoq = qoqFromPanel(s.panel);
  const prev = s.qs.length > 2 ? scoreOne(s.qs.slice(0, -1), { roe, roce }) : null;

  const checks: MomCheck[] = [];
  // 1) Sustained: last quarter already looked good (5+ of 7).
  checks.push(
    prev
      ? { id: "sustained", ok: prev.passed >= 5, note: `${prev.passed}/7 the quarter before` }
      : { id: "sustained", ok: null, note: "no earlier quarter" },
  );
  // 2) Organic: no giant jump and no big change in share count.
  const share = shareChangePct(s.panel);
  const bigJump =
    (finite(qoq?.sales_qoq) && qoq!.sales_qoq > MOM_RULES.bigJumpQoq) ||
    (finite(yoy?.sales_yoy) && yoy!.sales_yoy > MOM_RULES.bigJumpYoy);
  const shareMoved = share != null && Math.abs(share) > MOM_RULES.maxShareChangePct;
  checks.push({
    id: "organic",
    ok: bigJump || shareMoved ? false : true,
    note: shareMoved
      ? `share count ${share! > 0 ? "+" : ""}${Math.round(share!)}% vs last year — merger or new shares?`
      : bigJump
        ? "sales jumped very sharply — check for an acquisition or one-off order"
        : share != null
          ? `share count steady (${share > 0 ? "+" : ""}${Math.round(share)}%)`
          : "steady growth",
  });
  // 3) Clean profit: other income a small part of net profit.
  const oi = rowVals(s.panel, "Other Income");
  const np = rowVals(s.panel, "Net Profit");
  const oiLast = oi.length ? oi[oi.length - 1] : null;
  const npLast = np.length ? np[np.length - 1] : null;
  const oiShare = finite(oiLast) && finite(npLast) && npLast > 0 ? oiLast / npLast : null;
  checks.push(
    oiShare == null
      ? { id: "clean", ok: oi.length ? null : true, note: oi.length ? "other income unknown" : "no other income reported" }
      : {
          id: "clean",
          ok: oiShare <= MOM_RULES.maxOtherIncomeShare,
          note: `other income ${Math.round(oiShare * 100)}% of profit`,
        },
  );
  // 4) Price not ahead of the numbers: P/E ÷ yearly profit growth.
  const g = ttmProfitGrowth(s.qs);
  const peg = base.pe != null && base.pe > 0 && g != null && g > 0 ? base.pe / g : null;
  checks.push(
    peg == null
      ? { id: "value", ok: null, note: base.pe == null ? "no P/E" : "yearly profit growth unknown" }
      : { id: "value", ok: peg <= MOM_RULES.maxPeg, note: `P/E ${base.pe!.toFixed(0)} ÷ growth ${Math.round(g!)}% = ${peg.toFixed(2)}` },
  );
  // 5) Board: at least a third independent.
  checks.push(
    // 0 independent or all independent = roles not filled in yet, not a real board.
    base.board >= 3 && base.independent > 0 && base.independent < base.board
      ? {
          id: "board",
          ok: base.independent / base.board >= MOM_RULES.minIndependentShare,
          note: `${base.independent} of ${base.board} directors independent`,
        }
      : { id: "board", ok: null, note: "board not known" },
  );

  return {
    ticker: s.t,
    name: base.name,
    market: base.market,
    mcap_cr: base.mcap_cr,
    pe: base.pe,
    roce,
    roe,
    passed: s.passed,
    quarter_score: s.quarterScore,
    sales_yoy: yoy?.sales_yoy ?? null,
    np_yoy: yoy?.np_yoy ?? null,
    sales_qoq: qoq?.sales_qoq ?? null,
    np_qoq: qoq?.np_qoq ?? null,
    latest_quarter: s.qs[s.qs.length - 1]?.date ?? null,
    prev_passed: prev?.passed ?? null,
    peg,
    checks,
    checks_ok: checks.filter((c) => c.ok === true).length,
    group: base.group ?? null,
  };
}

function rank(a: MomStock, b: MomStock): number {
  const fails = (s: MomStock) => s.checks.filter((c) => c.ok === false).length;
  return fails(a) - fails(b) || b.checks_ok - a.checks_ok || b.quarter_score - a.quarter_score;
}

function withAttempts<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("metrics.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS nano_fill_attempts (
      ticker TEXT NOT NULL, kind TEXT NOT NULL, attempted_at TEXT NOT NULL, PRIMARY KEY (ticker, kind))`);
    return fn(db);
  } finally {
    db.close();
  }
}

/** Screener pages this basket asked for in the last hour. */
function usedLastHour(): number {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  return withAttempts(
    (db) =>
      (db
        .prepare(`SELECT COUNT(*) AS n FROM nano_fill_attempts WHERE kind = ? AND attempted_at >= ?`)
        .get(FILL_KIND, since) as { n: number }).n,
  );
}

/**
 * Stocks worth refreshing: scored 5+ of 7 (could reach 7/7) but the stored
 * results miss the quarter everyone has reported by now, and the cached copy
 * is over 7 days old (younger copies would not hit Screener anyway).
 */
function refreshQueue(raw: Map<string, { qs: QuarterPoint[]; fetched_at: string }>, scored: Scored[]): string[] {
  const want = expectedQuarter();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  return scored
    .filter((s) => s.passed >= 5 && (s.qs[s.qs.length - 1]?.date ?? "") < want)
    .filter((s) => (raw.get(s.t)?.fetched_at ?? "") < weekAgo)
    .sort((a, b) => b.passed - a.passed || b.quarterScore - a.quarterScore)
    .map((s) => s.t);
}

// Scoring ~3,000 quarter series takes several seconds — reuse for a minute.
const CACHE_MS = 60_000;
let pageCache: { at: number; page: MomPage } | null = null;

export function buildMomPage(): MomPage {
  if (pageCache && Date.now() - pageCache.at < CACHE_MS) {
    return { ...pageCache.page, coverage: { ...pageCache.page.coverage, used_last_hour: usedLastHour() } };
  }
  const page = computeMomPage();
  pageCache = { at: Date.now(), page };
  return page;
}

function computeMomPage(): MomPage {
  const { raw, scored, ratiosOf } = scoreUniverse();
  const ctx = loadCtx();
  const fresh = scored.filter((s) => recentQuarter(s.qs[s.qs.length - 1]?.date ?? null));
  const strong: MomStock[] = [];
  const near: MomStock[] = [];
  for (const s of fresh) {
    if (s.quarterScore < MOM_RULES.minQuarterScore) continue;
    if (s.passed === 7) strong.push(buildRow(s, ctx, ratiosOf));
    else if (s.passed === 6) near.push(buildRow(s, ctx, ratiosOf));
  }
  strong.sort(rank);
  near.sort(rank);
  let paused: string | null = null;
  try {
    paused = screenerPausedUntil();
  } catch {
    /* table may not exist yet */
  }
  return {
    basket: "mom",
    strong,
    near,
    coverage: {
      scored: scored.length,
      fresh: fresh.length,
      to_try: refreshQueue(raw, scored).length,
      paused_until: paused,
      used_last_hour: usedLastHour(),
    },
    rules: MOM_RULES,
  };
}

/** Refresh quarterly results for near-passers, inside the hourly Screener budget. */
export async function fillMomQuarters(limit: number, onProgress?: Progress): Promise<FillResult> {
  const until = screenerPausedUntil();
  if (until) throw new Error(`Screener paused until ${until}`);
  const budget = MOM_RULES.fetchesPerHour - usedLastHour();
  if (budget <= 0) {
    throw new Error(`Hourly Screener limit reached (${MOM_RULES.fetchesPerHour} pages) — try again in an hour.`);
  }
  const { raw, scored } = scoreUniverse();
  const queue = refreshQueue(raw, scored);
  try {
    return await runFill(
      FILL_KIND,
      queue,
      Math.min(limit, budget),
      async (t) => {
        const qs = await fetchScreenerQuarterlyFundamentals(t);
        return qs.length >= 5;
      },
      onProgress,
    );
  } finally {
    pageCache = null;
  }
}
