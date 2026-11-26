import { loadAllCompanies } from "./db";
import {
  analyzeBases,
  IPO2_BEST,
  IPO2_RULES,
  type BaseVolume,
  type CorpAction,
  type Ipo2Entry,
  type Ipo2Sell,
  type Ipo2Stage,
  type ListingStrength,
} from "./ipo2-bases";
import { isRightsOrPartlyPaid } from "./listing-name-match";
import type { Lockout } from "./lockout";
import { loadMetricsMap } from "./metrics";
import { fillCandlesInBackground, igniteBar, savedCandles, type Ignite } from "./momentum-money";
import { fetchNiftyDailyBars } from "./ohlc";
import { fetchNseMainEquityList, fetchNseSmeEquityList, isNseRightsEntitlement } from "./nse-equity-lists";
import { cachedRotationCloses, onRotationBarsRefreshed, rotationBarsRefreshing, rotationCloses, type Close } from "./rotation-bars";
import { rotationFetchYears } from "./sector-rotation-series";
import { openSqliteNamed } from "./sqlite-utils";
import { masterLabels } from "./stock-master";
import { earlyGrowth, latestGrowth, savedQuarters, type EarlyGrowth, type Growth } from "./ipo-growth";

/*
 * IPO2 screen (restored for the Momentum & Money page's IPO2 tab): stocks listed in the last 4 years,
 * their bases and the kept entries (listing-range breakout, pivot breakout, E1B / E2B add), no sells.
 * Adds the two IPO V2.0 items it lacked: growth in the initial quarters, and the day-1 ignite bar.
 */
const r1 = (n: number) => Math.round(n * 10) / 10;
/* ------------------------------------------------------------------ */
/* Listing dates                                                       */
/* ------------------------------------------------------------------ */

const MON: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/** "06-OCT-2008" or "16-Nov-26" → "2008-10-06". */
export function parseNseListingDate(raw: string | null | undefined): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec((raw ?? "").trim());
  if (!m) return null;
  const mm = MON[m[2]!.toUpperCase()];
  if (!mm) return null;
  const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${mm}-${m[1]!.padStart(2, "0")}`;
}

const LIST_TTL_MS = 24 * 3_600_000;

function withStrategyDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  const db = openSqliteNamed("strategy.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS ipo_listing_dates (
      ticker TEXT PRIMARY KEY,
      board TEXT NOT NULL,
      listing_date TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )`);
    return fn(db);
  } finally {
    db.close();
  }
}

let listingMem: { at: number; map: Map<string, string> } | null = null;
let listingFetch: Promise<void> | null = null;

function readSavedListingDates(): { at: number; map: Map<string, string> } {
  return withStrategyDb((db) => {
    const rows = db.prepare(`SELECT ticker, listing_date, fetched_at FROM ipo_listing_dates`).all() as Array<{
      ticker: string;
      listing_date: string;
      fetched_at: number;
    }>;
    return {
      at: rows.reduce((a, r) => Math.max(a, r.fetched_at), 0),
      map: new Map(rows.map((r) => [r.ticker, r.listing_date])),
    };
  });
}

/** Refresh NSE main + SME listing dates (once a day, in the background). */
async function refreshListingDates(): Promise<void> {
  const [main, sme] = await Promise.all([
    fetchNseMainEquityList().catch(() => []),
    fetchNseSmeEquityList().catch(() => []),
  ]);
  if (main.length < 500 && sme.length < 100) return; // NSE refused: keep what's saved
  const at = Date.now();
  const rows: Array<[string, string, string]> = [];
  for (const [board, list] of [["NSE", main], ["NSE SME", sme]] as const)
    for (const r of list) {
      if (isNseRightsEntitlement(r)) continue;
      const iso = parseNseListingDate(r.listing_date);
      if (iso) rows.push([r.ticker.toUpperCase(), board, iso]);
    }
  withStrategyDb((db) => {
    const ins = db.prepare(
      `INSERT INTO ipo_listing_dates (ticker, board, listing_date, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET board = excluded.board, listing_date = excluded.listing_date, fetched_at = excluded.fetched_at`,
    );
    db.transaction(() => {
      for (const [t, b, dt] of rows) ins.run(t, b, dt, at);
    })();
  });
  listingMem = readSavedListingDates();
}

