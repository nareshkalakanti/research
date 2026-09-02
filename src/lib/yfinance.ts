import YahooFinance from "yahoo-finance2";
import { runConcurrent } from "./scrape-pool";

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
  error?: string;
};

/** Map India listing → Yahoo Finance symbol (NSE / NSE SME). */
export function toYfinanceSymbol(
  ticker: string,
  market?: string | null,
): string {
  const sym = (ticker || "").trim().toUpperCase();
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
    mk === "BOMBAY STOCK EXCHANGE"
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

  const bare = (ticker || "")
    .trim()
    .toUpperCase()
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
  return { bits: next, used: nextUsed, priceSym: nextPrice };
}

type QuoteBits = {
  price: number | null;
  mcap: number | null;
  shares: number | null;
  sector: string | null;
};

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
    return { price, mcap, shares, sector };
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
      error: "empty symbol",
    };
  }

  let bits: QuoteBits = {
    price: null,
    mcap: null,
    shares: null,
    sector: null,
  };
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
    return {
      ticker: ticker.toUpperCase(),
      yf_symbol: used,
      price: null,
      mcap_cr: null,
      sector: null,
      error: "no quote",
    };
  }

  return {
    ticker: ticker.toUpperCase(),
    yf_symbol: used,
    price: bits.price != null ? Math.round(bits.price * 100) / 100 : null,
    mcap_cr: mcapToCr(bits.mcap),
    sector: bits.sector,
  };
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
        error: "empty symbol",
      };
    }
    const hits = await Promise.all(
      candidates.slice(0, 3).map(async (s) => ({ s, q: await quoteBits(s) })),
    );
    let bits: QuoteBits = {
      price: null,
      mcap: null,
      shares: null,
      sector: null,
    };
    let used = sym;
    let priceSym: string | null = null;
    for (const { s, q } of hits) {
      const next = absorbBits(bits, used, priceSym, s, q);
      bits = next.bits;
      used = next.used;
      priceSym = next.priceSym;
    }
    if (bits.price == null && bits.mcap == null) {
      return {
        ticker: ticker.toUpperCase(),
        yf_symbol: used,
        price: null,
        mcap_cr: null,
        sector: null,
        error: "no quote",
      };
    }
    let mcap = bits.mcap;
    if (mcap == null && bits.price != null && bits.shares != null) {
      mcap = bits.price * bits.shares;
    }
    if (mcap == null && bits.price != null) {
      mcap = deriveMcapFromKnownShares(ticker, bits.price);
    }
    return {
      ticker: ticker.toUpperCase(),
      yf_symbol: used,
      price: bits.price != null ? Math.round(bits.price * 100) / 100 : null,
      mcap_cr: mcapToCr(mcap),
      sector: bits.sector,
    };
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
