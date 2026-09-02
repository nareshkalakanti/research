/**
 * NSE buyback data — corporate actions bulk feed + per-symbol announcements.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NSE_HOME = "https://www.nseindia.com/";
const NSE_QUOTE = "https://www.nseindia.com/get-quotes/equity";
const NSE_ACTIONS_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-actions";
const NSE_ANN_REF =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const CORP_ACTIONS_URL =
  "https://www.nseindia.com/api/corporates-corporateActions";
const CORP_ANN_URL = "https://www.nseindia.com/api/corporate-announcements";
const TIMEOUT_MS = 45_000;

import {
  classifyBuybackStatus,
  isBuybackSubject,
  parseMaxPrice,
  parseNseDate,
  parsePctEquity,
  parseShareCount,
} from "./strategy/buyback-parse";
import type { BuybackEvent } from "./strategy/types";

export type NseCookieJar = { cookie: string };

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function formatNseRange(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

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
      jar.cookie = [...new Set([...(jar.cookie ? jar.cookie.split("; ") : []), ...parts])].join(
        "; ",
      );
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

type RawAction = {
  symbol?: string;
  subject?: string;
  exDate?: string;
  recDate?: string;
  comp?: string;
};

type RawAnn = {
  symbol?: string;
  desc?: string;
  attchmntText?: string;
  an_dt?: string;
  sort_date?: string;
  seq_id?: string;
  sm_name?: string;
};

function eventId(
  ticker: string,
  source: BuybackEvent["source"],
  key: string,
): string {
  return `${ticker.toUpperCase()}|${source}|${key}`;
}

export async function fetchNseBuybackActions(
  jar: NseCookieJar,
  opts?: { yearsBack?: number },
): Promise<BuybackEvent[]> {
  const yearsBack = opts?.yearsBack ?? 6;
  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - yearsBack);

  const out: BuybackEvent[] = [];
  for (const index of ["equities", "sme"] as const) {
    const res = await nseFetch(CORP_ACTIONS_URL, jar, {
      referer: NSE_ACTIONS_REF,
      params: {
        index,
        from_date: formatNseRange(from),
        to_date: formatNseRange(to),
      },
    });
    if (!res.ok) continue;
    const rows = (await res.json()) as RawAction[];
    for (const row of rows) {
      const subject = safeStr(row.subject);
      if (!isBuybackSubject(subject)) continue;
      const ticker = safeStr(row.symbol).toUpperCase();
      if (!ticker) continue;
      const exDate = parseNseDate(row.exDate) || parseNseDate(row.recDate);
      out.push({
        id: eventId(ticker, "nse_action", exDate || subject),
        ticker,
        announced_at: exDate,
        ex_date: exDate,
        max_price: null,
        pct_equity: null,
        size_shares: null,
        status: "announced",
        subject,
        description: safeStr(row.comp) || null,
        source: "nse_action",
        seq_id: null,
      });
    }
  }
  return out;
}

export async function fetchNseBuybackAnnouncements(
  jar: NseCookieJar,
  ticker: string,
): Promise<BuybackEvent[]> {
  const key = ticker.toUpperCase();
  const res = await nseFetch(CORP_ANN_URL, jar, {
    referer: NSE_ANN_REF,
    params: { index: "equities", symbol: key },
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as RawAnn[];
  const out: BuybackEvent[] = [];

  for (const row of rows) {
    const desc = safeStr(row.desc);
    const text = safeStr(row.attchmntText);
    const blob = `${desc} ${text}`;
    if (!isBuybackSubject(blob)) continue;

    const announcedAt =
      parseNseDate(row.sort_date) ||
      parseNseDate(row.an_dt) ||
      parseNseDate(row.an_dt?.slice(0, 11));
    const status = classifyBuybackStatus(desc, text);
    const seqId = safeStr(row.seq_id) || null;

    out.push({
      id: eventId(key, "nse_announcement", seqId || `${announcedAt}|${desc.slice(0, 40)}`),
      ticker: key,
      announced_at: announcedAt,
      ex_date: null,
      max_price: parseMaxPrice(text),
      pct_equity: parsePctEquity(text),
      size_shares: parseShareCount(text),
      status,
      subject: desc || null,
      description: text || null,
      source: "nse_announcement",
      seq_id: seqId,
    });
  }

  return out;
}

export async function fetchNseBuybacksForTicker(
  jar: NseCookieJar,
  ticker: string,
): Promise<BuybackEvent[]> {
  return fetchNseBuybackAnnouncements(jar, ticker);
}
