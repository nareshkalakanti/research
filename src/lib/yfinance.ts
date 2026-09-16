import YahooFinance from "yahoo-finance2";
import { runConcurrent } from "./scrape-pool";
import { canonicalTicker } from "./ticker-aliases";

const yf = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
  // Yahoo occasionally returns valid partial payloads that fail strict schema checks.
  validation: { logErrors: false, logOptionsErrors: false },
});

export type YfQuote = {
  ticker: string;
  yf_symbol: string;
  price: number | null;
  mcap_cr: number | null;
  sector: string | null;
  /** Daily % change (Yahoo regularMarketChangePercent). */
  change_pct?: number | null;
  error?: string;
};

/** Map India listing → Yahoo Finance symbol (NSE / NSE SME). */
export function toYfinanceSymbol(
  ticker: string,
  market?: string | null,
): string {
  const sym = canonicalTicker(ticker);
  if (!sym) return "";
  if (sym.endsWith(".NS") || sym.endsWith(".BO")) return sym;
  if (sym.endsWith("-SM")) return `${sym}.NS`;

  const mk = (market || "").trim().toUpperCase();
  if (mk === "NSE SME" || mk === "SME" || mk === "EMERGE") {
    return `${sym}-SM.NS`;
  }
  if (
    mk === "BSE" ||
    mk === "BSE SME" ||
    mk === "BOMBAY STOCK EXCHANGE" ||
    mk.startsWith("BSE")
  ) {
    return `${sym}.BO`;
  }
  return `${sym}.NS`;
}

function toBoSymbol(nsSymbol: string): string {
  return nsSymbol
    .replace(/-SM\.NS$/i, ".BO")
    .replace(/\.NS$/i, ".BO");
}

/**
 * Yahoo symbol candidates for India names.
 * SME quotes live on `TICKER-SM.NS`; some also have a ghost `TICKER.NS`
 * (e.g. VILAS) while others (e.g. SUNLITE) only resolve as `-SM.NS`.
 */
export function yfSymbolCandidates(
  ticker: string,
  market?: string | null,
): string[] {
  const primary = toYfinanceSymbol(ticker, market);
  if (!primary) return [];

  const bare = canonicalTicker(ticker)
    .replace(/-SM$/i, "")
    .replace(/\.(NS|BO)$/i, "");
  if (!bare) return [primary];

  const out: string[] = [];
  const add = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };

  add(primary);
  const mk = (market || "").trim().toUpperCase();
  const isNseSme = mk === "NSE SME" || mk === "SME" || mk === "EMERGE";
  if (isNseSme) {
    // SME board quotes live on -SM.NS; bare .NS is often a ghost fund stub (wrong LTP).
    add(`${bare}.BO`);
    return out;
  }
  add(`${bare}-SM.NS`);
  add(`${bare}.NS`);
  add(`${bare}.BO`);
  add(toBoSymbol(primary));

  return out;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function yahooChangePct(q: {
  regularMarketChangePercent?: unknown;
  regularMarketChange?: unknown;
  regularMarketPreviousClose?: unknown;
  regularMarketPrice?: unknown;
}): number | null {
  const pct = num(q.regularMarketChangePercent);
  if (pct != null) return Math.round(pct * 100) / 100;
  const chg = num(q.regularMarketChange);
  const prev = num(q.regularMarketPreviousClose) ?? num(q.regularMarketPrice);
  if (chg != null && prev != null && prev !== 0) {
    return Math.round((chg / prev) * 10000) / 100;
  }
  return null;
}

/** Listed shares when Yahoo omits marketCap (rare NSE SME listings). */
const KNOWN_LISTED_SHARES: Record<string, number> = {
  VISDEM: 10_272_093,
};

function deriveMcapFromKnownShares(
  ticker: string,
  price: number | null,
): number | null {
  if (price == null) return null;
  const shares = KNOWN_LISTED_SHARES[ticker.toUpperCase()];
  if (!shares || shares <= 0) return null;
  return price * shares;
}

function mcapToCr(mcap: number | null): number | null {
  if (mcap == null || mcap <= 0) return null;
  return Math.round((mcap / 1e7) * 10) / 10;
}

function isGhostNs(sym: string, priceSym: string | null): boolean {
  return (
    sym.endsWith(".NS") &&
    !sym.includes("-SM") &&
    !!priceSym?.includes("-SM")
  );
}

