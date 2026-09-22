import { openSqliteNamed } from "./sqlite-utils";
import type { NseFeedStatus } from "./nse-feed-status-types";

export type { NseFeedStatus } from "./nse-feed-status-types";
export { formatNseFeedAge } from "./nse-feed-status-types";

const NSE_HOME = "https://www.nseindia.com/";
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

/** True when NSE HTML is a real site response (not Akamai deny). */
function nseHtmlLooksLive(
  status: number,
  cookie: string,
  body: string,
): boolean {
  if (status < 200 || status >= 400) return false;
  if (/access denied|akamaighost/i.test(body) && !cookie.trim()) return false;
  return Boolean(cookie.trim()) || /nseindia/i.test(body);
}

/**
 * Probe NSE website reachability. Corporate-announcements JSON often hangs on
 * Akamai even when the site itself is up — don't use that for the live badge.
 */
async function probeNseSite(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { nseHttp1Fetch } = await import("./nse-http");
    const jar = { cookie: "" };
    const res = await nseHttp1Fetch(NSE_HOME, {
      jar,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Referer: NSE_HOME,
      },
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    if (!nseHtmlLooksLive(res.status, jar.cookie, text)) {
      if (!res.ok) return { ok: false, detail: `NSE HTTP ${res.status}` };
      return { ok: false, detail: "NSE Akamai access denied" };
    }
    return { ok: true, detail: "NSE website responding" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "NSE unreachable";
    return { ok: false, detail: msg };
  }
}

/** Probe NSE reachability (cached ~60s). */
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

  const probe = await probeNseSite();
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
