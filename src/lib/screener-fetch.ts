/**
 * Throttled Screener.in company-page fetch — never hit global search (blocks fast).
 */
import { screenerConsolidatedUrl, screenerUrl } from "./links";
import { withWebsiteFetch } from "./scrape-pool";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Min gap between any two Screener requests (search gets you blocked; company pages are OK if spaced). */
const SCREENER_GAP_MS = 2_500;

let lastScreenerAt = 0;

export function screenerBlocked(html: string, status: number): boolean {
  if (status === 403 || status === 429) return true;
  if (/captcha|access denied|rate limit|too many requests/i.test(html)) return true;
  if (/Error 404: Page Not Found/i.test(html)) return true;
  return false;
}

async function waitScreenerGap(): Promise<void> {
  const wait = SCREENER_GAP_MS - (Date.now() - lastScreenerAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastScreenerAt = Date.now();
}

/** Fetch one company page — serialized gap + per-host pool from scrape-pool. */
export async function fetchScreenerCompanyHtml(
  ticker: string,
  opts?: { consolidated?: boolean },
): Promise<string> {
  const url = opts?.consolidated
    ? screenerConsolidatedUrl(ticker)
    : screenerUrl(ticker);
  await waitScreenerGap();
  return withWebsiteFetch(url, async () => {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-IN,en;q=0.9",
      },
      signal: AbortSignal.timeout(45_000),
      redirect: "follow",
    });
    const html = await res.text();
    if (screenerBlocked(html, res.status)) {
      throw new Error(`Screener blocked or unavailable (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`Screener fetch failed (${res.status}) for ${ticker}`);
    }
    return html;
  });
}