function absorbBits(
  bits: QuoteBits,
  used: string,
  priceSym: string | null,
  sym: string,
  q: QuoteBits | null,
): { bits: QuoteBits; used: string; priceSym: string | null } {
  if (!q) return { bits, used, priceSym };
  let next = bits;
  let nextUsed = used;
  let nextPrice = priceSym;
  if (q.price != null && next.price == null) {
    next = { ...next, price: q.price };
    nextPrice = sym;
    nextUsed = sym;
  }
  if (
    q.mcap != null &&
    q.mcap > 0 &&
    next.mcap == null &&
    !isGhostNs(sym, nextPrice)
  ) {
    next = { ...next, mcap: q.mcap };
    if (next.price == null) nextUsed = sym;
  }
  if (q.shares != null && next.shares == null) {
    next = { ...next, shares: q.shares };
  }
  if (q.sector != null && next.sector == null) {
    next = { ...next, sector: q.sector };
  }
  if (q.change_pct != null && next.change_pct == null) {
    next = { ...next, change_pct: q.change_pct };
  }
  return { bits: next, used: nextUsed, priceSym: nextPrice };
}

type QuoteBits = {
  price: number | null;
  mcap: number | null;
  shares: number | null;
  sector: string | null;
  change_pct: number | null;
};

function emptyBits(): QuoteBits {
  return {
    price: null,
    mcap: null,
    shares: null,
    sector: null,
    change_pct: null,
  };
}

function yfQuoteFromBits(
  ticker: string,
  used: string,
  bits: QuoteBits,
  error?: string,
): YfQuote {
  return {
    ticker: ticker.toUpperCase(),
    yf_symbol: used,
    price: bits.price != null ? Math.round(bits.price * 100) / 100 : null,
    mcap_cr: mcapToCr(bits.mcap),
    sector: bits.sector,
    change_pct: bits.change_pct,
    ...(error ? { error } : {}),
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        t = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function quoteBits(symbol: string): Promise<QuoteBits | null> {
  try {
    const q = await withTimeout(yf.quote(symbol), 7000);
    if (!q) return null;
    const price = num(q.regularMarketPrice);
    const mcap = num(q.marketCap);
    const shares = num(
      (q as { sharesOutstanding?: number }).sharesOutstanding,
    );
    return {
      price,
      mcap,
      shares,
      sector: (q.sector as string | undefined)?.trim() || null,
      change_pct: yahooChangePct(q),
    };
  } catch {
    return null;
  }
}

async function summaryBits(symbol: string): Promise<QuoteBits | null> {
  try {
    const qs = await withTimeout(
      yf.quoteSummary(symbol, {
        modules: ["price", "summaryDetail", "defaultKeyStatistics"],
      }),
      8000,
    );
    const price =
      num(qs.price?.regularMarketPrice) ??
      num(qs.price?.postMarketPrice) ??
      num(qs.summaryDetail?.regularMarketPrice);
    const mcap =
      num(qs.price?.marketCap) ?? num(qs.summaryDetail?.marketCap);
    const shares =
      num(qs.defaultKeyStatistics?.sharesOutstanding) ??
      num(qs.defaultKeyStatistics?.impliedSharesOutstanding);
    const sector =
      (qs.summaryProfile as { sector?: string } | undefined)?.sector?.trim() ||
      null;
    const change_pct = yahooChangePct({
      regularMarketChangePercent: qs.price?.regularMarketChangePercent,
      regularMarketChange: qs.price?.regularMarketChange,
      regularMarketPreviousClose: qs.price?.regularMarketPreviousClose,
      regularMarketPrice: qs.price?.regularMarketPrice,
    });
    return { price, mcap, shares, sector, change_pct };
  } catch {
    return null;
  }
}

/**
 * Fetch price + market cap (₹ Cr).
 * Many India names expose mcap only on `.BO` — we try `.NS` then `.BO` + quoteSummary.
 */
export async function fetchQuoteDetailed(
  ticker: string,
  market?: string | null,
  opts?: { skipSummary?: boolean },
): Promise<YfQuote> {
  const symbols = yfSymbolCandidates(ticker, market);
  const base = symbols[0] ?? "";
  if (!base) {
    return {
      ticker,
      yf_symbol: "",
      price: null,
      mcap_cr: null,
      sector: null,
      change_pct: null,
      error: "empty symbol",
    };
  }

  let bits: QuoteBits = emptyBits();
  let used = base;
  let priceSym: string | null = null;

  const quoteHits = await Promise.all(
    symbols.map(async (sym) => ({ sym, q: await quoteBits(sym) })),
  );
  for (const { sym, q } of quoteHits) {
    const next = absorbBits(bits, used, priceSym, sym, q);
    bits = next.bits;
    used = next.used;
    priceSym = next.priceSym;
  }

  if (
    !opts?.skipSummary &&
    (bits.mcap == null || bits.price == null)
  ) {
    const summaryHits = await Promise.all(
      symbols
        .filter((sym) => !isGhostNs(sym, priceSym))
        .map(async (sym) => ({ sym, s: await summaryBits(sym) })),
    );
    for (const { sym, s } of summaryHits) {
      const next = absorbBits(bits, used, priceSym, sym, s);
      bits = next.bits;
      used = next.used;
      priceSym = next.priceSym;
    }
  }

  if (bits.mcap == null && bits.price != null && bits.shares != null && bits.shares > 0) {
    bits.mcap = bits.price * bits.shares;
  }
  if (bits.mcap == null && bits.price != null) {
    const derived = deriveMcapFromKnownShares(ticker, bits.price);
    if (derived != null) bits.mcap = derived;
  }

  if (bits.price == null && bits.mcap == null) {
    return yfQuoteFromBits(ticker, used, bits, "no quote");
  }

  return yfQuoteFromBits(ticker, used, bits);
}

/** Fast live price refresh — single Yahoo quote per ticker (no quoteSummary fallbacks). */
export async function fetchLivePrices(
  items: Array<{ ticker: string; market?: string | null }>,
  opts?: { concurrency?: number },
): Promise<YfQuote[]> {
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 10, 16));
  return runConcurrent(items, concurrency, async ({ ticker, market }) => {
    const candidates = yfSymbolCandidates(ticker, market);
    const sym = candidates[0] ?? "";
    if (!sym) {
      return {
        ticker: ticker.toUpperCase(),
        yf_symbol: "",
        price: null,
        mcap_cr: null,
        sector: null,
        change_pct: null,
        error: "empty symbol",
      };
    }
    const hits = await Promise.all(
      candidates.slice(0, 3).map(async (s) => ({ s, q: await quoteBits(s) })),
    );
    let bits: QuoteBits = emptyBits();
    let used = sym;
    let priceSym: string | null = null;
    for (const { s, q } of hits) {
      const next = absorbBits(bits, used, priceSym, s, q);
      bits = next.bits;
      used = next.used;
      priceSym = next.priceSym;
    }
    if (bits.price == null && bits.mcap == null) {
      return yfQuoteFromBits(ticker, used, bits, "no quote");
    }
    let mcap = bits.mcap;
    if (mcap == null && bits.price != null && bits.shares != null) {
      mcap = bits.price * bits.shares;
    }
    if (mcap == null && bits.price != null) {
      mcap = deriveMcapFromKnownShares(ticker, bits.price);
    }
    bits = { ...bits, mcap };
    return yfQuoteFromBits(ticker, used, bits);
  });
}

