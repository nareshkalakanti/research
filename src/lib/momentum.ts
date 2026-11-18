import { inactiveListingTickers } from "./listing-sync";
import {
  buildStock,
  expectedQuarter,
  loadCtx,
  recentQuarter,
  recentlyTried,
  runFill,
  type FillResult,
  type Progress,
} from "./nanocap-champs";
import { quarterRankFromPanel } from "./quarter-rank";
import { buildQuarterPanel, qoqFromPanel, yoyFromPanel, type QuarterPanel, type QuarterPoint } from "./quarter-panel";
import { screenerPausedUntil } from "./screener-fetch";
import { fetchScreenerQuarterlyFundamentals } from "./screener-quarters";
import { fetchScreenerTopRatios, loadScreenerRatiosMap } from "./screener-ratios";
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
  sector: string | null;
  sub_sector: string | null;
  website: string | null;
  /** Zaubacorp page (exact when the CIN is known, else a search) — set only when the board is not known. */
  zauba_url: string | null;
};

export type MomPage = {
  basket: "mom";
  strong: MomStock[];
  near: MomStock[];
  coverage: {
    scored: number;
    fresh: number;
    to_try: number;
    /** Recent results but no ROCE / ROE yet — can't be judged on the 7 rules. */
    no_ratios: number;
    /** Of those, not tried in the last week. */
    ratio_to_try: number;
    /** Stocks this fill has given ROCE / ROE so far (all time). */
    ratio_filled: number;
    /** …of which now have all 7 rules judgeable (the rest are loss-making etc.). */
    ratio_scored: number;
    /** ROCE / ROE pages fetched per hour over the last 3 hours. */
    ratio_pace: number;
    /** When the next 30-min background batch is due (ISO), if the app has run one. */
    next_auto_at: string | null;
    paused_until: string | null;
    used_last_hour: number;
  };
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
  /** Recent results but no ROCE / ROE — fastest growers first. */
  const noRatios: Array<{ t: string; q: number }> = [];
  for (const [t, { qs }] of raw) {
    if (inactive.has(t)) continue;
    const r = ratiosOf(t);
    if ((r.roe == null || r.roce == null) && qs.length >= 5 && recentQuarter(qs[qs.length - 1]?.date ?? null)) {
      const panel = buildQuarterPanel(qs);
      noRatios.push({ t, q: (panel && quarterRankFromPanel(panel)?.score) ?? 0 });
    }
    const s = scoreOne(qs, r);
    if (!s || s.provisional) continue;
    scored.push({ t, qs, panel: s.panel, passed: s.passed, quarterScore: s.quarterScore });
  }
  noRatios.sort((a, b) => b.q - a.q);
  return { raw, scored, ratiosOf, ratioQueue: noRatios.map((x) => x.t) };
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
    sector: null,
    sub_sector: null,
    website: null,
    zauba_url: null,
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

/** Kinds that share the hourly Screener budget (this basket + the 30-min background refresh). */
const BUDGET_KINDS = [FILL_KIND, "momratio", "auto"] as const;

/** Screener pages asked for in the last hour by this basket and the background refresh. */
export function usedLastHour(): number {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  return withAttempts(
    (db) =>
      (db
        .prepare(
          `SELECT COUNT(*) AS n FROM nano_fill_attempts WHERE kind IN (${BUDGET_KINDS.map(() => "?").join(",")}) AND attempted_at >= ?`,
        )
        .get(...BUDGET_KINDS, since) as { n: number }).n,
  );
}

/** Pages still allowed this hour. */
export function screenerBudgetLeft(): number {
  return Math.max(0, MOM_RULES.fetchesPerHour - usedLastHour());
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

/** Sector › sub-sector (classifications.db — same label Scan and Rotation use) and website, for listed rows only. */
function addLabels(rows: MomStock[]): void {
  if (!rows.length) return;
  const ph = rows.map(() => "?").join(",");
  const keys = rows.map((r) => r.ticker);
  const bySym = new Map(rows.map((r) => [r.ticker, r]));
  try {
    const db = openSqliteNamed("classifications.db", { readonly: true, wal: true });
    try {
      for (const c of db
        .prepare(
          `SELECT UPPER(ticker) AS t, sector, sub_sector FROM classifications
           WHERE UPPER(ticker) IN (${ph}) AND TRIM(COALESCE(sector, '')) != ''`,
        )
        .all(...keys) as Array<{ t: string; sector: string; sub_sector: string | null }>) {
        const r = bySym.get(c.t);
        if (r && !r.sector) {
          r.sector = c.sector;
          r.sub_sector = c.sub_sector || null;
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* labels optional */
  }
  try {
    const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
    try {
      for (const c of db
        .prepare(
          `SELECT UPPER(ticker) AS t, website FROM company_about
           WHERE UPPER(ticker) IN (${ph}) AND TRIM(COALESCE(website, '')) != ''`,
        )
        .all(...keys) as Array<{ t: string; website: string }>) {
        const r = bySym.get(c.t);
        if (r) r.website = c.website.trim();
      }
    } finally {
      db.close();
    }
  } catch {
    /* website optional */
  }
  addZaubaLinks(rows);
}

/** Zaubacorp company URL: NAME-WITH-DASHES-CIN (the slug Zaubacorp itself uses). */
export function zaubaUrl(name: string, cin: string | null | undefined): string {
  const slug = name
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/\bLTD\b\.?/g, "LIMITED")
    .replace(/\bPVT\b\.?/g, "PRIVATE")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const c = String(cin || "").trim().toUpperCase();
  if (/^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/.test(c)) return `https://www.zaubacorp.com/${slug}-${c}`;
  // No CIN on file: Zaubacorp blocks server lookups, so open a search that lands on its page.
  return `https://www.google.com/search?q=${encodeURIComponent(`site:zaubacorp.com ${name}`)}`;
}

/** Board-not-known rows get a Zaubacorp link to check the directors by hand. */
function addZaubaLinks(rows: MomStock[]): void {
  const need = rows.filter((r) => r.checks.some((c) => c.id === "board" && c.ok == null));
  if (!need.length) return;
  const cins = new Map<string, string>();
  try {
    const db = openSqliteNamed("governance.db", { readonly: true, wal: true });
    try {
      const ph = need.map(() => "?").join(",");
      for (const c of db
        .prepare(
          `SELECT UPPER(ticker) AS t, cin FROM companies
           WHERE UPPER(ticker) IN (${ph}) AND TRIM(COALESCE(cin, '')) != ''`,
        )
        .all(...need.map((r) => r.ticker)) as Array<{ t: string; cin: string }>)
        cins.set(c.t, c.cin);
    } finally {
      db.close();
    }
  } catch {
    /* CIN optional */
  }
  for (const r of need) r.zauba_url = zaubaUrl(r.name, cins.get(r.ticker));
}

/** What the ROCE / ROE fill has achieved: filled, now scoreable, and the real recent pace. */
function ratioFillStats(
  ratiosOf: (t: string) => { roe: number | null; roce: number | null },
  scoredSet: Set<string>,
): { ratio_filled: number; ratio_scored: number; ratio_pace: number } {
  const rows = withAttempts(
    (db) =>
      db.prepare(`SELECT ticker, attempted_at FROM nano_fill_attempts WHERE kind = 'momratio'`).all() as Array<{
        ticker: string;
        attempted_at: string;
      }>,
  );
  const since = new Date(Date.now() - 3 * 3_600_000).toISOString();
  let filled = 0;
  let scoredNow = 0;
  let recent = 0;
  for (const r of rows) {
    const x = ratiosOf(r.ticker);
    if (x.roe != null && x.roce != null) filled += 1;
    if (scoredSet.has(r.ticker)) scoredNow += 1;
    if (r.attempted_at >= since) recent += 1;
  }
  return { ratio_filled: filled, ratio_scored: scoredNow, ratio_pace: Math.round(recent / 3) };
}

/** Last background refresh + 30 min (read directly — baskets-refresh imports this file). */
function nextAutoAt(): string | null {
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      const row = db
        .prepare(`SELECT value FROM baskets_refresh_meta WHERE key = 'baskets_refresh_last'`)
        .get() as { value: string } | undefined;
      return row?.value ? new Date(Date.parse(row.value) + 30 * 60_000).toISOString() : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
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
  const { raw, scored, ratiosOf, ratioQueue } = scoreUniverse();
  const ctx = loadCtx();
  const triedRatios = recentlyTried("momratio");
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
  addLabels([...strong, ...near]);
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
      no_ratios: ratioQueue.length,
      ratio_to_try: ratioQueue.filter((t) => !triedRatios.has(t)).length,
      ...ratioFillStats(ratiosOf, new Set(scored.map((x) => x.t))),
      next_auto_at: nextAutoAt(),
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
  const budget = screenerBudgetLeft();
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

/**
 * Fetch ROCE / ROE (Screener top ratios) for stocks with recent results but
 * none stored, fastest growers first, inside the shared hourly budget. With
 * `quiet`, an exhausted budget just returns (background refresh).
 */
/** Fast run: one page every ~6–9 s (the global 2.5–5 s gap + this), about 450 an hour. */
const FAST_EXTRA_MS = 3_500;
const STOP_KEY = "__momRatioStop";
type StopHolder = { [STOP_KEY]?: boolean };

/** Ask a running ROCE / ROE fill to stop after the current stock. */
export function stopMomRatios(): void {
  (globalThis as StopHolder)[STOP_KEY] = true;
}

/**
 * Fetch ROCE / ROE (Screener top ratios) for stocks with recent results but
 * none stored, fastest growers first. Normal runs stay inside the shared
 * hourly budget; `fast` runs the whole queue at a steady ~450 an hour and
 * stops at the first sign of a block. With `quiet`, an exhausted budget just
 * returns (background refresh).
 */
export async function fillMomRatios(
  limit: number,
  onProgress?: Progress,
  quiet = false,
  opts?: { fast?: boolean },
): Promise<FillResult> {
  const empty: FillResult = { tried: 0, filled: 0, left: 0, not_found: 0 };
  const fast = !!opts?.fast;
  const until = screenerPausedUntil();
  if (until) {
    if (quiet) return empty;
    throw new Error(`Screener paused until ${until}`);
  }
  const budget = fast ? limit : screenerBudgetLeft();
  if (budget <= 0) {
    if (quiet) return empty;
    throw new Error(`Hourly Screener limit reached (${MOM_RULES.fetchesPerHour} pages) — try again in an hour.`);
  }
  const holder = globalThis as StopHolder;
  holder[STOP_KEY] = false;
  const { ratioQueue } = scoreUniverse();
  let n = 0;
  try {
    return await runFill(
      "momratio",
      ratioQueue,
      Math.min(limit, budget),
      async (t) => {
        // The ratio fetch swallows errors — check the pause first so a block stops the run.
        const paused = screenerPausedUntil();
        if (paused) throw new Error(`Screener paused until ${paused}`);
        if (fast && n > 0) await new Promise((r) => setTimeout(r, FAST_EXTRA_MS * (0.6 + Math.random() * 0.8)));
        n += 1;
        // Let the list pick up new scores now and then during a long run.
        if (n % 50 === 0) pageCache = null;
        const r = await fetchScreenerTopRatios(t, { force: true });
        return r.roe != null && r.roce != null;
      },
      onProgress,
      () => !!holder[STOP_KEY],
    );
  } finally {
    holder[STOP_KEY] = false;
    pageCache = null;
  }
}

/** BSE-only main-board names (market "BSE") still missing quarters or ROCE / ROE. */
export function bseFillQueue(): string[] {
  const inactive = inactiveListingTickers();
  const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
  let tickers: string[];
  try {
    tickers = (
      db.prepare(`SELECT UPPER(ticker) AS t FROM company_about WHERE UPPER(TRIM(market)) = 'BSE'`).all() as Array<{
        t: string;
      }>
    ).map((r) => r.t);
  } finally {
    db.close();
  }
  const raw = loadRawQuarters();
  const screener = loadScreenerRatiosMap();
  return tickers.filter((t) => {
    if (inactive.has(t)) return false;
    const r = screener.get(t);
    return (raw.get(t)?.qs.length ?? 0) < 5 || r?.roe == null || r?.roce == null;
  });
}

/**
 * New BSE-only listings: quarters, then ROCE / ROE (each from Screener, at
 * the fast run's steady ~450 pages an hour; stops at the first block).
 */
export async function fillBseMain(onProgress?: Progress): Promise<FillResult> {
  const until = screenerPausedUntil();
  if (until) throw new Error(`Screener paused until ${until}`);
  const holder = globalThis as StopHolder;
  holder[STOP_KEY] = false;
  let n = 0;
  const pause = async () => {
    if (n++ > 0) await new Promise((r) => setTimeout(r, FAST_EXTRA_MS * (0.6 + Math.random() * 0.8)));
  };
  try {
    return await runFill(
      "bse",
      bseFillQueue(),
      5000,
      async (t) => {
        const paused = screenerPausedUntil();
        if (paused) throw new Error(`Screener paused until ${paused}`);
        await pause();
        const qs = await fetchScreenerQuarterlyFundamentals(t);
        if (!qs.length) return false;
        await pause();
        const r = await fetchScreenerTopRatios(t);
        if (n % 40 === 0) pageCache = null;
        return qs.length >= 5 && r.roe != null && r.roce != null;
      },
      onProgress,
      () => !!holder[STOP_KEY],
    );
  } finally {
    holder[STOP_KEY] = false;
    pageCache = null;
  }
}
