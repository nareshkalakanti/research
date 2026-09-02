import { openSqliteNamed } from "../sqlite-utils";
import { loadAllCompanies } from "../db";
import { isEdge } from "../edge";
import { fundTagsForTicker } from "../fund-watchlists";
import { holdingsTickerSet } from "../holdings";
import { loadMetricsMap } from "../metrics";
import { loadBreakoutMap } from "../signals";
import { researchLinks } from "../links";
import { capTier, type CapTier } from "../types";
import {
  passesStrategyTags,
  type StrategyTagFilters,
} from "./strategy-tags";
import type {
  ConcallDriftEvent,
  ConcallDriftRow,
  ConcallDocLinks,
  ConcallResultQuality,
  ConcallSentiment,
} from "./concall-drift-types";
import {
  isPendingInvestorMaterial,
  listInvestorMaterialsForTickers,
} from "../investor-materials";
import {
  docsFromMaterials,
  highlightsFromMaterials,
} from "./concall-highlights";
import {
  currentEarnSeasonQuarter,
  earnMatchesQuarterFilter,
  fyQuarterFromEarnEvent,
  fyQuarterSortKey,
  recentFyQuarterOptions,
  windowRange,
} from "./concall-drift-quarters";
import {
  computeDriftPct,
  priceBaselineConsistent,
} from "./concall-drift-math";
import {
  passesEarnQuality,
  CONCALL_DRIFT_JUNK_SUBJECTS,
} from "./concall-drift-earn";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function ensureSchema(): void {
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS concall_drift_events (
        id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        earn_at TEXT NOT NULL,
        concall_at TEXT,
        quarter_fy TEXT,
        earn_subject TEXT,
        concall_subject TEXT,
        baseline_close REAL,
        drift_pct REAL,
        has_baseline INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_concall_drift_earn ON concall_drift_events(earn_at);
      CREATE INDEX IF NOT EXISTS idx_concall_drift_ticker ON concall_drift_events(ticker);
    `);
  } finally {
    db.close();
  }
}

function passesCapFilter(
  mcap: number | null | undefined,
  cap?: CapTier | "All",
): boolean {
  if (!cap || cap === "All") return true;
  if (cap === "NC") return mcap == null || Number.isNaN(mcap);
  return capTier(mcap) === cap;
}

function companyMeta(ticker: string) {
  const c = loadAllCompanies().find(
    (row) => row.ticker.toUpperCase() === ticker.toUpperCase(),
  );
  const links = researchLinks(
    c?.ticker ?? ticker,
    c?.market,
    c?.website ?? null,
  );
  return {
    name: c?.name || ticker,
    market: c?.market || "NSE",
    sector: c?.sector ?? null,
    market_cap_cr: c?.mcap_cr ?? null,
    price: c?.price ?? null,
    sc: links.sc,
    tv: links.tv,
    web: links.web,
  };
}

function isFresh(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && Date.now() - ts < TTL_MS;
}

export function recentlyFetchedConcallTickers(maxAgeMs = 30 * 60 * 1000): Set<string> {
  ensureSchema();
  const cutoff = Date.now() - maxAgeMs;
  const out = new Set<string>();
  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const latest = db
      .prepare(
        `SELECT ticker, MAX(fetched_at) AS fetched_at
         FROM concall_drift_events GROUP BY ticker`,
      )
      .all() as Array<{ ticker: string; fetched_at: string }>;
    for (const row of latest) {
      const ts = Date.parse(row.fetched_at);
      if (Number.isFinite(ts) && ts >= cutoff) out.add(row.ticker.toUpperCase());
    }
    const logged = db
      .prepare(
        `SELECT ticker, fetched_at FROM strategy_scan_log WHERE scan_type = 'concall_drift'`,
      )
      .all() as Array<{ ticker: string; fetched_at: string }>;
    for (const row of logged) {
      const ts = Date.parse(row.fetched_at);
      if (Number.isFinite(ts) && ts >= cutoff) out.add(row.ticker.toUpperCase());
    }
  } finally {
    db.close();
  }
  return out;
}

export function upsertConcallDriftEvents(events: ConcallDriftEvent[]): number {
  if (!events.length) return 0;
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  const now = new Date().toISOString();
  try {
    const stmt = db.prepare(`
      INSERT INTO concall_drift_events (
        id, ticker, earn_at, concall_at, quarter_fy, earn_subject, concall_subject,
        baseline_close, drift_pct, has_baseline, source, fetched_at
      ) VALUES (
        @id, @ticker, @earn_at, @concall_at, @quarter_fy, @earn_subject, @concall_subject,
        @baseline_close, @drift_pct, @has_baseline, @source, @fetched_at
      )
      ON CONFLICT(id) DO UPDATE SET
        earn_at = excluded.earn_at,
        concall_at = COALESCE(excluded.concall_at, concall_at),
        quarter_fy = excluded.quarter_fy,
        earn_subject = excluded.earn_subject,
        concall_subject = CASE
          WHEN excluded.concall_at IS NOT NULL THEN excluded.concall_subject
          ELSE concall_subject
        END,
        baseline_close = excluded.baseline_close,
        drift_pct = excluded.drift_pct,
        has_baseline = excluded.has_baseline,
        fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction((batch: ConcallDriftEvent[]) => {
      for (const e of batch) {
        stmt.run({
          ...e,
          has_baseline: e.has_baseline ? 1 : 0,
          fetched_at: now,
        });
      }
    });
    tx(events);
    return events.length;
  } finally {
    db.close();
  }
}

