import { BSE_HEADERS, fetchBseComHeader } from "./bse-sme";
import { upsertClassification } from "./classifications-write";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * BSE main board (every group except SME M / MT) from BSE's List-of-Scrips
 * API. The listing sync adds the ones that do not trade on NSE (matched by
 * ISIN) as market "BSE" — only reasonably sized, compliant names.
 */

export const BSE_MAIN_MARKET = "BSE";
/** Smaller BSE-only names are mostly shells or untradeable — not added. */
export const BSE_MAIN_MIN_MCAP_CR = 100;
/** Z / ZP: penalised for not complying with listing rules — not added. */
export const BSE_MAIN_SKIP_GROUPS = new Set(["Z", "ZP"]);
/** A sane full list has ~4,500 rows; fewer means BSE was down or blocked. */
export const BSE_MAIN_MIN_ROWS = 3000;

const LIST_API = "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w";
const GROUPS = ["A", "B", "T", "X", "XT", "Z", "ZP", "P", "MS", "R", "W", "Y"] as const;

export type BseMainListing = {
  ticker: string;
  name: string;
  scrip_code: string;
  group: string;
  isin: string | null;
  mcap_cr: number | null;
};

type Row = {
  scrip_id?: string;
  Scrip_Name?: string;
  Issuer_Name?: string;
  SCRIP_CD?: string;
  GROUP?: string;
  Status?: string;
  ISIN_NUMBER?: string;
  Mktcap?: string | number | null;
};

async function fetchGroup(group: string): Promise<BseMainListing[]> {
  const url = `${LIST_API}?Group=${encodeURIComponent(group)}&Scripcode=&industry=&status=Active&segment=Equity&scripname=`;
  const res = await fetch(url, { headers: BSE_HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`BSE ${group} list failed (${res.status})`);
  const raw = (await res.json()) as unknown;
  const out: BseMainListing[] = [];
  for (const r of Array.isArray(raw) ? (raw as Row[]) : []) {
    if (String(r.Status || "Active").trim().toLowerCase() !== "active") continue;
    const ticker = String(r.scrip_id || "").trim().toUpperCase();
    if (!ticker) continue;
    const m = Number(r.Mktcap);
    out.push({
      ticker,
      name: String(r.Issuer_Name || r.Scrip_Name || ticker).trim() || ticker,
      scrip_code: String(r.SCRIP_CD || "").trim(),
      group: String(r.GROUP || group).trim().toUpperCase() || group,
      isin: r.ISIN_NUMBER ? String(r.ISIN_NUMBER).trim() : null,
      mcap_cr: Number.isFinite(m) && m > 0 ? m : null,
    });
  }
  return out;
}

/** Full BSE main board, one group at a time (BSE rate-limits bursts). */
export async function fetchBseMainListings(): Promise<BseMainListing[]> {
  const by = new Map<string, BseMainListing>();
  for (const g of GROUPS) {
    for (const r of await fetchGroup(g)) if (!by.has(r.ticker)) by.set(r.ticker, r);
    await new Promise((r) => setTimeout(r, 600));
  }
  return [...by.values()];
}

/** Worth adding to the app: big enough and not in a penalty group. */
export function bseMainWanted(r: BseMainListing): boolean {
  return r.mcap_cr != null && r.mcap_cr >= BSE_MAIN_MIN_MCAP_CR && !BSE_MAIN_SKIP_GROUPS.has(r.group);
}

/** BSE-only tickers (market "BSE") with a known scrip code but no sector yet. */
function bseMissingSector(): Array<{ ticker: string; scrip_code: string }> {
  const about = openSqliteNamed("company_about.db", { readonly: true, wal: true });
  let rows: Array<{ ticker: string; scrip_code: string }>;
  try {
    rows = about
      .prepare(
        `SELECT UPPER(a.ticker) AS ticker, s.scrip_code FROM company_about a
         JOIN company_bse_scrip s ON UPPER(s.ticker) = UPPER(a.ticker)
         WHERE a.market = ? AND TRIM(COALESCE(s.scrip_code, '')) != ''`,
      )
      .all(BSE_MAIN_MARKET) as typeof rows;
  } finally {
    about.close();
  }
  const cls = openSqliteNamed("classifications.db", { readonly: true, wal: true });
  try {
    const have = new Set(
      (cls
        .prepare(`SELECT UPPER(ticker) AS t FROM classifications WHERE TRIM(COALESCE(sector, '')) != ''`)
        .all() as Array<{ t: string }>).map((r) => r.t),
    );
    return rows.filter((r) => !have.has(r.ticker));
  } finally {
    cls.close();
  }
}

/**
 * Sector › industry › sub-sector from BSE's per-scrip header (same taxonomy as
 * NSE) for BSE-only names that have none. A few at a time; BSE throttles bursts.
 */
export async function fillBseMainSectors(opts?: { limit?: number }): Promise<{ tried: number; filled: number }> {
  const todo = bseMissingSector().slice(0, opts?.limit ?? 1000);
  let next = 0;
  let filled = 0;
  async function worker() {
    while (next < todo.length) {
      const r = todo[next++]!;
      try {
        const tax = await fetchBseComHeader(r.scrip_code);
        if (tax?.sector && tax.sub_sector) {
          upsertClassification(r.ticker, BSE_MAIN_MARKET, {
            sector: tax.sector,
            sub_sector: tax.sub_sector,
            industry: tax.industry,
          });
          filled += 1;
        }
      } catch {
        /* next sync retries */
      }
      await new Promise((res) => setTimeout(res, 150));
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return { tried: todo.length, filled };
}
