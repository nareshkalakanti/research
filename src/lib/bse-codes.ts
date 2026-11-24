import fs from "fs";
import path from "path";
import { loadBseSmeCacheMap } from "./bse-sme";
import type { BseMainListing } from "./bse-main";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * A stock's own BSE scrip code from authoritative lists — never from a name
 * search (that is how WAAREE got Waaree Energies' code, ANGEL got Angel One's):
 *   1. BSE SME listing file (data/bse_sme_scrips.json)
 *   2. BSE main-board list (data/bse_main_scrips.json, refreshed by the
 *      identity repair job), matched by ISIN when known, else by BSE ticker.
 */

const MAIN_FILE = path.join(process.cwd(), "data", "bse_main_scrips.json");
const RELOAD_MS = 10 * 60_000;

type MainIndex = { at: number; byTicker: Map<string, BseMainListing>; byIsin: Map<string, BseMainListing> };
let mainIndex: MainIndex | null = null;
let isinIndex: { at: number; map: Map<string, string> } | null = null;

export function saveBseMainListings(rows: BseMainListing[]): void {
  fs.writeFileSync(MAIN_FILE, JSON.stringify({ fetched_at: new Date().toISOString(), count: rows.length, listings: rows }));
  mainIndex = null;
}

function loadMain(): MainIndex {
  if (mainIndex && Date.now() - mainIndex.at < RELOAD_MS) return mainIndex;
  const byTicker = new Map<string, BseMainListing>();
  const byIsin = new Map<string, BseMainListing>();
  try {
    const raw = JSON.parse(fs.readFileSync(MAIN_FILE, "utf8")) as { listings?: BseMainListing[] };
    for (const r of raw.listings ?? []) {
      if (!/^\d{5,7}$/.test(r.scrip_code || "")) continue;
      byTicker.set(r.ticker.toUpperCase(), r);
      if (r.isin) byIsin.set(r.isin.toUpperCase(), r);
    }
  } catch {
    /* not fetched yet: SME list only */
  }
  mainIndex = { at: Date.now(), byTicker, byIsin };
  return mainIndex;
}

/** Ticker → ISIN from the governance company table (read-only). */
function isinFor(ticker: string): string | null {
  if (!isinIndex || Date.now() - isinIndex.at > RELOAD_MS) {
    const map = new Map<string, string>();
    try {
      const db = openSqliteNamed("governance.db", { readonly: true, wal: true });
      try {
        for (const r of db
          .prepare(`SELECT UPPER(ticker) AS t, UPPER(TRIM(isin)) AS isin FROM companies WHERE isin LIKE 'IN%'`)
          .all() as Array<{ t: string; isin: string }>) {
          map.set(r.t, r.isin);
        }
      } finally {
        db.close();
      }
    } catch {
      /* no ISINs: ticker match only */
    }
    isinIndex = { at: Date.now(), map };
  }
  return isinIndex.map.get(ticker) ?? null;
}

export function trustedBseCode(ticker: string): string | null {
  const t = ticker.trim().toUpperCase();
  if (!t) return null;
  const sme = loadBseSmeCacheMap().get(t)?.scrip_code?.trim();
  if (sme && /^\d{5,7}$/.test(sme)) return sme;
  const main = loadMain();
  const isin = isinFor(t);
  if (isin) {
    const hit = main.byIsin.get(isin);
    if (hit) return hit.scrip_code;
  }
  const byT = main.byTicker.get(t);
  // Same BSE ticker but a different ISIN is another company.
  if (byT && (!isin || !byT.isin || byT.isin.toUpperCase() === isin)) return byT.scrip_code;
  return null;
}

/** Ticker an official BSE list assigns this scrip code to (SME list, then main board). */
export function bseCodeOwner(code: string): string | null {
  const c = code.trim();
  if (!c) return null;
  for (const [t, r] of loadBseSmeCacheMap()) if (r.scrip_code?.trim() === c) return t;
  for (const r of loadMain().byTicker.values()) if (r.scrip_code === c) return r.ticker.toUpperCase();
  return null;
}

export function bseMainListLoaded(): boolean {
  return loadMain().byTicker.size > 0;
}
