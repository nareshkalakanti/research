/**
 * BSE SME / Startup listings — official BSE List-of-Scrips API.
 *
 * Groups M (rolling) and MT (trade-to-trade) are the BSE SME board,
 * same idea as NSE Emerge CSV → market ``NSE SME``.
 *
 * Source: https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w
 */

import fs from "fs";
import path from "path";

export const BSE_SME_MARKET = "BSE SME";

/** Suspended / delisted BSE SME names — kept out of universe sync. */
export const BSE_SME_EXCLUDED = new Set(["PBFL"]);

export function isBseSmeExcluded(ticker: string): boolean {
  return BSE_SME_EXCLUDED.has((ticker || "").trim().toUpperCase());
}

export type BseSmeListing = {
  ticker: string;
  name: string;
  market: typeof BSE_SME_MARKET;
  scrip_code: string;
  group: string;
  isin: string | null;
  /** BSE list API field — usually empty; see sector/sub_sector from ComHeader. */
  industry: string | null;
  mcap_cr: number | null;
  sector: string | null;
  sub_sector: string | null;
  about?: string | null;
  website?: string | null;
  headquarters?: string | null;
};

const GROUPS = ["M", "MT"] as const;
const LIST_API =
  "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w";
const COM_HEADER =
  "https://api.bseindia.com/BseIndiaAPI/api/ComHeader/w";
const SCRIP_HEADER =
  "https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w";
const CACHE_FILE = path.join(process.cwd(), "data", "bse_sme_scrips.json");

const BSE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://www.bseindia.com/",
  Accept: "application/json,text/plain,*/*",
} as const;

export { BSE_HEADERS };

type BseRow = {
  scrip_id?: string;
  Scrip_Name?: string;
  Issuer_Name?: string;
  SCRIP_CD?: string;
  GROUP?: string;
  Status?: string;
  ISIN_NUMBER?: string;
  INDUSTRY?: string | null;
  Mktcap?: string | number | null;
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseRows(raw: unknown, group: string): BseSmeListing[] {
  const arr = Array.isArray(raw) ? (raw as BseRow[]) : [];
  const out: BseSmeListing[] = [];
  const seen = new Set<string>();
  for (const r of arr) {
    const status = String(r.Status || "Active").trim();
    if (status && status.toLowerCase() !== "active") continue;
    const ticker = String(r.scrip_id || "")
      .trim()
      .toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    const name =
      String(r.Issuer_Name || r.Scrip_Name || ticker).trim() || ticker;
    out.push({
      ticker,
      name,
      market: BSE_SME_MARKET,
      scrip_code: String(r.SCRIP_CD || "").trim(),
      group: String(r.GROUP || group).trim().toUpperCase() || group,
      isin: r.ISIN_NUMBER ? String(r.ISIN_NUMBER).trim() : null,
      industry: r.INDUSTRY ? String(r.INDUSTRY).trim() : null,
      mcap_cr: num(r.Mktcap),
      sector: null,
      sub_sector: null,
    });
  }
  return out;
}

let cacheMap: Map<string, BseSmeListing> | null = null;

/** Cached BSE SME universe from data/bse_sme_scrips.json (npm run sync:bse-sme). */
export function loadBseSmeCacheMap(): Map<string, BseSmeListing> {
  if (cacheMap) return cacheMap;
  cacheMap = new Map();
  if (!fs.existsSync(CACHE_FILE)) return cacheMap;
  try {
    const json = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as {
      listings?: BseSmeListing[];
    };
    for (const row of json.listings ?? []) {
      if (isBseSmeExcluded(row.ticker)) continue;
      cacheMap.set(row.ticker.toUpperCase(), row);
    }
  } catch {
    /* unreadable cache */
  }
  return cacheMap;
}

export function invalidateBseSmeCacheMap(): void {
  cacheMap = null;
}

/** Last traded price from BSE getScripHeaderData. */
export async function fetchBseScripLtp(scripCode: string): Promise<number | null> {
  const code = scripCode.trim();
  if (!code) return null;
  const url = `${SCRIP_HEADER}?scripcode=${encodeURIComponent(code)}&flag=0`;
  try {
    const res = await fetch(url, { headers: BSE_HEADERS });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      CurrRate?: { LTP?: string | number | null };
    };
    const n = num(json.CurrRate?.LTP);
    return n != null && n > 0 ? Math.round(n * 100) / 100 : null;
  } catch {
    return null;
  }
}