export type ConcallDriftLoadOpts = {
  market?: string;
  cap?: CapTier | "All";
  limit?: number;
  tags?: StrategyTagFilters;
  quarter?: string | null;
  window?: string;
  from?: string | null;
  to?: string | null;
  sort?: "all" | "gainers" | "losers" | "earn";
  q?: string | null;
  sector?: string | null;
  mcapMin?: number | null;
  mcapMax?: number | null;
  onePerTicker?: boolean;
};

export type ConcallDriftFilterMeta = {
  sectors: string[];
  mcap_bounds: { min: number; max: number };
  total_events: number;
  with_baseline: number;
};

function resolveDateRange(opts?: ConcallDriftLoadOpts): { from: Date; to: Date } | null {
  return windowRange(opts?.window || "all", opts?.from, opts?.to);
}

function pickBetterDriftRow(prev: ConcallDriftRow, next: ConcallDriftRow): ConcallDriftRow {
  const prevTs = Date.parse(prev.earn_at);
  const nextTs = Date.parse(next.earn_at);
  if (nextTs !== prevTs) return nextTs > prevTs ? next : prev;
  if (Boolean(next.concall_at) !== Boolean(prev.concall_at)) {
    return next.concall_at ? next : prev;
  }
  if (next.has_baseline !== prev.has_baseline) {
    return next.has_baseline ? next : prev;
  }
  return next;
}

/** Cap slider max so one bad mcap row does not stretch the range control. */
const MCAP_SLIDER_CEILING_CR = 200_000;

function saneMcap(mcap: number | null | undefined): number | null {
  if (mcap == null || Number.isNaN(mcap)) return null;
  if (mcap < 0 || mcap > MCAP_SLIDER_CEILING_CR) return null;
  return mcap;
}

function mcapSliderBounds(mcaps: number[]): { min: number; max: number } {
  if (mcaps.length === 0) return { min: 0, max: 1000 };

  const sorted = [...mcaps].sort((a, b) => a - b);
  const minMcap = sorted[0]!;
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = sorted[p95Index] ?? sorted[sorted.length - 1]!;
  const saneMax = Math.min(Math.max(p95, minMcap), MCAP_SLIDER_CEILING_CR);

  return {
    min: Math.floor(minMcap),
    max: Math.ceil(Math.max(saneMax, minMcap + 1)),
  };
}

function passesMcapRange(
  mcap: number | null | undefined,
  min?: number | null,
  max?: number | null,
): boolean {
  if (min == null && max == null) return true;
  if (mcap == null || Number.isNaN(mcap)) return false;
  if (min != null && mcap < min) return false;
  if (max != null && mcap > max) return false;
  return true;
}

function passesSectorFilter(
  sector: string | null | undefined,
  filter?: string | null,
): boolean {
  if (!filter) return true;
  return (sector || "").trim().toLowerCase() === filter.trim().toLowerCase();
}

type RawEventRow = {
  id: string;
  ticker: string;
  earn_at: string;
  concall_at: string | null;
  quarter_fy: string | null;
  earn_subject: string | null;
  concall_subject: string | null;
  baseline_close: number | null;
  drift_pct: number | null;
  has_baseline: number;
  source: string;
};

