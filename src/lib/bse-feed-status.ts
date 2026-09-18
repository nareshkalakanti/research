import { BSE_HEADERS, fetchBseSmeListings } from "./bse-sme";
import type { NseFeedStatus } from "./nse-feed-status-types";
import { formatNseFeedAge } from "./nse-feed-status-types";
import { openSqliteNamed } from "./sqlite-utils";

export type BseFeedStatus = NseFeedStatus;
export { formatNseFeedAge as formatBseFeedAge };

const SCRIP_HEADER =
  "https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w";
const CACHE_MS = 60_000;

type CacheEntry = { at: number; status: BseFeedStatus };

let cache: CacheEntry | null = null;

/** Any cached BSE scrip code from company_about (not a fixed issuer). */
function anyCachedScripCode(): string | null {
  try {
    const db = openSqliteNamed("company_about.db", {
      readonly: true,
      wal: true,
    });
    try {
      const row = db
        .prepare(
          `SELECT scrip_code FROM company_bse_scrip
           WHERE scrip_code IS NOT NULL AND trim(scrip_code) != ''
           LIMIT 1`,
        )
        .get() as { scrip_code: string } | undefined;
      return row?.scrip_code?.trim() || null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function probeScripHeader(scrip: string): Promise<{
  ok: boolean;
  detail: string;
}> {
  try {
    const u = new URL(SCRIP_HEADER);
    u.searchParams.set("scripcode", scrip);
    const res = await fetch(u.toString(), {
      headers: BSE_HEADERS,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      return { ok: false, detail: `BSE API HTTP ${res.status}` };
    }
    const json = (await res.json()) as {
      CurrRate?: { LTP?: string };
      Cmpname?: { FullN?: string };
    };
    const ltp = json.CurrRate?.LTP;
    const name = json.Cmpname?.FullN;
    if (!ltp && !name) {
      return { ok: false, detail: "BSE scrip header empty" };
    }
    return {
      ok: true,
      detail: ltp
        ? `Scrip header live (LTP ${ltp})`
        : `Scrip header live (${name})`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "BSE unreachable";
    return { ok: false, detail: msg };
  }
}

async function probeBseListings(): Promise<{ ok: boolean; detail: string }> {
  try {
    const list = await fetchBseSmeListings();
    if (!list.length) {
      return { ok: false, detail: "BSE SME list empty" };
    }
    return {
      ok: true,
      detail: `BSE SME list responding (${list.length} scrips)`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "BSE unreachable";
    return { ok: false, detail: msg };
  }
}

async function probeBseLive(): Promise<{ ok: boolean; detail: string }> {
  const scrip = anyCachedScripCode();
  if (scrip) {
    const header = await probeScripHeader(scrip);
    if (header.ok) return header;
  }
  return probeBseListings();
}

/** Probe BSE API reachability (cached ~60s). */
export async function checkBseFeedStatus(opts?: {
  force?: boolean;
  cachedOnly?: boolean;
}): Promise<BseFeedStatus> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_MS) {
    return cache.status;
  }
  if (opts?.cachedOnly) {
    return (
      cache?.status ?? {
        live: false,
        checked_at: new Date().toISOString(),
        detail: "BSE feed not probed yet",
        last_scan_at: null,
      }
    );
  }

  const probe = await probeBseLive();
  const status: BseFeedStatus = {
    live: probe.ok,
    checked_at: new Date().toISOString(),
    detail: probe.detail,
    last_scan_at: null,
  };
  cache = { at: Date.now(), status };
  return status;
}
