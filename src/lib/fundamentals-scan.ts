/**
 * Scan PEAD table: YoY growth, OPM/ROCE chips, percentile PEAD, tech from
 * cached signals. All figures from caches — no issuer special-cases.
 */
import { openSqliteNamed } from "./sqlite-utils";
import { opmYoyDeltaBps } from "./opm-math";
import {
  buildQuarterPanel,
  extraMetricsFromPanel,
  yoyFromPanel,
  type QuarterPoint,
} from "./quarter-panel";
import { loadQuarterMetricsMap } from "./quarter-metrics-cache";
import { loadRoceDeltaMap } from "./screener-annual";
import {
  peadScoreClass,
  peadScoresPercentile,
  type PeadInputs,
} from "./pead-score";

export type ChipBand = "High" | "Med" | "Low";

export type FundamentalsScanRow = {
  sales_yoy: number | null;
  np_yoy: number | null;
  rev_growth: ChipBand | null;
  margin_exp: ChipBand | null;
  roce_impr: ChipBand | null;
  pead: number | null;
  pead_band: ChipBand | null;
  tech_strength: string | null;
  tech_change: string | null;
};

export function bandGrowth(v: number | null | undefined): ChipBand | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 20) return "High";
  if (v >= 8) return "Med";
  return "Low";
}

export function bandMarginBps(bps: number | null | undefined): ChipBand | null {
  if (bps == null || !Number.isFinite(bps)) return null;
  if (bps >= 50) return "High";
  if (bps > 0) return "Med";
  return "Low";
}

export function bandRoceDelta(pp: number | null | undefined): ChipBand | null {
  if (pp == null || !Number.isFinite(pp)) return null;
  if (pp >= 1) return "High";
  if (pp > 0) return "Med";
  return "Low";
}

export function bandPead(score: number | null | undefined): ChipBand | null {
  const c = peadScoreClass(score);
  if (c === "pead-good") return "High";
  if (c === "pead-mid") return "Med";
  if (c === "pead-bad") return "Low";
  return null;
}

/**
 * Screenshot Tech Strength: daily SMA 20 / 50 / 200 stack vs price.
 * Separate from PEAD. Do not use Scan EMA, TQ, or 12−1 as a stand-in.
 */
export function techFromSmaStack(opts: {
  price: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
}): { strength: string; change: string } | null {
  const p = opts.price;
  const s20 = opts.sma20;
  const s50 = opts.sma50;
  const s200 = opts.sma200;
  if (p == null || !Number.isFinite(p)) return null;
  const has200 = s200 != null && Number.isFinite(s200);
  const has50 = s50 != null && Number.isFinite(s50);
  const has20 = s20 != null && Number.isFinite(s20);
  if (!has200 && !has50 && !has20) return null;

  if (has20 && has50 && has200) {
    const stacked = p > s20 && s20 > s50 && s50 > s200;
    const above200 = p > s200;
    const above50 = p > s50;
    let strength = "Weak";
    if (stacked) strength = "Very Strong";
    else if (above200 && above50) strength = "Strong";
    else if (above200) strength = "Neutral";
    const change =
      strength === "Very Strong"
        ? "Improved"
        : strength === "Strong"
          ? "Stable"
          : "Deteriorating";
    return { strength, change };
  }
  if (has200) {
    if (p > s200 && has50 && p > s50) {
      return { strength: "Strong", change: "Stable" };
    }
    if (p > s200) return { strength: "Neutral", change: "Deteriorating" };
    return { strength: "Weak", change: "Deteriorating" };
  }
  return null;
}

type QuarterOverlay = {
  sales_yoy: number | null;
  np_yoy: number | null;
  eps_yoy: number | null;
  ebidt_yoy: number | null;
  sales_qoq: number | null;
  np_qoq: number | null;
  eps_qoq: number | null;
  ebidt_qoq: number | null;
  opm_bps: number | null;
};