/**
 * Fetch price + market cap (₹ Cr) for a batch of tickers.
 */
export async function fetchQuotes(
  items: Array<{ ticker: string; market?: string | null }>,
  opts?: { concurrency?: number; skipSummary?: boolean },
): Promise<YfQuote[]> {
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 10, 16));
  return runConcurrent(items, concurrency, ({ ticker, market }) =>
    fetchQuoteDetailed(ticker, market, { skipSummary: opts?.skipSummary }),
  );
}

export type YfAboutProfile = {
  ticker: string;
  yf_symbol: string;
  about: string | null;
  website: string | null;
  headquarters: string | null;
  sector: string | null;
  industry: string | null;
};

function trimOrNull(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s || null;
}

function headquartersFromProfile(p: {
  city?: string | null;
  state?: string | null;
  country?: string | null;
}): string | null {
  return (
    [p.city, p.state, p.country]
      .map((x) => trimOrNull(x))
      .filter(Boolean)
      .join(", ") || null
  );
}

/** Yahoo quoteSummary — about, website, HQ (tries .NS / -SM.NS / .BO candidates). */
export async function fetchYfAboutProfile(
  ticker: string,
  market?: string | null,
): Promise<YfAboutProfile | null> {
  const symbols = yfSymbolCandidates(ticker, market);
  if (!symbols.length) return null;

  for (const sym of symbols) {
    try {
      const qs = await yf.quoteSummary(sym, {
        modules: ["summaryProfile", "assetProfile"],
      });
      const p = qs.summaryProfile ?? qs.assetProfile;
      if (!p) continue;
      const about = trimOrNull(p.longBusinessSummary as string | undefined);
      const website = trimOrNull(p.website as string | undefined);
      const headquarters = headquartersFromProfile(p);
      const sector = trimOrNull(p.sector as string | undefined);
      const industry = trimOrNull(p.industry as string | undefined);
      if (!about && !website && !headquarters) continue;
      return {
        ticker: ticker.toUpperCase(),
        yf_symbol: sym,
        about,
        website,
        headquarters,
        sector,
        industry,
      };
    } catch {
      continue;
    }
  }
  return null;
}
