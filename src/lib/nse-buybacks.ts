/**
 * NSE India HTTP session helpers (cookie jar).
 * Used by concall-drift, bootstrap, feed-status, etc.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NSE_HOME = "https://www.nseindia.com/";
const NSE_QUOTE = "https://www.nseindia.com/get-quotes/equity";
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
  if (jar.cookie) headers.Cookie = jar.cookie;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), {
      headers,
      signal: ctrl.signal,
      redirect: "follow",
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length) {
      const parts = setCookie.map((c) => c.split(";")[0]!).filter(Boolean);
      jar.cookie = [
        ...new Set([...(jar.cookie ? jar.cookie.split("; ") : []), ...parts]),
      ].join("; ");
    }
    return res;
  } finally {
    clearTimeout(t);
  }
}

export async function createNseBuybackSession(): Promise<NseCookieJar> {
  const jar: NseCookieJar = { cookie: "" };
  try {
    await nseFetch(NSE_QUOTE, jar, {
      params: { symbol: "TCS" },
      referer: NSE_HOME,
    });
  } catch {
    try {
      await nseFetch(NSE_HOME, jar);
    } catch {
      /* continue */
    }
  }
  return jar;
}
