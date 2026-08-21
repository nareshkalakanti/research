import YahooFinance from "yahoo-finance2";

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
  if (mcap == null) return null;
  return Math.round((mcap / 1e7) * 10) / 10;
}

type QuoteBits = {
  price: number | null;
  mcap: number | null;
  shares: number | null;
  sector: string | null;
};

async function quoteBits(symbol: string): Promise<QuoteBits | null> {
  try {
    const q = await yf.quote(symbol);
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
    const qs = await yf.quoteSummary(symbol, {
      modules: ["price", "summaryDetail", "defaultKeyStatistics"],
    });
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

function mergeBits(
  primary: QuoteBits | null,
  secondary: QuoteBits | null,
): QuoteBits {
  const price = primary?.price ?? secondary?.price ?? null;
  const mcap = primary?.mcap ?? secondary?.mcap ?? null;
  const shares = primary?.shares ?? secondary?.shares ?? null;
  const sector = primary?.sector ?? secondary?.sector ?? null;
  // Derive mcap from shares × price when Yahoo omits marketCap on .NS
  const derived =
    mcap == null && price != null && shares != null && shares > 0
      ? price * shares
      : mcap;
  return { price, mcap: derived, shares, sector };
}

/**
 * Fetch price + market cap (₹ Cr).
 * Many India names expose mcap only on `.BO` — we try `.NS` then `.BO` + quoteSummary.
 */
export async function fetchQuoteDetailed(
  ticker: string,
  market?: string | null,
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

  for (const sym of symbols) {
    const q = await quoteBits(sym);
    bits = mergeBits(bits, q);
    if (q?.price != null || q?.mcap != null) used = sym;
    if (bits.price != null && bits.mcap != null) break;
  }

  // quoteSummary fallback when still missing mcap
  if (bits.mcap == null || bits.price == null) {
    for (const sym of symbols) {
      const s = await summaryBits(sym);
      bits = mergeBits(bits, s);
      if (s?.mcap != null || s?.price != null) used = sym;
      if (bits.price != null && bits.mcap != null) break;
    }
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
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 8, 12));
  const out: YfQuote[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async ({ ticker, market }) => {
        const sym = toYfinanceSymbol(ticker, market);
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
        const bits = await quoteBits(sym);
        if (!bits || (bits.price == null && bits.mcap == null)) {
          return {
            ticker: ticker.toUpperCase(),
            yf_symbol: sym,
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
          yf_symbol: sym,
          price:
            bits.price != null ? Math.round(bits.price * 100) / 100 : null,
          mcap_cr: mcapToCr(mcap),
          sector: bits.sector,
        };
      }),
    );
    out.push(...results);
  }

  return out;
}

/**
 * Fetch price + market cap (₹ Cr) for a batch of tickers.
 */
export async function fetchQuotes(
  items: Array<{ ticker: string; market?: string | null }>,
  opts?: { concurrency?: number },
): Promise<YfQuote[]> {
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 4, 8));
  const out: YfQuote[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(({ ticker, market }) => fetchQuoteDetailed(ticker, market)),
    );
    out.push(...results);
  }

  return out;
}
