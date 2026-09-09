/**
 * NSE fetch over HTTP/1.1 only — Node's default HTTP/2 hits Akamai NGHTTP2_INTERNAL_ERROR.
 */
import { Agent, fetch as undiciFetch } from "undici";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Shared undici agent — HTTP/1.1 only. */
const http1Agent = new Agent({
  allowH2: false,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  connections: 4,
});

export type NseHttpJar = { cookie: string };

function mergeSetCookie(jar: NseHttpJar, res: Response): void {
  const setCookie =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [];
  if (setCookie.length) {
    const parts = setCookie.map((c) => c.split(";")[0]!).filter(Boolean);
    jar.cookie = [
      ...new Set([...(jar.cookie ? jar.cookie.split("; ") : []), ...parts]),
    ].join("; ");
    return;
  }
  const sc = res.headers.get("set-cookie");
  if (sc) {
    const part = sc.split(";")[0]!.trim();
    if (part) {
      jar.cookie = jar.cookie ? `${jar.cookie}; ${part}` : part;
    }
  }
}

export async function nseHttp1Fetch(
  url: string,
  opts?: {
    jar?: NseHttpJar;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: RequestRedirect;
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    ...(opts?.headers || {}),
  };
  if (opts?.jar?.cookie) headers.Cookie = opts.jar.cookie;

  const res = await undiciFetch(url, {
    dispatcher: http1Agent,
    headers,
    signal: opts?.signal,
    redirect: opts?.redirect ?? "follow",
  });

  if (opts?.jar) mergeSetCookie(opts.jar, res as unknown as Response);
  // undici Response is fetch-compatible for our callers
  return res as unknown as Response;
}