function loadRawEvents(): RawEventRow[] {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    return db
      .prepare(
        `SELECT id, ticker, earn_at, concall_at, quarter_fy, earn_subject, concall_subject,
                baseline_close, drift_pct, has_baseline, source
         FROM concall_drift_events
         ORDER BY earn_at DESC`,
      )
      .all() as RawEventRow[];
  } finally {
    db.close();
  }
}

function smePriceTrusted(
  market: string,
  ticker: string,
  price: number | null,
): boolean {
  if (market !== "NSE SME" || price == null) return market !== "NSE SME";
  const m = loadMetricsMap().get(ticker.toUpperCase());
  if (!m?.yf_symbol?.includes("-SM.NS")) return false;
  return true;
}

function resultQualityFromDrift(
  drift: number | null,
  hasBaseline: boolean,
): ConcallResultQuality | null {
  if (!hasBaseline || drift == null) return null;
  if (drift >= 8) return "excellent";
  if (drift >= 3) return "strong";
  if (drift <= -3) return "weak";
  return "mixed";
}

function sentimentFromDrift(
  drift: number | null,
  hasBaseline: boolean,
): ConcallSentiment | null {
  if (!hasBaseline || drift == null) return "neutral";
  if (drift >= 5) return "bullish";
  if (drift >= 1.5) return "optimistic";
  if (drift <= -5) return "bearish";
  return "neutral";
}

function enrichConcallDriftRows(rows: ConcallDriftRow[]): ConcallDriftRow[] {
  if (!rows.length) return rows;
  const byTicker = listInvestorMaterialsForTickers(rows.map((r) => r.ticker));
  return rows.map((row) => {
    const materials = (byTicker.get(row.ticker.toUpperCase()) ?? []).filter(
      (m) => !isPendingInvestorMaterial(m),
    );
    return {
      ...row,
      docs: docsFromMaterials(materials),
      highlights: highlightsFromMaterials(materials),
    };
  });
}

function rowToOutput(row: RawEventRow, meta: ReturnType<typeof companyMeta>): ConcallDriftRow {
  const priceOk = smePriceTrusted(meta.market, row.ticker, meta.price);
  const consistent =
    priceOk &&
    row.has_baseline === 1 &&
    row.baseline_close != null &&
    meta.price != null &&
    priceBaselineConsistent(meta.price, row.baseline_close);
  const drift = consistent
    ? computeDriftPct(meta.price, row.baseline_close)
    : null;

  const breakout = loadBreakoutMap().get(row.ticker.toUpperCase());
  const key = row.ticker.toUpperCase();

  const output: ConcallDriftRow = {
    ticker: row.ticker,
    name: meta.name,
    market: meta.market,
    sector: meta.sector,
    market_cap_cr: meta.market_cap_cr,
    price: meta.price,
    earn_at: row.earn_at,
    concall_at: row.concall_at,
    quarter_fy: fyQuarterFromEarnEvent(row.earn_at, row.earn_subject),
    baseline_close: consistent ? row.baseline_close : null,
    drift_pct: drift,
    has_baseline: consistent,
    earn_subject: row.earn_subject,
    has_bb: Boolean(breakout?.has_bb),
    has_bb_w: Boolean(breakout?.has_bb_w),
    has_bb_m: Boolean(breakout?.has_bb_m),
    has_tq: Boolean(breakout?.has_tq),
    has_edge: isEdge(row.ticker),
    has_hold: holdingsTickerSet().has(key),
    fund_tags: fundTagsForTicker(row.ticker),
    docs: { summary: null, transcript: null, ppt: null },
    highlights: [],
    result_quality: resultQualityFromDrift(drift, consistent),
    mgmt_sentiment: sentimentFromDrift(drift, consistent),
    sc: meta.sc,
    tv: meta.tv,
    web: meta.web,
  };
  return output;
}

function passesEarnRow(row: RawEventRow, output: ConcallDriftRow): boolean {
  return passesEarnQuality(row.earn_subject, output.has_baseline);
}