/** NSE listing dates (ticker → ISO). Stale or missing: returns what's saved and refreshes. */
export async function nseListingDates(opts?: { wait?: boolean }): Promise<{ map: Map<string, string>; at: number }> {
  if (!listingMem) {
    try {
      listingMem = readSavedListingDates();
    } catch {
      listingMem = { at: 0, map: new Map() };
    }
  }
  if (Date.now() - listingMem.at > LIST_TTL_MS && !listingFetch) {
    listingFetch = refreshListingDates()
      .catch(() => {})
      .finally(() => {
        listingFetch = null;
      });
  }
  if ((opts?.wait || listingMem.map.size === 0) && listingFetch) await listingFetch;
  return listingMem;
}

/* ------------------------------------------------------------------ */
/* Issue prices (NSE past issues: main board + SME)                    */
/* ------------------------------------------------------------------ */

const NSE_PAST_ISSUES = "https://www.nseindia.com/api/public-past-issues";

type IssueRec = { price: number; listing: string };
let issueMem: { at: number; map: Map<string, IssueRec> } | null = null;
let issueFetch: Promise<void> | null = null;

function withIssueDb<T>(fn: (db: ReturnType<typeof openSqliteNamed>) => T): T {
  return withStrategyDb((db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS ipo_issue_prices (
      symbol TEXT PRIMARY KEY,
      issue_price REAL NOT NULL,
      listing_date TEXT NOT NULL,
      board TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )`);
    return fn(db);
  });
}

function readSavedIssues(): { at: number; map: Map<string, IssueRec> } {
  return withIssueDb((db) => {
    const rows = db.prepare(`SELECT symbol, issue_price, listing_date, fetched_at FROM ipo_issue_prices`).all() as Array<{
      symbol: string;
      issue_price: number;
      listing_date: string;
      fetched_at: number;
    }>;
    return {
      at: rows.reduce((a, r) => Math.max(a, r.fetched_at), 0),
      map: new Map(rows.map((r) => [r.symbol, { price: r.issue_price, listing: r.listing_date }])),
    };
  });
}

/** NSE's past-issues list → issue price + listing date per symbol (equity and SME only). */
async function refreshIssuePrices(): Promise<void> {
  const res = await fetch(NSE_PAST_ISSUES, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json",
      Referer: "https://www.nseindia.com/",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) return;
  const list = (await res.json()) as Array<{
    symbol?: string;
    issuePrice?: string | null;
    listingDate?: string | null;
    securityType?: string;
  }>;
  if (!Array.isArray(list) || list.length < 200) return; // refused / truncated: keep what's saved
  const at = Date.now();
  const rows: Array<[string, number, string, string]> = [];
  for (const x of list) {
    if (x.securityType !== "Equity" && x.securityType !== "SME") continue;
    const sym = (x.symbol ?? "").trim().toUpperCase();
    const price = Number((x.issuePrice ?? "").trim());
    const listing = parseNseListingDate(x.listingDate);
    if (sym && listing && Number.isFinite(price) && price > 0) rows.push([sym, price, listing, x.securityType]);
  }
  withIssueDb((db) => {
    const ins = db.prepare(
      `INSERT INTO ipo_issue_prices (symbol, issue_price, listing_date, board, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET issue_price = excluded.issue_price, listing_date = excluded.listing_date,
         board = excluded.board, fetched_at = excluded.fetched_at`,
    );
    db.transaction(() => {
      for (const [sym, pr, dt, b] of rows) ins.run(sym, pr, dt, b, at);
    })();
  });
  issueMem = readSavedIssues();
}

/** Issue prices by NSE symbol. Stale or missing: returns what's saved and refreshes once a day. */
export async function nseIssuePrices(opts?: { wait?: boolean }): Promise<Map<string, IssueRec>> {
  if (!issueMem) {
    try {
      issueMem = readSavedIssues();
    } catch {
      issueMem = { at: 0, map: new Map() };
    }
  }
  if (Date.now() - issueMem.at > LIST_TTL_MS && !issueFetch) {
    issueFetch = refreshIssuePrices()
      .catch(() => {})
      .finally(() => {
        issueFetch = null;
      });
  }
  if ((opts?.wait || issueMem.map.size === 0) && issueFetch) await issueFetch;
  return issueMem.map;
}

/** The issue price for this listing — only when NSE's record lists within 10 days of our listing date. */
function issuePriceFor(issues: Map<string, IssueRec>, ticker: string, listing: string): number | null {
  const rec = issues.get(ticker.toUpperCase());
  if (!rec) return null;
  return Math.abs(daysBetween(rec.listing, listing)) <= 10 ? rec.price : null;
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

/** Non-cyclical sectors and current themes from the IPO V2.0 checklist. */
const FAVOURED =
  /\b(IT\b|software|computer|internet|infotech|e[ -]?commerce|e[ -]?services|new age platform|data centre|fmcg|personal care|food|dairy|snacks|consumer electronics|domestic appliances|retail|pharma|biotech|hospital|diagnostic|medical|healthcare|ayurved|renewable|solar|wind|non conventional|green)/i;

/** Industry decides; the broad sector only when there's no industry ("Trading" under Pharma isn't pharma). */
export function favouredSector(industry: string | null | undefined, sector?: string | null): boolean {
  const ind = (industry ?? "").trim();
  return FAVOURED.test(ind || (sector ?? ""));
}


export type Ipo2Row = {
  ticker: string;
  name: string;
  market: string;
  industry: string | null;
  sector: string | null;
  website: string | null;
  mcap_cr: number | null;
  listing_date: string;
  /** nse = official NSE list; history = first day in the saved prices (BSE / no NSE date). */
  listing_source: "nse" | "history";
  /** Saved prices start more than 10 days after listing: urgency and IPO base not checked. */
  history_gap: boolean;
  age_months: number;
  first_close: number;
  price: number;
  ret_pct: number;
  run_pct: number | null;
  run_base: "issue" | "first_close" | null;
  issue_price: number | null;
  issue_mismatch: boolean;
  listing_gain_pct: number | null;
  urgency: boolean | null;
  green_weeks: number | null;
  weeks_seen: number;
  green_days: number | null;
  days_seen: number;
  growth: Growth | null;
  growth_ok: boolean | null;
  /** Growth in the first quarters after listing. */
  early_growth: EarlyGrowth | null;
  /** Day-1 ignite bar (from saved daily candles; null until they're fetched). */
  ignite: Ignite | null;
  favoured: boolean;
  bases: number;
  base_depth_pct: number | null;
  /** Latest base's left / right side volume (shown, not scored). */
  base_vol: BaseVolume | null;
  stage: Ipo2Stage;
  stage_note: string;
  live_entry: Ipo2Entry | null;
  last_entry: Ipo2Entry | null;
  /** Sell signal in the last few sessions (1st / 2nd extension, climax). */
  sell_now: Ipo2Sell | null;
  /** Lockout rally running now (6/8 green weeks at the end of stage 1 / start of stage 2). */
  lockout: Lockout | null;
  /** First weeks after listing vs Nifty 50. */
  listing_strength: ListingStrength | null;
  pivot: number | null;
  to_pivot_pct: number | null;
  vol_dry: boolean | null;
  legs: number;
  /** One-day jumps treated as splits / bonuses (earlier prices adjusted). */
  corp_actions: CorpAction[];
  /** Checklist passes out of the checks we can run (urgency, growth, depth). Sector is shown, not scored for now. */
  score: number;
  last_date: string;
};

export type Ipo2Result = {
  rows: Ipo2Row[];
  universe: number;
  /** Skipped: older companies (old BSE code, or an NSE batch-listing day without a new BSE code). */
  skipped_old: number;
  no_prices: number;
  listing_dates: number;
  listing_dates_at: string | null;
  /** Rows whose first run is measured from the IPO issue price (else the listing-day close). */
  with_issue_price: number;
  /** Stocks whose prices are older than the latest trading day, now refreshing in the background. */
  stale_prices: number;
  refreshing: number;
  rules: typeof IPO2_RULES;
  built_at: string;
};

let screenCache: { at: number; result: Ipo2Result } | null = null;
let refreshHooked = false;
const SCREEN_TTL_MS = 10 * 60_000;

export function clearIpo2Cache(): void {
  screenCache = null;
}

/** Saved BSE scrip codes (ticker → numeric code). */
function bseCodes(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const db = openSqliteNamed("company_about.db", { readonly: true, wal: true });
    try {
      for (const r of db.prepare(`SELECT UPPER(ticker) AS t, scrip_code AS c FROM company_bse_scrip`).all() as Array<{
        t: string;
        c: string | null;
      }>) {
        const n = Number((r.c ?? "").trim());
        if (Number.isFinite(n) && n > 0) out.set(r.t, n);
      }
    } finally {
      db.close();
    }
  } catch {
    /* no codes saved */
  }
  return out;
}

/** Older company, not an IPO: old BSE code, or listed on an NSE batch day without a new BSE code. */
function olderCompany(t: string, nseDate: string | null, codes: Map<string, number>, bulkDays: Set<string>): boolean {
  const code = codes.get(t);
  if (code != null && code < IPO2_RULES.newBseCodeMin) return true;
  return nseDate != null && bulkDays.has(nseDate) && code == null;
}

/** NSE dates shared by many listings: batches of older BSE companies admitted to NSE. */
function bulkListingDays(nse: Map<string, string>): Set<string> {
  const dayCount = new Map<string, number>();
  for (const dt of nse.values()) dayCount.set(dt, (dayCount.get(dt) ?? 0) + 1);
  return new Set([...dayCount].filter(([, k]) => k >= IPO2_RULES.bulkListingDay).map(([dt]) => dt));
}

let bulkStartMemo: { at: number; set: Set<string> } | null = null;
/** First-trade dates (inside the saved window) shared by many stocks: data gaps, not listings. */
function bulkFirstTradeDays(years: number): Set<string> {
  if (bulkStartMemo && Date.now() - bulkStartMemo.at < SCREEN_TTL_MS) return bulkStartMemo.set;
  const windowStart = new Date(Date.now() - years * 365.25 * 86_400_000).toISOString().slice(0, 10);
  const count = new Map<string, number>();
  for (const co of loadAllCompanies()) {
    const s = cachedRotationCloses(co.ticker, (co.market || "NSE").trim(), years);
    const f = s[0]?.date;
    if (f && daysBetween(windowStart, f) > 30) count.set(f, (count.get(f) ?? 0) + 1);
  }
  const set = new Set([...count].filter(([, k]) => k >= IPO2_RULES.bulkFirstTrade).map(([dt]) => dt));
  bulkStartMemo = { at: Date.now(), set };
  return set;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** One stock's series since listing (saved prices only) and its listing date. */
function seriesSinceListing(
  ticker: string,
  market: string,
  nseDate: string | null,
  years: number,
  cutoff: string,
  bulkStarts: Set<string>,
): { series: Close[]; listing: string; source: "nse" | "history"; gap: boolean } | null {
  const all = cachedRotationCloses(ticker, market, years);
  if (all.length < 2) return null;
  const first = all[0]!.date;
  // Many stocks' saved prices starting the same day: a data gap (resumed trading), not a listing.
  const firstIsGap = bulkStarts.has(first);
  // History that reaches back to the start of the saved window: listed before it.
  const windowStart = new Date(Date.now() - years * 365.25 * 86_400_000).toISOString().slice(0, 10);
  const historyIsListing = daysBetween(windowStart, first) > 30;
  let listing: string;
  let source: "nse" | "history";
  if (nseDate && historyIsListing && !firstIsGap && daysBetween(first, nseDate) > 10) {
    // Traded before the NSE date (BSE / SME first, migrated later): count from the first trade.
    listing = first;
    source = "history";
  } else if (nseDate) {
    listing = nseDate;
    source = "nse";
  } else if (historyIsListing && !firstIsGap && !market.toUpperCase().startsWith("NSE")) {
    // BSE / BSE SME: no official date here, so the first trade. NSE stocks need NSE's date.
    listing = first;
    source = "history";
  } else return null;
  if (listing < cutoff) return null;
  const series = all.filter((b) => b.date >= listing);
  if (series.length < 2) return null;
  return { series, listing, source, gap: daysBetween(listing, series[0]!.date) > 10 };
}

/** Nifty 50 daily closes covering the listing window (Yahoo, cached in memory); null when unavailable. */
async function niftyCloses(): Promise<Close[] | null> {
  try {
    const bars = await fetchNiftyDailyBars(IPO2_RULES.maxAgeYears + 1);
    return bars.length ? bars.map((b) => ({ date: b.date, close: b.close })) : null;
  } catch {
    return null;
  }
}

export async function buildIpo2Screen(opts?: { refresh?: boolean }): Promise<Ipo2Result> {
  if (!opts?.refresh && screenCache && Date.now() - screenCache.at < SCREEN_TTL_MS) return screenCache.result;
  const R = IPO2_RULES;
  const [{ map: nse, at: nseAt }, issues, nifty] = await Promise.all([
    nseListingDates({ wait: opts?.refresh }),
    nseIssuePrices({ wait: opts?.refresh }),
    niftyCloses(),
  ]);
  const years = rotationFetchYears();
  const cutoff = new Date(Date.now() - R.maxAgeYears * 365.25 * 86_400_000).toISOString().slice(0, 10);
  const labels = masterLabels();
  const metrics = loadMetricsMap();
  const quarters = savedQuarters();
  const today = new Date().toISOString().slice(0, 10);

  const codes = bseCodes();
  const bulkDays = bulkListingDays(nse);
  const bulkStarts = bulkFirstTradeDays(years);
  const rows: Ipo2Row[] = [];
  const needCandles: Array<{ ticker: string; market: string }> = [];
  let universe = 0;
  let noPrices = 0;
  let skippedOld = 0;
  const seen = new Set<string>();
  for (const co of loadAllCompanies()) {
    const t = co.ticker.toUpperCase();
    if (seen.has(t) || /^\d+$/.test(t) || isRightsOrPartlyPaid(co.ticker, co.name)) continue;
    seen.add(t);
    const market = (co.market || "NSE").trim();
    const nseDate = nse.get(t) ?? null;
    if (nseDate && nseDate < cutoff) continue; // official date says older
    const s = seriesSinceListing(co.ticker, market, nseDate, years, cutoff, bulkStarts);
    if (s && olderCompany(t, s.source === "nse" ? nseDate : null, codes, bulkDays)) {
      skippedOld++;
      continue;
    }
    if (!s) {
      if (nseDate) {
        universe++;
        noPrices++;
      }
      continue;
    }
    universe++;
    // A series with a gap doesn't start at listing: no listing-window reads.
    const a = analyzeBases(s.series, {
      listed: true,
      issuePrice: issuePriceFor(issues, t, s.listing),
      market: s.gap ? null : nifty,
      keep: IPO2_BEST,
      sells: false,
    });
    if (!a) continue;
    const lab = labels.get(t);
    const qs = quarters.get(t);
    const g = latestGrowth(qs);
    const early = qs ? earlyGrowth(qs, s.listing) : null;
    const candles = s.gap ? null : savedCandles(t, market);
    if (!s.gap && !candles) needCandles.push({ ticker: t, market });
    const ignite = candles ? igniteBar(candles, s.listing, s.series) : null;
    const growthOk =
      g && g.sales_yoy != null && g.np_yoy != null ? g.sales_yoy >= R.growthPct && g.np_yoy >= R.growthPct : null;
    const urgency = s.gap ? null : a.urgency;
    const favoured = favouredSector(lab?.industry ?? co.sub_sector, lab?.sector ?? co.sector);
    const cur = a.bases[a.bases.length - 1] ?? null;
    const depthOk =
      cur && cur.status !== "failed" ? cur.depth_pct <= (cur.ipo_base ? R.maxDepthIpoPct : R.maxDepthPct) : null;
    const score = [urgency, growthOk, depthOk].filter((x) => x === true).length;
    rows.push({
      ticker: t,
      name: co.name,
      market,
      industry: lab?.industry ?? co.sub_sector ?? null,
      sector: lab?.sector ?? co.sector ?? null,
      website: co.website ?? null,
      mcap_cr: metrics.get(t)?.market_cap_cr ?? null,
      listing_date: s.listing,
      listing_source: s.source,
      history_gap: s.gap,
      age_months: Math.max(0, Math.round(daysBetween(s.listing, today) / 30.44)),
      first_close: a.first_close,
      price: a.last_close,
      ret_pct: r1((a.last_close / a.first_close - 1) * 100),
      run_pct: s.gap ? null : a.run_pct,
      run_base: s.gap ? null : a.run_base,
      issue_price: a.issue_price,
      issue_mismatch: a.issue_mismatch,
      listing_gain_pct: a.listing_gain_pct,
      urgency,
      green_weeks: s.gap ? null : a.green_weeks,
      weeks_seen: s.gap ? 0 : a.weeks_seen,
      green_days: s.gap ? null : a.green_days,
      days_seen: s.gap ? 0 : a.days_seen,
      growth: g,
      growth_ok: growthOk,
      early_growth: early,
      ignite,
      favoured,
      bases: a.bases.length,
      base_depth_pct: cur ? cur.depth_pct : null,
      base_vol: cur?.vol ?? null,
      stage: a.stage,
      stage_note: a.stage_note,
      live_entry: a.live_entry,
      last_entry: a.entries[a.entries.length - 1] ?? null,
      sell_now: null,
      lockout: a.lockout,
      listing_strength: a.listing_strength,
      pivot: a.pivot,
      to_pivot_pct: a.to_pivot_pct,
      vol_dry: a.vol_dry,
      legs: a.legs,
      corp_actions: a.corp_actions,
      score,
      last_date: a.last_date,
    });
  }
  // Prices older than the latest trading day: refresh in the background (queued, 6 at a time);
  // the screen rebuilds once the queue drains.
  const latest = rows.reduce((m, r) => (r.last_date > m ? r.last_date : m), "");
  const stale = rows.filter((r) => r.last_date < latest);
  if (!refreshHooked) {
    refreshHooked = true;
    onRotationBarsRefreshed(() => clearIpo2Cache());
  }
  for (const r of stale) void rotationCloses(r.ticker, r.market, years).catch(() => {});
  // Day-1 candles for the ignite bar: fetched in the background, shown on the next build.
  fillCandlesInBackground(needCandles);
  const result: Ipo2Result = {
    stale_prices: stale.length,
    refreshing: rotationBarsRefreshing(),
    rows,
    universe,
    skipped_old: skippedOld,
    no_prices: noPrices,
    listing_dates: nse.size,
    with_issue_price: rows.filter((r) => r.run_base === "issue").length,
    listing_dates_at: nseAt ? new Date(nseAt).toISOString() : null,
    rules: R,
    built_at: new Date().toISOString(),
  };
  screenCache = { at: Date.now(), result };
  return result;
}