export type BseSmeMetrics = {
  ticker: string;
  price: number | null;
  mcap_cr: number | null;
  yf_symbol: string;
};

/** Price (live LTP) + mcap (list API) for a BSE SME name. */
export async function fetchBseSmeMetrics(
  ticker: string,
  opts?: {
    listing?: BseSmeListing | null;
    needPrice?: boolean;
    needMcap?: boolean;
  },
): Promise<BseSmeMetrics | null> {
  const listing =
    opts?.listing ?? loadBseSmeCacheMap().get(ticker.toUpperCase()) ?? null;
  if (!listing) return null;

  const needPrice = opts?.needPrice !== false;
  const needMcap = opts?.needMcap !== false;

  let mcap_cr = listing.mcap_cr;
  if (mcap_cr != null && mcap_cr <= 0) mcap_cr = null;
  if (!needMcap) mcap_cr = null;

  let price: number | null = null;
  if (needPrice && listing.scrip_code) {
    price = await fetchBseScripLtp(listing.scrip_code);
  }

  if (price == null && mcap_cr == null) return null;

  return {
    ticker: ticker.toUpperCase(),
    price,
    mcap_cr,
    yf_symbol: listing.scrip_code
      ? `BSE:${listing.scrip_code}`
      : `${ticker.toUpperCase()}.BO`,
  };
}

function nonempty(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s || null;
}

type ComHeaderJson = {
  Sector?: string;
  Industry?: string;
  IndustryNew?: string;
  IGroup?: string;
  ISubGroup?: string;
};

function taxonomyFromHeader(h: ComHeaderJson): Pick<
  BseSmeListing,
  "sector" | "industry" | "sub_sector"
> {
  const sector = nonempty(h.Sector);
  const industry =
    nonempty(h.IGroup) || nonempty(h.IndustryNew) || nonempty(h.Industry);
  const sub_sector =
    nonempty(h.ISubGroup) || nonempty(h.Industry) || industry;
  return { sector, industry, sub_sector };
}

/** Per-scrip sector / industry from BSE ComHeader API. */
export async function fetchBseComHeader(
  scripCode: string,
): Promise<Pick<BseSmeListing, "sector" | "industry" | "sub_sector"> | null> {
  const code = scripCode.trim();
  if (!code) return null;
  const url = `${COM_HEADER}?scripcode=${encodeURIComponent(code)}`;
  const res = await fetch(url, { headers: BSE_HEADERS });
  if (!res.ok) return null;
  const json = (await res.json()) as ComHeaderJson;
  return taxonomyFromHeader(json);
}

/** Fill sector / sub_sector from BSE ComHeader (official per-scrip header). */
export async function enrichBseSmeTaxonomy(
  listings: BseSmeListing[],
  opts?: { concurrency?: number; delayMs?: number; onProgress?: (n: number) => void },
): Promise<BseSmeListing[]> {
  const concurrency = Math.max(1, opts?.concurrency ?? 8);
  const delayMs = opts?.delayMs ?? 100;
  const out = listings.map((r) => ({ ...r }));
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < out.length) {
      const i = next++;
      const row = out[i]!;
      if (row.scrip_code) {
        try {
          const tax = await fetchBseComHeader(row.scrip_code);
          if (tax) out[i] = { ...row, ...tax };
        } catch {
          /* skip failed scrip */
        }
      }
      done += 1;
      opts?.onProgress?.(done);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

async function fetchGroup(group: string): Promise<BseSmeListing[]> {
  const url = `${LIST_API}?Group=${encodeURIComponent(group)}&Scripcode=&industry=&status=Active&segment=Equity&scripname=`;
  const res = await fetch(url, { headers: BSE_HEADERS });
  if (!res.ok) {
    throw new Error(`BSE SME ${group} fetch failed (${res.status})`);
  }
  const json = (await res.json()) as unknown;
  return parseRows(json, group);
}

/** Live BSE SME universe (M + MT). Dedupes scrip_id. */
export async function fetchBseSmeListings(): Promise<BseSmeListing[]> {
  const chunks = await Promise.all(GROUPS.map((g) => fetchGroup(g)));
  const byTicker = new Map<string, BseSmeListing>();
  for (const row of chunks.flat()) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, row);
  }
  return [...byTicker.values()].sort((a, b) =>
    a.ticker.localeCompare(b.ticker),
  );
}