function firstFinite(
  ...vals: Array<number | null | undefined>
): number | null {
  for (const v of vals) {
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

let overlayCache: { at: number; map: Map<string, QuarterOverlay> } | null =
  null;
const OVERLAY_CACHE_MS = 60_000;

function loadQuarterOverlayMap(): Map<string, QuarterOverlay> {
  const now = Date.now();
  if (overlayCache && now - overlayCache.at < OVERLAY_CACHE_MS) {
    return overlayCache.map;
  }
  const map = new Map<string, QuarterOverlay>();
  try {
    const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
    try {
      const rows = db
        .prepare(`SELECT ticker, quarters_json FROM screener_quarters_cache`)
        .all() as Array<{ ticker: string; quarters_json: string }>;
      for (const row of rows) {
        let quarters: QuarterPoint[];
        try {
          quarters = JSON.parse(row.quarters_json) as QuarterPoint[];
        } catch {
          continue;
        }
        if (!Array.isArray(quarters) || !quarters.length) continue;
        const panel = buildQuarterPanel(quarters);
        const yoy = panel ? yoyFromPanel(panel) : null;
        const extras = panel ? extraMetricsFromPanel(panel) : null;
        const bps = opmYoyDeltaBps(quarters);
        if (
          !yoy &&
          extras == null &&
          bps == null
        ) {
          continue;
        }
        map.set(row.ticker.toUpperCase(), {
          sales_yoy: yoy?.sales_yoy ?? null,
          np_yoy: yoy?.np_yoy ?? null,
          eps_yoy: yoy?.eps_yoy ?? null,
          ebidt_yoy: yoy?.ebidt_yoy ?? extras?.ebidt_yoy ?? null,
          sales_qoq: extras?.sales_qoq ?? null,
          np_qoq: extras?.np_qoq ?? null,
          eps_qoq: extras?.eps_qoq ?? null,
          ebidt_qoq: extras?.ebidt_qoq ?? null,
          opm_bps: bps,
        });
      }
    } finally {
      db.close();
    }
  } catch {
    /* missing db */
  }
  overlayCache = { at: now, map };
  return map;
}

let scanCache: {
  at: number;
  map: Map<string, FundamentalsScanRow>;
} | null = null;
const SCAN_CACHE_MS = 8_000;

export function loadFundamentalsScanMap(): Map<string, FundamentalsScanRow> {
  const now = Date.now();
  if (scanCache && now - scanCache.at < SCAN_CACHE_MS) return scanCache.map;

  const overlay = loadQuarterOverlayMap();
  const metrics = loadQuarterMetricsMap();
  const tickers = new Set<string>([
    ...[...metrics.keys()].map((t) => t.toUpperCase()),
    ...overlay.keys(),
  ]);
  const rows: Array<{
    ticker: string;
    inputs: PeadInputs;
    sales_yoy: number | null;
    np_yoy: number | null;
    opm_bps: number | null;
  }> = [];
  for (const ticker of tickers) {
    const m = metrics.get(ticker);
    const o = overlay.get(ticker);
    const sales_yoy = firstFinite(o?.sales_yoy, m?.sales_yoy);
    const np_yoy = firstFinite(
      o?.np_yoy,
      m?.np_yoy,
      o?.eps_yoy,
      m?.eps_yoy,
    );
    rows.push({
      ticker,
      sales_yoy,
      np_yoy,
      opm_bps: o?.opm_bps ?? null,
      inputs: {
        returns_pct: null,
        sales_yoy,
        sales_qoq: o?.sales_qoq ?? m?.sales_qoq ?? null,
        np_yoy,
        np_qoq: o?.np_qoq ?? m?.np_qoq ?? null,
        eps_yoy: o?.eps_yoy ?? m?.eps_yoy ?? null,
        eps_qoq: o?.eps_qoq ?? m?.eps_qoq ?? null,
        ebidt_yoy: o?.ebidt_yoy ?? m?.ebidt_yoy ?? null,
        ebidt_qoq: o?.ebidt_qoq ?? m?.ebidt_qoq ?? null,
        forward_pe: m?.forward_pe ?? null,
        cf_profit: m?.cf_profit ?? null,
      },
    });
  }
  const scores = peadScoresPercentile(rows.map((r) => r.inputs));
  const roce = loadRoceDeltaMap();
  const map = new Map<string, FundamentalsScanRow>();
  rows.forEach((r, i) => {
    const pead = scores[i] ?? null;
    map.set(r.ticker, {
      sales_yoy: r.sales_yoy,
      np_yoy: r.np_yoy,
      rev_growth: bandGrowth(r.sales_yoy),
      margin_exp: bandMarginBps(r.opm_bps),
      roce_impr: bandRoceDelta(roce.get(r.ticker) ?? null),
      pead,
      pead_band: bandPead(pead),
      tech_strength: null,
      tech_change: null,
    });
  });
  scanCache = { at: now, map };
  return map;
}

export function fundamentalsScanTickerSet(): Set<string> {
  const out = new Set<string>();
  for (const [t, row] of loadFundamentalsScanMap()) {
    if (row.sales_yoy != null && Number.isFinite(row.sales_yoy)) out.add(t);
  }
  return out;
}

export function attachFundamentalsScan(
  ticker: string,
  sma?: {
    price: number | null;
    sma20: number | null;
    sma50: number | null;
    sma200: number | null;
  } | null,
): FundamentalsScanRow | null {
  const base = loadFundamentalsScanMap().get(ticker.trim().toUpperCase());
  if (!base) return null;
  const tech = sma ? techFromSmaStack(sma) : null;
  return {
    ...base,
    tech_strength: tech?.strength ?? null,
    tech_change: tech?.change ?? null,
  };
}
