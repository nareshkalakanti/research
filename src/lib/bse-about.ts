/**
 * BSE SME company about + website via Yahoo quoteSummary on `.BO` symbols.
 * BSE's own APIs don't expose long business descriptions.
 */
import YahooFinance from "yahoo-finance2";
import { toYfinanceSymbol } from "./yfinance";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export type BseAboutProfile = {
  ticker: string;
  about: string | null;
  website: string | null;
  headquarters: string | null;
  yf_symbol: string;
};

function nonempty(v: string | null | undefined): string | null {
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
      .map((x) => nonempty(x))
      .filter(Boolean)
      .join(", ") || null
  );
}

/** Fetch about text + website for a BSE / BSE SME ticker. */
export async function fetchBseAboutProfile(
  ticker: string,
  market?: string | null,
): Promise<BseAboutProfile | null> {
  const sym = toYfinanceSymbol(ticker, market || "BSE SME");
  if (!sym) return null;

  try {
    const qs = await yf.quoteSummary(sym, {
      modules: ["summaryProfile", "assetProfile"],
    });
    const p = qs.summaryProfile ?? qs.assetProfile;
    const about = nonempty(p?.longBusinessSummary);
    const website = nonempty(p?.website);
    const headquarters = p ? headquartersFromProfile(p) : null;
    if (!about && !website && !headquarters) return null;
    return {
      ticker: ticker.toUpperCase(),
      about,
      website,
      headquarters,
      yf_symbol: sym,
    };
  } catch {
    return null;
  }
}

/** Batch-fetch about / website / HQ for BSE SME tickers. */
export async function enrichBseAboutProfiles(
  tickers: string[],
  opts?: {
    concurrency?: number;
    delayMs?: number;
    onProgress?: (done: number) => void;
    market?: string | null;
  },
): Promise<Map<string, BseAboutProfile>> {
  const out = new Map<string, BseAboutProfile>();
  const want = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))];
  if (!want.length) return out;

  const concurrency = Math.max(1, opts?.concurrency ?? 4);
  const delayMs = opts?.delayMs ?? 120;
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < want.length) {
      const ticker = want[next++]!;
      try {
        const profile = await fetchBseAboutProfile(ticker, opts?.market);
        if (profile) out.set(ticker, profile);
      } catch {
        /* skip */
      }
      done += 1;
      opts?.onProgress?.(done);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}
