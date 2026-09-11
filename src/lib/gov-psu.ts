/**
 * CPSU / Gov ratna watchlist — curated list in data/gov_psu.json.
 * Filter chip: Gov. Row tags: Maharatna / Navratna / Miniratna I|II / Non-Ratna / State PSU.
 * Server-only (fs). Client code must import labels from gov-psu-meta.
 */
import fs from "fs";
import path from "path";
import {
  GOV_RATNA_LABELS,
  GOV_RATNA_SHORT,
  GOV_RATNA_TIERS,
  type GovRatnaTier,
} from "@/lib/gov-psu-meta";

export type { GovRatnaTier };
export { GOV_RATNA_LABELS, GOV_RATNA_SHORT, GOV_RATNA_TIERS };

const DATA_PATH = path.join(process.cwd(), "data", "gov_psu.json");

type GovPsuFile = {
  updated_at?: string;
  tiers: Record<
    string,
    {
      label?: string;
      short?: string;
      companies: Array<{ name: string; ticker: string | null }>;
    }
  >;
};

export type GovPsuRow = {
  ticker: string;
  name: string;
  tier: GovRatnaTier;
};

let cache: {
  at: number;
  rows: GovPsuRow[];
  byTicker: Map<string, GovPsuRow>;
  set: Set<string>;
} | null = null;
const CACHE_MS = 30_000;

function isTier(k: string): k is GovRatnaTier {
  return (GOV_RATNA_TIERS as string[]).includes(k);
}

function loadFile(): GovPsuFile | null {
  if (!fs.existsSync(DATA_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8")) as GovPsuFile;
  } catch {
    return null;
  }
}

export function invalidateGovPsuCache(): void {
  cache = null;
}

export function loadGovPsu(): GovPsuRow[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.rows;

  const file = loadFile();
  const rows: GovPsuRow[] = [];
  const byTicker = new Map<string, GovPsuRow>();
  if (file?.tiers) {
    for (const [tierKey, block] of Object.entries(file.tiers)) {
      if (!isTier(tierKey)) continue;
      for (const c of block.companies || []) {
        const ticker = c.ticker?.trim().toUpperCase() || null;
        if (!ticker) continue;
        const row: GovPsuRow = {
          ticker,
          name: c.name,
          tier: tierKey,
        };
        // Prefer higher tier if duplicate ticker somehow appears
        const prev = byTicker.get(ticker);
        if (
          prev &&
          GOV_RATNA_TIERS.indexOf(prev.tier) <= GOV_RATNA_TIERS.indexOf(tierKey)
        ) {
          continue;
        }
        byTicker.set(ticker, row);
      }
    }
  }
  for (const row of byTicker.values()) rows.push(row);
  rows.sort((a, b) => a.ticker.localeCompare(b.ticker));
  cache = {
    at: now,
    rows,
    byTicker,
    set: new Set(byTicker.keys()),
  };
  return rows;
}

export function govPsuTickerSet(): Set<string> {
  loadGovPsu();
  return cache?.set ?? new Set();
}

export function isGovPsu(ticker: string): boolean {
  return govPsuTickerSet().has(ticker.toUpperCase());
}

export function govRatnaForTicker(ticker: string): GovRatnaTier | null {
  loadGovPsu();
  return cache?.byTicker.get(ticker.toUpperCase())?.tier ?? null;
}

export function govRatnaLabel(tier: GovRatnaTier | null | undefined): string | null {
  if (!tier) return null;
  return GOV_RATNA_LABELS[tier] ?? null;
}

export function govRatnaShort(tier: GovRatnaTier | null | undefined): string | null {
  if (!tier) return null;
  return GOV_RATNA_SHORT[tier] ?? null;
}
