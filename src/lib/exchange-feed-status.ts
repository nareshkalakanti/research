import type { NseFeedStatus } from "./nse-feed-status-types";

const UNAVAILABLE = (exchange: "NSE" | "BSE"): NseFeedStatus => ({
  live: false,
  checked_at: new Date().toISOString(),
  detail: `${exchange} feed status unavailable`,
  last_scan_at: null,
});

/** Shared NSE + BSE reachability for Concall / IQ headers (cached ~60s). */
export async function loadExchangeFeedStatus(opts?: {
  force?: boolean;
  cachedOnly?: boolean;
}): Promise<{ nse_feed: NseFeedStatus; bse_feed: NseFeedStatus }> {
  try {
    const { checkNseFeedStatus } = await import("./nse-feed-status");
    const { checkBseFeedStatus } = await import("./bse-feed-status");
    const [nse_feed, bse_feed] = await Promise.all([
      checkNseFeedStatus({ force: opts?.force, cachedOnly: opts?.cachedOnly }),
      checkBseFeedStatus({ force: opts?.force, cachedOnly: opts?.cachedOnly }),
    ]);
    return { nse_feed, bse_feed };
  } catch {
    return {
      nse_feed: UNAVAILABLE("NSE"),
      bse_feed: UNAVAILABLE("BSE"),
    };
  }
}
