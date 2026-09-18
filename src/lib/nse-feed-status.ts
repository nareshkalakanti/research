import { openSqliteNamed } from "./sqlite-utils";
import { createNseBuybackSession } from "./nse-buybacks";
import {
  formatNseApiDateFromInstant,
  istCivilDayToUtcNoon,
  istRangeDaysBack,
} from "./nse-time";
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
    const { nseHttp1Fetch } = await import("./nse-http");
    const jar = await createNseBuybackSession();
    const { from: fromDay, to: toDay } = istRangeDaysBack(2);
    const to = istCivilDayToUtcNoon(toDay);
    const from = istCivilDayToUtcNoon(fromDay);

    const u = new URL(CORP_ANN_URL);
    u.searchParams.set("index", "equities");
    u.searchParams.set("symbol", PROBE_SYMBOL);
    u.searchParams.set("from_date", formatNseApiDateFromInstant(from));
    u.searchParams.set("to_date", formatNseApiDateFromInstant(to));

    const res = await nseHttp1Fetch(u.toString(), {
      jar,
      headers: {
        Accept: "application/json",
        Referer: NSE_ANN_REF,
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      return { ok: false, detail: `NSE API HTTP ${res.status}` };
    }

    const text = await res.text();
    if (/access denied|akamaighost/i.test(text)) {
      return { ok: false, detail: "NSE Akamai access denied" };
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, detail: "NSE API returned invalid JSON" };
    }
    if (!Array.isArray(body)) {
      return { ok: false, detail: "NSE API returned invalid JSON" };
    }

    return {
      ok: true,
      detail: `Corporate announcements API responding (${body.length} rows)`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "NSE unreachable";
    return { ok: false, detail: msg };
  }
}

/** Probe NSE corporate-announcements reachability (cached ~60s). */
export async function checkNseFeedStatus(opts?: {
  force?: boolean;
  cachedOnly?: boolean;
}): Promise<NseFeedStatus> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_MS) {
    return cache.status;
  }
  if (opts?.cachedOnly) {
    return (
      cache?.status ?? {
        live: false,
        checked_at: new Date().toISOString(),
        detail: "NSE feed not probed yet",
        last_scan_at: lastConcallDriftScanAt(),
      }
    );
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
