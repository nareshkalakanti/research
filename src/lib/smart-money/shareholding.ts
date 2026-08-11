/**
 * NSE shareholding pattern scan — find Trilithon / Devabhaktuni in SME symbols.
 */
import { matchInvestors, primaryInvestorIds } from "@/lib/smart-money/investors";
import { bareSymbol } from "@/lib/bulk-deals/nse";
import { loadHiddenUniverse } from "@/lib/hidden-portfolio/universe";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NSE_HOME = "https://www.nseindia.com/";
const NSE_QUOTE = "https://www.nseindia.com/get-quotes/equity";
const SHP_URL = "https://www.nseindia.com/api/shareholding-pattern";
const HOLDINGS_URL = "https://www.nseindia.com/api/corporates-holdings";
const TIMEOUT_MS = 35_000;
const SLEEP_MS = 800;
const MAX_RETRIES = 3;

export type ShareholdingHit = {
  symbol: string;
  company_name: string | null;
  holder_name: string;
  investor_ids: string[];
  primary_hit: boolean;
  pct: number | null;
  shares: number | null;
  as_of_date: string | null;
  in_sme_universe: boolean;
  fetched_at: string;
};

type CookieJar = { cookie: string };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function parseNum(v: unknown): number | null {
  if (v == null || v === "" || v === "-") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function nseFetch(
  url: string,
  jar: CookieJar,
  params?: Record<string, string>,
): Promise<Response> {
  const u = new URL(url);
  if (params) {
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  }
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json,*/*",
    Referer: NSE_QUOTE,
  };
  if (jar.cookie) headers.Cookie = jar.cookie;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), { headers, signal: ctrl.signal });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length) {
      jar.cookie = [
        ...new Set([
          ...(jar.cookie ? jar.cookie.split("; ") : []),
          ...setCookie.map((c) => c.split(";")[0]!),
        ]),
      ].join("; ");
    }
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function warmNseSession(): Promise<CookieJar> {
  const jar: CookieJar = { cookie: "" };
  await nseFetch(NSE_HOME, jar);
  await sleep(400);
  await nseFetch(NSE_QUOTE, jar, { symbol: "ATAM" });
  await sleep(400);
  return jar;
}

function flattenShareholdingJson(json: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (!json || typeof json !== "object") return out;

  const walk = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const name = safeStr(
            o.holderName ??
              o.shareholderName ??
              o.name ??
              o.categoryName ??
              o.CategoryName ??
              o.desc ??
              o.label,
          );
          if (name && matchInvestors(name).length) out.push(o);
          walk(o);
        }
      }
      return;
    }
    if (typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) {
        walk(v);
      }
    }
  };

  walk(json);
  return out;
}

function holderFromRow(
  row: Record<string, unknown>,
  symbol: string,
  smeSet: Set<string>,
  fetchedAt: string,
): ShareholdingHit | null {
  const holder = safeStr(
    row.holderName ??
      row.shareholderName ??
      row.name ??
      row.categoryName ??
      row.CategoryName ??
      row.desc,
  );
  if (!holder) return null;

  const investor_ids = matchInvestors(holder);
  if (!investor_ids.length) return null;

  const sym = bareSymbol(symbol);
  return {
    symbol: sym,
    company_name: safeStr(row.companyName ?? row.symbol ?? "") || null,
    holder_name: holder,
    investor_ids,
    primary_hit: investor_ids.some((id) => primaryInvestorIds().includes(id)),
    pct: parseNum(
      row.percentage ??
        row.percHolding ??
        row.pct ??
        row.shareholdingPercentage ??
        row.holdingPct,
    ),
    shares: parseNum(row.noOfShares ?? row.shares ?? row.quantity ?? row.noOfSecurities),
    as_of_date: safeStr(row.date ?? row.asOnDate ?? row.period) || null,
    in_sme_universe: smeSet.has(sym),
    fetched_at: fetchedAt,
  };
}

async function fetchJsonWithRetry(
  url: string,
  jar: CookieJar,
  params: Record<string, string>,
): Promise<unknown | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await nseFetch(url, jar, params);
      if (!res.ok) {
        await sleep(SLEEP_MS * (attempt + 1));
        continue;
      }
      return await res.json();
    } catch {
      await sleep(SLEEP_MS * (attempt + 2));
      if (attempt === 1) {
        // Re-warm session on repeated failures
        await nseFetch(NSE_HOME, jar);
        await sleep(600);
      }
    }
  }
  return null;
}

/** Fetch shareholding for one NSE symbol and return tracked-investor hits. */
export async function fetchShareholdingHits(
  symbol: string,
  jar?: CookieJar,
): Promise<ShareholdingHit[]> {
  const session = jar ?? (await warmNseSession());
  const sym = bareSymbol(symbol);
  const fetchedAt = new Date().toISOString();
  const smeSet = new Set(
    loadHiddenUniverse({ includeDbSme: true }).map((r) => bareSymbol(r.symbol)),
  );

  const endpoints: Array<{ url: string; params: Record<string, string> }> = [
    {
      url: SHP_URL,
      params: { symbol: sym, categorization: "category-wise" },
    },
    { url: HOLDINGS_URL, params: { index: "equities", symbol: sym } },
    { url: SHP_URL, params: { symbol: sym, categorization: "public" } },
  ];

  const seen = new Set<string>();
  const out: ShareholdingHit[] = [];

  for (const ep of endpoints) {
    const json = await fetchJsonWithRetry(ep.url, session, ep.params);
    if (!json) continue;
    for (const row of flattenShareholdingJson(json)) {
      const hit = holderFromRow(row, sym, smeSet, fetchedAt);
      if (!hit) continue;
      const key = `${hit.symbol}|${hit.holder_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
    }
    if (out.length) break;
    await sleep(SLEEP_MS);
  }

  return out;
}

/** Scan a list of symbols for tracked investors in shareholding pattern. */
export async function scanShareholdingForSymbols(
  symbols: string[],
  opts?: { max?: number },
): Promise<ShareholdingHit[]> {
  const max = opts?.max ?? 25;
  const uniq = [...new Set(symbols.map((s) => bareSymbol(s)).filter(Boolean))].slice(
    0,
    max,
  );
  const jar = await warmNseSession();
  const out: ShareholdingHit[] = [];

  for (let i = 0; i < uniq.length; i++) {
    try {
      const hits = await fetchShareholdingHits(uniq[i]!, jar);
      out.push(...hits);
    } catch (e) {
      console.warn(`[shareholding] ${uniq[i]} failed:`, e);
    }
    if (i < uniq.length - 1) await sleep(SLEEP_MS);
  }
  return out;
}

/** Priority symbol list: known Trilithon names + deal symbols (not full universe). */
export function priorityShareholdingSymbols(dealSymbols: string[] = []): string[] {
  const seed = [
    "ATAM",
    "BPL",
    "DGCONTENT",
    "GPTINFRA",
    "HMT",
    "LOKESHMACH",
    "MIRCELECTR",
    "TEAMGTY",
    "PATELENG",
    "PREMEXPLN",
    "DHRUV",
    "AASTHA",
    "ACCORD",
  ];
  return [...new Set([...seed, ...dealSymbols.map(bareSymbol)])];
}
