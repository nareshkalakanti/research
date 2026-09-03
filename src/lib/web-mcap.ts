/**
 * Tickertape + Groww company profile (mcap, sector, about, key people).
 */
import { runConcurrent } from "@/lib/scrape-pool";
import type { YfQuote } from "@/lib/yfinance";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const TICKERTAPE_SEARCH = "https://api.tickertape.in/stocks/search?text=";
const TICKERTAPE_INFO = "https://api.tickertape.in/stocks/info/";
const GROWW_SEARCH =
  "https://groww.in/v1/api/search/v1/entity?app=web&entity_type=stocks&query=";
const GROWW_COMPANY =
  "https://groww.in/v1/api/stocks_data/v1/company/search_id/";
const GROWW_PRICE =
  "https://groww.in/v1/api/stocks_data/v1/tr_live_prices/exchange/";

export type WebProfile = {
  ticker: string;
  matched_name: string;
  exchange: string;
  isin: string;
  sector: string;
  subsector: string;
  about: string;
  ceo: string;
  managing_director: string;
  founded_year: string;
  price: number | null;
  mcap_cr: number | null;
  source: "tickertape" | "groww" | "tickertape+groww";
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = str(value);
    if (text && !["unknown", "none", "null"].includes(text.toLowerCase())) {
      return text;
    }
  }
  return "";
}

function cleanText(value: unknown): string {
  return firstText(value).replace(/\s+/g, " ").trim();
}

function fillBlank(target: WebProfile, extra: Partial<WebProfile>): void {
  for (const [key, value] of Object.entries(extra) as Array<
    [keyof WebProfile, WebProfile[keyof WebProfile]]
  >) {
    if (value == null || value === "") continue;
    const cur = target[key];
    if (cur == null || cur === "") {
      (target as Record<string, unknown>)[key] = value;
    }
  }
}

