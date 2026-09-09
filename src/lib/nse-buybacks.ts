/**
 * NSE India HTTP session helpers (cookie jar).
 * Uses HTTP/1.1 (undici allowH2:false) — default fetch HTTP/2 breaks on Akamai.
 */
import { nseHttp1Fetch } from "./nse-http";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NSE_HOME = "https://www.nseindia.com/";
const NSE_QUOTE = "https://www.nseindia.com/get-quotes/equity";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const TIMEOUT_MS = 45_000;

export type NseCookieJar = { cookie: string };

export async function nseFetch(
  url: string,
  jar: NseCookieJar,
  opts?: { params?: Record<string, string>; referer?: string },
): Promise<Response> {
  const u = new URL(url);
  if (opts?.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      u.searchParams.set(k, v);
    }
  }
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json,text/html,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: opts?.referer || NSE_HOME,
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await nseHttp1Fetch(u.toString(), {
      jar,
      headers,
      signal: ctrl.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(t);
  }
}

export async function createNseBuybackSession(): Promise<NseCookieJar> {
  const jar: NseCookieJar = { cookie: "" };
  try {
    // Home first — sets Akamai cookies over HTTP/1.1
    await nseFetch(NSE_HOME, jar);
    await nseFetch(NSE_ANN_REF, jar, { referer: NSE_HOME });
    await nseFetch(NSE_QUOTE, jar, {
      params: { symbol: "TCS" },
      referer: NSE_HOME,
    });
  } catch {
    try {
      await nseFetch(NSE_HOME, jar);
    } catch {
      /* continue with whatever cookies we have */
    }
  }
  return jar;
}