function passesRowFilters(
  row: RawEventRow,
  opts: ConcallDriftLoadOpts | undefined,
  range: { from: Date; to: Date } | null,
): { ok: boolean; meta?: ReturnType<typeof companyMeta> } {
  const earnTs = Date.parse(row.earn_at);
  if (!Number.isFinite(earnTs)) return { ok: false };
  if (range && (earnTs < range.from.getTime() || earnTs > range.to.getTime())) {
    return { ok: false };
  }

  if (
    opts?.quarter &&
    !earnMatchesQuarterFilter(row.earn_at, row.earn_subject, opts.quarter)
  ) {
    return { ok: false };
  }

  const meta = companyMeta(row.ticker);
  if (opts?.market && opts.market !== "All") {
    if (opts.market === "NSE") {
      if (meta.market !== "NSE" && meta.market !== "NSE SME") return { ok: false };
    } else if (meta.market !== opts.market) return { ok: false };
  }
  if (!passesCapFilter(meta.market_cap_cr, opts?.cap)) return { ok: false };
  if (!passesStrategyTags(row.ticker, meta.market, opts?.tags)) return { ok: false };
  if (!passesSectorFilter(meta.sector, opts?.sector)) return { ok: false };
  if (!passesMcapRange(meta.market_cap_cr, opts?.mcapMin, opts?.mcapMax)) {
    return { ok: false };
  }

  const q = (opts?.q || "").trim().toLowerCase();
  if (q) {
    const blob = `${row.ticker} ${meta.name} ${meta.sector || ""}`.toLowerCase();
    if (!blob.includes(q)) return { ok: false };
  }

  return { ok: true, meta };
}

export function concallDriftFilterMeta(
  opts?: Omit<ConcallDriftLoadOpts, "sector" | "mcapMin" | "mcapMax" | "sort" | "q" | "limit">,
): ConcallDriftFilterMeta {
  const range = resolveDateRange(opts);
  const rows = loadRawEvents();
  const sectors = new Set<string>();
  const mcaps: number[] = [];
  let total = 0;
  let withBaseline = 0;
  const bestByTicker = new Map<string, ConcallDriftRow>();

  for (const row of rows) {
    const { ok, meta } = passesRowFilters(row, opts, range);
    if (!ok || !meta) continue;

    const output = rowToOutput(row, meta);
    if (!passesEarnRow(row, output)) continue;

    const onePerTicker = opts?.onePerTicker !== false;
    if (onePerTicker) {
      const key = row.ticker.toUpperCase();
      const prev = bestByTicker.get(key);
      if (!prev) {
        bestByTicker.set(key, output);
      } else {
        bestByTicker.set(key, pickBetterDriftRow(prev, output));
      }
      continue;
    }

    total += 1;
    if (output.has_baseline) withBaseline += 1;
    if (meta.sector) sectors.add(meta.sector);
    const sane = saneMcap(meta.market_cap_cr);
    if (sane != null) mcaps.push(sane);
  }

  if (opts?.onePerTicker !== false) {
    for (const output of bestByTicker.values()) {
      total += 1;
      if (output.has_baseline) withBaseline += 1;
      if (output.sector) sectors.add(output.sector);
      const sane = saneMcap(output.market_cap_cr);
      if (sane != null) mcaps.push(sane);
    }
  }

  return {
    sectors: [...sectors].sort((a, b) => a.localeCompare(b)),
    mcap_bounds: mcapSliderBounds(mcaps),
    total_events: total,
    with_baseline: withBaseline,
  };
}

export function loadConcallDriftRows(opts?: ConcallDriftLoadOpts): ConcallDriftRow[] {
  const range = resolveDateRange(opts);
  const rows = loadRawEvents();
  const onePerTicker = opts?.onePerTicker !== false;
  const out: ConcallDriftRow[] = [];
  const bestByTicker = new Map<string, ConcallDriftRow>();

  for (const row of rows) {
    const { ok, meta } = passesRowFilters(row, opts, range);
    if (!ok || !meta) continue;

    const output = rowToOutput(row, meta);
    if (!passesEarnRow(row, output)) continue;

    if (!onePerTicker) {
      out.push(output);
      continue;
    }

    const key = row.ticker.toUpperCase();
    const prev = bestByTicker.get(key);
    if (!prev) {
      bestByTicker.set(key, output);
      continue;
    }
    bestByTicker.set(key, pickBetterDriftRow(prev, output));
  }

  if (onePerTicker) out.push(...bestByTicker.values());

  const sort = opts?.sort || "all";
  if (sort === "gainers") {
    const filtered = out.filter((r) => r.has_baseline && (r.drift_pct ?? 0) > 0);
    filtered.sort(
      (a, b) =>
        (b.drift_pct ?? -Infinity) - (a.drift_pct ?? -Infinity) ||
        Date.parse(b.earn_at) - Date.parse(a.earn_at),
    );
    return enrichConcallDriftRows(opts?.limit ? filtered.slice(0, opts.limit) : filtered);
  }
  if (sort === "losers") {
    const filtered = out.filter((r) => r.has_baseline && (r.drift_pct ?? 0) < 0);
    filtered.sort(
      (a, b) =>
        (a.drift_pct ?? Infinity) - (b.drift_pct ?? Infinity) ||
        Date.parse(b.earn_at) - Date.parse(a.earn_at),
    );
    return enrichConcallDriftRows(opts?.limit ? filtered.slice(0, opts.limit) : filtered);
  }

  out.sort((a, b) => Date.parse(b.earn_at) - Date.parse(a.earn_at));
  const sliced = opts?.limit && out.length > opts.limit ? out.slice(0, opts.limit) : out;
  return enrichConcallDriftRows(sliced);
}

