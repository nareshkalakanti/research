import {
  createNseBuybackSession,
  nseFetch,
  type NseCookieJar,
} from "@/lib/nse-buybacks";
import { runConcurrent } from "@/lib/scrape-pool";
import type { YfQuote } from "@/lib/yfinance";

const QUOTE_URL = "https://www.nseindia.com/api/quote-equity";
const QUOTE_PAGE = "https://www.nseindia.com/get-quotes/equity";

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function nseSymbol(ticker: string): string {
  return (ticker || "")
    .trim()
    .toUpperCase()
    .replace(/-SM$/i, "")
    .replace(/\.(NS|BO)$/i, "");
}

function mcapToCr(mcap: number | null): number | null {
  if (mcap == null || mcap <= 0) return null;
  return Math.round((mcap / 1e7) * 10) / 10;
}

type NseQuoteJson = {
  priceInfo?: { lastPrice?: unknown };
  securityInfo?: { issuedSize?: unknown };
  info?: { symbol?: unknown };
};

function parseQuote(json: NseQuoteJson): {
  price: number | null;
  mcap_cr: number | null;
} {
  const price = num(json.priceInfo?.lastPrice);
  const issued = num(json.securityInfo?.issuedSize);
  const mcap =
    price != null && issued != null && issued > 0 ? price * issued : null;
  return { price, mcap_cr: mcapToCr(mcap) };
}

async function quoteOne(
  jar: NseCookieJar,
  ticker: string,
): Promise<YfQuote | null> {
  const symbol = nseSymbol(ticker);
  if (!symbol) return null;
  try {
    await nseFetch(QUOTE_PAGE, jar, {
      params: { symbol },
      referer: "https://www.nseindia.com/",
    });
    const res = await nseFetch(QUOTE_URL, jar, {
      params: { symbol },
      referer: `${QUOTE_PAGE}?symbol=${encodeURIComponent(symbol)}`,
    });
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("json")) return null;
    const json = (await res.json()) as NseQuoteJson;
    const parsed = parseQuote(json);
    if (parsed.price == null && parsed.mcap_cr == null) return null;
    return {
      ticker: ticker.toUpperCase(),
      yf_symbol: `NSE:${symbol}`,
      price: parsed.price != null ? Math.round(parsed.price * 100) / 100 : null,
      mcap_cr: parsed.mcap_cr,
      sector: null,
    };
  } catch {
    return null;
  }
}

/**
 * NSE quote-equity: lastPrice × issuedSize → ₹ Cr.
 * Yahoo often has SME LTP but no marketCap; this fills that gap.
 */
export async function fetchNseMcapQuotes(
  items: Array<{ ticker: string; market?: string | null }>,
  opts?: { concurrency?: number },
): Promise<YfQuote[]> {
  const nseItems = items.filter((c) => {
    const mk = (c.market || "").toUpperCase();
    return mk !== "BSE SME" && mk !== "BSE";
  });
  if (!nseItems.length) return [];

  const jar = await createNseBuybackSession();
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 3, 4));
  const hits = await runConcurrent(nseItems, concurrency, async (c) => {
    const q = await quoteOne(jar, c.ticker);
    await new Promise((r) => setTimeout(r, 80));
    return q;
  });
  return hits.filter((q): q is YfQuote => q != null && q.mcap_cr != null);
}