export function normalizeName(value: string): string {
  let text = value.toLowerCase();
  text = text.replace(/&/g, " and ");
  text = text.replace(/[^a-z0-9]+/g, " ");
  text = text.replace(/\b(limited|ltd|pvt|private|the|india|indian)\b/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

export function namesMatch(left: string, right: string): boolean {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export function parseCompactInr(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value
    .replace(/₹/g, "")
    .replace(/Rs\./gi, "")
    .replace(/INR/gi, "")
    .replace(/,/g, "")
    .trim();
  const match = text.match(
    /([0-9]*\.?[0-9]+)\s*(L\s*Cr|Lakh Cr|Cr|Crore|Lakh|L)?/i,
  );
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = (match[2] || "Cr").toLowerCase().replace(/\s+/g, "");
  if (unit === "lcr" || unit === "lakhcr") return number * 100_000;
  if (unit === "cr" || unit === "crore") return number;
  if (unit === "lakh" || unit === "l") return number / 100;
  return number;
}

function headersFor(url: string): Record<string, string> {
  const tickertape = url.includes("tickertape.in");
  return {
    "User-Agent": USER_AGENT,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: tickertape ? "https://www.tickertape.in/" : "https://groww.in/",
    Origin: tickertape ? "https://www.tickertape.in" : "https://groww.in",
  };
}

async function httpGetJson(
  url: string,
  timeoutMs = 20_000,
  retries = 5,
): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: headersFor(url),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status} for ${url}`);
        const retryable = [429, 500, 502, 503, 504].includes(res.status);
        if (retryable && attempt < retries - 1) {
          const base = res.status === 429 ? 8_000 : 1_500;
          await sleep(base * 1.6 ** attempt + Math.random() * 2_000);
          continue;
        }
        throw lastError;
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        await sleep(1_800 * 1.5 ** attempt + Math.random() * 1_200);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`GET failed for ${url}`);
}

function subsectorFromTags(tags: unknown): string {
  for (const tag of asArray(tags)) {
    const rec = asRecord(tag);
    if (str(rec.type).toLowerCase() === "sub-sector") {
      return firstText(rec.name);
    }
  }
  return "";
}

function emptyProfile(ticker: string): WebProfile {
  return {
    ticker: ticker.toUpperCase(),
    matched_name: "",
    exchange: "",
    isin: "",
    sector: "",
    subsector: "",
    about: "",
    ceo: "",
    managing_director: "",
    founded_year: "",
    price: null,
    mcap_cr: null,
    source: "tickertape",
  };
}

async function tickertapeLookup(
  symbol: string,
  companyName: string,
): Promise<WebProfile | null> {
  const payload = asRecord(
    await httpGetJson(`${TICKERTAPE_SEARCH}${encodeURIComponent(symbol)}`),
  );
  const results = asArray(asRecord(payload.data).searchResults);
  const exact: Array<{ sid: string; ticker: string; name: string; exchange: string }> =
    [];
  const fuzzy: Array<{ sid: string; ticker: string; name: string; exchange: string }> =
    [];

  for (const item of results) {
    const rec = asRecord(item);
    const info = asRecord(asRecord(rec.stock).info);
    const ticker = str(info.ticker).toUpperCase();
    const name = str(info.name);
    const sid = str(rec.sid);
    if (!sid) continue;
    const row = { sid, ticker, name, exchange: str(info.exchange) };
    if (ticker === symbol.toUpperCase()) exact.push(row);
    else if (namesMatch(companyName, name)) fuzzy.push(row);
  }

  const chosen = exact[0] ?? fuzzy[0];
  if (!chosen) return null;

  const infoPayload = asRecord(
    await httpGetJson(`${TICKERTAPE_INFO}${encodeURIComponent(chosen.sid)}`),
  );
  const data = asRecord(infoPayload.data);
  const ratios = asRecord(data.ratios);
  const info = asRecord(data.info);
  const gic = asRecord(data.gic);
  const sectorLabel = asRecord(asRecord(data.labels).sector);
  const marketCap = num(ratios.marketCap) ?? num(ratios.mrktCapf);

  return {
    ticker: symbol.toUpperCase(),
    matched_name: firstText(info.name, chosen.name),
    exchange: firstText(info.exchange, chosen.exchange),
    isin: firstText(data.isin),
    sector: firstText(sectorLabel.title, gic.sector),
    subsector: firstText(
      info.sector,
      sectorLabel.description,
      subsectorFromTags(info.tags),
      gic.industry,
      gic.subindustry,
    ),
    about: cleanText(info.description),
    ceo: "",
    managing_director: "",
    founded_year: "",
    price: num(ratios.lastPrice),
    mcap_cr:
      marketCap != null && marketCap > 0
        ? Math.round(marketCap * 10_000) / 10_000
        : null,
    source: "tickertape",
  };
}

async function growwCompanyData(
  symbol: string,
  companyName: string,
): Promise<{ hit: Record<string, unknown>; company: Record<string, unknown> } | null> {
  const payload = asRecord(
    await httpGetJson(`${GROWW_SEARCH}${encodeURIComponent(symbol)}`),
  );
  const hits = asArray(payload.content);
  const exact: Record<string, unknown>[] = [];
  const fuzzy: Record<string, unknown>[] = [];

  for (const hit of hits) {
    const rec = asRecord(hit);
    const nse = str(rec.nse_scrip_code).toUpperCase();
    const bse = str(rec.bse_scrip_code).toUpperCase();
    const title = str(rec.title) || str(rec.company_short_name);
    if (nse === symbol.toUpperCase() || bse === symbol.toUpperCase()) {
      exact.push(rec);
    } else if (namesMatch(companyName, title)) {
      fuzzy.push(rec);
    }
  }

  const hit = exact[0] ?? fuzzy[0];
  if (!hit) return null;
  const searchId = str(hit.search_id) || str(hit.id);
  if (!searchId) return null;
  const company = asRecord(
    await httpGetJson(`${GROWW_COMPANY}${encodeURIComponent(searchId)}`),
  );
  return { hit, company };
}

function profileFromGroww(company: Record<string, unknown>): Partial<WebProfile> {
  const details = asRecord(company.details);
  return {
    about: cleanText(details.businessSummary),
    ceo: firstText(details.ceo),
    managing_director: firstText(details.managingDirector),
    founded_year: firstText(details.foundedYear),
  };
}

async function growwLookup(
  symbol: string,
  companyName: string,
): Promise<WebProfile | null> {
  const data = await growwCompanyData(symbol, companyName);
  if (!data) return null;
  const { hit, company } = data;
  const header = asRecord(company.header);
  const fundamentals = asArray(company.fundamentals);
  const marketCapValue = fundamentals
    .map((item) => asRecord(item))
    .find((item) => str(item.name) === "Market Cap");
  const marketCapCr = parseCompactInr(str(marketCapValue?.value) || null);

  let price: number | null = null;
  const exchange = header.isNseTradable
    ? "NSE"
    : header.isBseTradable
      ? "BSE"
      : "";
  const liveSymbol =
    str(header.nseScriptCode) || str(header.bseScriptCode) || symbol;
  if (exchange && liveSymbol) {
    try {
      const pricePayload = asRecord(
        await httpGetJson(
          `${GROWW_PRICE}${encodeURIComponent(exchange)}/segment/CASH/${encodeURIComponent(liveSymbol)}/latest`,
        ),
      );
      price = num(pricePayload.ltp) ?? num(pricePayload.close);
    } catch {
      price = null;
    }
  }

  return {
    ...emptyProfile(symbol),
    matched_name: firstText(header.displayName, hit.title),
    exchange,
    isin: firstText(header.isin, hit.isin),
    subsector: firstText(header.industryName),
    ...profileFromGroww(company),
    price,
    mcap_cr:
      marketCapCr != null && marketCapCr > 0
        ? Math.round(marketCapCr * 10_000) / 10_000
        : null,
    source: "groww",
  };
}

function hasUsefulProfile(p: WebProfile): boolean {
  return Boolean(
    (p.mcap_cr != null && p.mcap_cr > 0) ||
      p.about ||
      p.sector ||
      p.subsector ||
      p.ceo ||
      p.managing_director,
  );
}

function jittered(delayMs: number, spread = 0.55): number {
  if (delayMs <= 0) return 0;
  return delayMs * (0.75 + Math.random() * spread);
}

async function fetchOne(
  ticker: string,
  companyName: string,
  delayMs: number,
): Promise<WebProfile | null> {
  const wait = jittered(delayMs);
  if (wait > 0) await sleep(wait);
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;

  let found: WebProfile | null = null;
  try {
    found = await tickertapeLookup(symbol, companyName);
  } catch {
    found = null;
  }

  if (found) {
    const gap = jittered(delayMs, 0.4);
    if (gap > 0) await sleep(gap);
    try {
      const groww = await growwCompanyData(symbol, companyName);
      if (groww) {
        fillBlank(found, profileFromGroww(groww.company));
        const header = asRecord(groww.company.header);
        fillBlank(found, {
          subsector: firstText(header.industryName),
          isin: firstText(header.isin),
        });
        found.source = found.ceo || found.managing_director || found.about
          ? "tickertape+groww"
          : "tickertape";
      }
    } catch {
      /* Tickertape hit is enough */
    }
    return hasUsefulProfile(found) ? found : null;
  }

  try {
    found = await growwLookup(symbol, companyName);
  } catch {
    found = null;
  }
  return found && hasUsefulProfile(found) ? found : null;
}

export function webProfileToQuote(p: WebProfile): YfQuote | null {
  if (p.mcap_cr == null && p.price == null) return null;
  return {
    ticker: p.ticker,
    yf_symbol: `${p.source}:${p.ticker}`,
    price: p.price != null ? Math.round(p.price * 100) / 100 : null,
    mcap_cr: p.mcap_cr,
    sector: p.sector || null,
  };
}

export async function fetchWebProfiles(
  items: Array<{ ticker: string; name?: string | null; market?: string | null }>,
  opts?: { concurrency?: number; delayMs?: number },
): Promise<WebProfile[]> {
  if (!items.length) return [];
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 2, 4));
  const delayMs = opts?.delayMs ?? 700;
  const hits = await runConcurrent(items, concurrency, async (c) =>
    fetchOne(c.ticker, c.name?.trim() || c.ticker, delayMs),
  );
  return hits.filter((p): p is WebProfile => p != null);
}

export async function fetchWebMcapQuotes(
  items: Array<{ ticker: string; name?: string | null; market?: string | null }>,
  opts?: { concurrency?: number; delayMs?: number },
): Promise<YfQuote[]> {
  const profiles = await fetchWebProfiles(items, opts);
  return profiles
    .map(webProfileToQuote)
    .filter((q): q is YfQuote => q != null && q.mcap_cr != null);
}
