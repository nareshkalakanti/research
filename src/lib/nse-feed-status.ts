import { openSqliteNamed } from "./sqlite-utils";
import { createNseBuybackSession } from "./nse-buybacks";
import type { NseFeedStatus } from "./nse-feed-status-types";

export type { NseFeedStatus } from "./nse-feed-status-types";
export { formatNseFeedAge } from "./nse-feed-status-types";

const CORP_ANN_URL = "https://www.nseindia.com/api/corporate-announcements";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const PROBE_SYMBOL = "RELIANCE";
const CACHE_MS = 60_000;

type CacheEntry = { at: number; status: NseFeedStatus };

let cache: CacheEntry | null = null;

function formatNseRange(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

function lastConcallDriftScanAt(): string | null {
  try {
    const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
    try {
      const row = db
        .prepare(
          `SELECT MAX(fetched_at) AS d FROM strategy_scan_log
           WHERE scan_type = 'concall_drift' AND status IN ('ok', 'empty')`,
        )
        .get() as { d: string | null };
      return row?.d ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function probeNseAnnouncements(): Promise<{ ok: boolean; detail: string }> {
  try {
    const jar = await createNseBuybackSession();
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 2);

    const u = new URL(CORP_ANN_URL);
    u.searchParams.set("index", "equities");
    u.searchParams.set("symbol", PROBE_SYMBOL);
    u.searchParams.set("from_date", formatNseRange(from));
    u.searchParams.set("to_date", formatNseRange(to));

    const res = await fetch(u.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json",
        Referer: NSE_ANN_REF,
        Cookie: jar.cookie,
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      return { ok: false, detail: `NSE API HTTP ${res.status}` };
    }

    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      return { ok: false, detail: "NSE API returned invalid JSON" };
    }

    return {
      ok: true,
      detail: "Corporate announcements API responding",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "NSE unreachable";
    return { ok: false, detail: msg };
  }
}

/** Probe NSE corporate-announcements reachability (cached ~60s). */
export async function checkNseFeedStatus(opts?: {
  force?: boolean;
}): Promise<NseFeedStatus> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_MS) {
    return cache.status;
  }

  const probe = await probeNseAnnouncements();
  const last_scan_at = lastConcallDriftScanAt();
  const status: NseFeedStatus = {
    live: probe.ok,
    checked_at: new Date().toISOString(),
    detail: probe.detail,
    last_scan_at,
  };

  cache = { at: Date.now(), status };
  return status;
}