/** Quarters present in scan data, merged with recent earn seasons. */
export function concallDriftQuarterOptions(limit = 8): string[] {
  const fromEvents = new Set<string>();
  for (const row of loadRawEvents()) {
    fromEvents.add(fyQuarterFromEarnEvent(row.earn_at, row.earn_subject));
  }
  const current = currentEarnSeasonQuarter();
  const merged = new Set<string>([current, ...fromEvents, ...recentFyQuarterOptions(4)]);
  return [...merged]
    .sort((a, b) => fyQuarterSortKey(b) - fyQuarterSortKey(a))
    .slice(0, limit);
}

/** Drop rows that are clearly not financial-result announcements. */
export function pruneConcallDriftJunk(): number {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    const subjects = [
      ...CONCALL_DRIFT_JUNK_SUBJECTS,
      "Copy of Newspaper Publication",
    ];
    const placeholders = subjects.map(() => "?").join(", ");
    const result = db
      .prepare(
        `DELETE FROM concall_drift_events WHERE earn_subject IN (${placeholders})`,
      )
      .run(...subjects);
    return result.changes;
  } finally {
    db.close();
  }
}

/** Unique tickers with earn events — for targeted price refresh. */
export function concallDriftTickerList(): Array<{
  ticker: string;
  market: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ ticker: string; market: string }> = [];
  for (const row of loadRawEvents()) {
    const key = row.ticker.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = companyMeta(key);
    out.push({ ticker: key, market: meta.market });
  }
  return out;
}

export function concallDriftStats(): { events: number; tickers: number } {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const events = (
      db.prepare(`SELECT COUNT(*) AS n FROM concall_drift_events`).get() as {
        n: number;
      }
    ).n;
    const tickers = (
      db
        .prepare(`SELECT COUNT(DISTINCT ticker) AS n FROM concall_drift_events`)
        .get() as { n: number }
    ).n;
    return { events, tickers };
  } finally {
    db.close();
  }
}

export function concallDriftScanProgress(opts?: {
  market?: string;
}): { pending: number; scanned: number; universe: number } {
  const companies = loadAllCompanies().filter((c) =>
    ["NSE", "NSE SME"].includes(c.market),
  );
  let filtered = companies;
  if (opts?.market && opts.market !== "All") {
    if (opts.market === "NSE") {
      filtered = companies.filter(
        (c) => c.market === "NSE" || c.market === "NSE SME",
      );
    } else {
      filtered = companies.filter((c) => c.market === opts.market);
    }
  }
  const universe = filtered.length;
  const pending = pendingConcallDriftTickers({ market: opts?.market }).length;
  return { pending, scanned: Math.max(0, universe - pending), universe };
}

export function pendingConcallDriftTickers(opts?: {
  market?: string;
  missingOnly?: boolean;
}): string[] {
  ensureSchema();
  const missingOnly = opts?.missingOnly !== false;
  const companies = loadAllCompanies().filter((c) =>
    ["NSE", "NSE SME"].includes(c.market),
  );
  let filtered = companies;
  if (opts?.market && opts.market !== "All") {
    if (opts.market === "NSE") {
      filtered = companies.filter(
        (c) => c.market === "NSE" || c.market === "NSE SME",
      );
    } else {
      filtered = companies.filter((c) => c.market === opts.market);
    }
  }

  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const done = new Set<string>();
    if (missingOnly) {
      const latest = db
        .prepare(
          `SELECT ticker, MAX(fetched_at) AS fetched_at
           FROM concall_drift_events GROUP BY ticker`,
        )
        .all() as Array<{ ticker: string; fetched_at: string }>;
      for (const row of latest) {
        if (isFresh(row.fetched_at)) done.add(row.ticker.toUpperCase());
      }
      const logged = db
        .prepare(
          `SELECT ticker, fetched_at FROM strategy_scan_log WHERE scan_type = 'concall_drift'`,
        )
        .all() as Array<{ ticker: string; fetched_at: string }>;
      for (const row of logged) {
        if (isFresh(row.fetched_at)) done.add(row.ticker.toUpperCase());
      }

      return filtered
        .map((c) => c.ticker.toUpperCase())
        .filter((t) => !done.has(t))
        .sort();
    }
    return filtered.map((c) => c.ticker.toUpperCase()).sort();
  } finally {
    db.close();
  }
}

