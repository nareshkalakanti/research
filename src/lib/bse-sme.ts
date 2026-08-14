/**
 * BSE SME / Startup listings — official BSE List-of-Scrips API.
 *
 * Groups M (rolling) and MT (trade-to-trade) are the BSE SME board,
 * same idea as NSE Emerge CSV → market ``NSE SME``.
 *
 * Source: https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w
 */

export const BSE_SME_MARKET = "BSE SME";

export type BseSmeListing = {
  ticker: string;
  name: string;
  market: typeof BSE_SME_MARKET;
  scrip_code: string;
  group: string;
  isin: string | null;
  industry: string | null;
  mcap_cr: number | null;
};

const GROUPS = ["M", "MT"] as const;
const API =
  "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w";

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
    });
  }
  return out;
}

async function fetchGroup(group: string): Promise<BseSmeListing[]> {
  const url = `${API}?Group=${encodeURIComponent(group)}&Scripcode=&industry=&status=Active&segment=Equity&scripname=`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Referer: "https://www.bseindia.com/",
      Accept: "application/json,text/plain,*/*",
    },
  });
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