/** Names with a recent earn cycle whose NSE fetch is stale — used by Update concalls. */
export function recentConcallDriftTickers(opts?: {
  market?: string;
}): string[] {
  ensureSchema();
  const companies = loadAllCompanies().filter((c) =>
    ["NSE", "NSE SME"].includes(c.market),
  );
  let filtered = companies;
  if (opts?.market && opts.market !== "All") {
    if (opts.market === "NSE") {
      filtered = companies.filter(
        (c) => c.market === "NSE" || c.market === "NSE SME",
      );
    } else {
      filtered = companies.filter((c) => c.market === opts.market);
    }
  }
  const allowed = new Set(filtered.map((c) => c.ticker.toUpperCase()));
  const RECENT_EARN_MS = 45 * 86_400_000;
  const STALE_MS = 30 * 60 * 1000;

  const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
  try {
    const rows = db
      .prepare(
        `SELECT ticker, MAX(earn_at) AS earn_at, MAX(fetched_at) AS fetched_at,
                MAX(CASE WHEN concall_at IS NULL OR TRIM(COALESCE(concall_at, '')) = '' THEN 1 ELSE 0 END) AS missing_concall
         FROM concall_drift_events
         GROUP BY ticker`,
      )
      .all() as Array<{
        ticker: string;
        earn_at: string;
        fetched_at: string;
        missing_concall: number;
      }>;

    return rows
      .filter((row) => {
        const t = row.ticker.toUpperCase();
        if (!allowed.has(t)) return false;
        const earnAge = Date.now() - Date.parse(row.earn_at);
        if (!Number.isFinite(earnAge) || earnAge > RECENT_EARN_MS) return false;
        const fetchAge = Date.now() - Date.parse(row.fetched_at);
        if (Number.isFinite(fetchAge) && fetchAge < STALE_MS) return false;
        return true;
      })
      .sort((a, b) => {
        const am = a.missing_concall ? 0 : 1;
        const bm = b.missing_concall ? 0 : 1;
        if (am !== bm) return am - bm;
        return Date.parse(b.earn_at) - Date.parse(a.earn_at);
      })
      .map((row) => row.ticker.toUpperCase());
  } finally {
    db.close();
  }
}

export type ConcallDriftRepairCandidate = {
  id: string;
  ticker: string;
  market: string;
  earn_at: string;
  earn_subject: string | null;
};

/** Rows missing concall_at — grouped for NSE re-pairing. */
export function loadConcallDriftRepairCandidates(
  limit = 24,
  tickers?: Set<string> | null,
): ConcallDriftRepairCandidate[] {
  const out: ConcallDriftRepairCandidate[] = [];
  const seenTicker = new Set<string>();

  for (const row of loadRawEvents()) {
    if (row.concall_at) continue;
    const t = row.ticker.toUpperCase();
    if (tickers && !tickers.has(t)) continue;
    if (seenTicker.has(t) && out.filter((r) => r.ticker === t).length >= 3) continue;

    const meta = companyMeta(t);
    out.push({
      id: row.id,
      ticker: t,
      market: meta.market,
      earn_at: row.earn_at,
      earn_subject: row.earn_subject,
    });
    seenTicker.add(t);
    if (out.length >= limit) break;
  }
  return out;
}

export function patchConcallDriftPairing(
  id: string,
  patch: {
    concall_at: string;
    concall_subject: string | null;
    quarter_fy: string;
  },
): void {
  ensureSchema();
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.prepare(
      `UPDATE concall_drift_events
       SET concall_at = @concall_at,
           concall_subject = @concall_subject,
           quarter_fy = @quarter_fy,
           fetched_at = @fetched_at
       WHERE id = @id`,
    ).run({
      id,
      concall_at: patch.concall_at,
      concall_subject: patch.concall_subject,
      quarter_fy: patch.quarter_fy,
      fetched_at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}
