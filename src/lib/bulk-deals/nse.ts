/**
 * NSE bulk / block deal fetcher (snapshot + historical CSV).
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NSE_HOME = "https://www.nseindia.com/";
const NSE_QUOTE = "https://www.nseindia.com/get-quotes/equity";
const NSE_LARGE_DEALS = "https://www.nseindia.com/market-data/large-deals";
const SNAPSHOT_URL =
  "https://www.nseindia.com/api/snapshot-capital-market-largedeal";
const HISTORICAL_URL =
  "https://www.nseindia.com/api/historicalOR/bulk-block-short-deals";
const TIMEOUT_MS = 30_000;

import type { BulkDealRow, DealType } from "./types";
export type { BulkDealRow, DealType } from "./types";

type CookieJar = { cookie: string };

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function parseNum(v: unknown): number | null {
  if (v == null || v === "" || v === "-") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function formatNseDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function normalizeSide(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (s === "B" || s.startsWith("BUY")) return "BUY";
  if (s === "S" || s.startsWith("SEL")) return "SELL";
  return s || "—";
}

function normalizeTradeDate(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  // DD-MMM-YYYY → ISO-ish
  const m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const months: Record<string, string> = {
      JAN: "01",
      FEB: "02",
      MAR: "03",
      APR: "04",
      MAY: "05",
      JUN: "06",
      JUL: "07",
      AUG: "08",
      SEP: "09",
      OCT: "10",
      NOV: "11",
      DEC: "12",
    };
    const mo = months[m[2]!.toUpperCase()];
    if (mo) {
      return `${m[3]}-${mo}-${String(Number(m[1])).padStart(2, "0")}`;
    }
  }
  // DD-MM-YYYY
  const m2 = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m2) {
    return `${m2[3]}-${String(Number(m2[2])).padStart(2, "0")}-${String(Number(m2[1])).padStart(2, "0")}`;
  }
  return t;
}

async function nseFetch(
  url: string,
  jar: CookieJar,
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
    Accept: "application/json,text/csv,text/html,*/*",
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
    } else {
      const sc = res.headers.get("set-cookie");
      if (sc) {
        const part = sc.split(";")[0];
        if (part) {
          jar.cookie = jar.cookie ? `${jar.cookie}; ${part}` : part;
        }
      }
    }
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function warmNseSession(): Promise<CookieJar> {
  const jar: CookieJar = { cookie: "" };
  try {
    await nseFetch(NSE_QUOTE, jar, {
      params: { symbol: "TCS" },
      referer: NSE_HOME,
    });
    await nseFetch(NSE_LARGE_DEALS, jar, { referer: NSE_HOME });
  } catch {
    try {
      await nseFetch(NSE_HOME, jar);
    } catch {
      /* continue */
    }
  }
  return jar;
}

function rowFromSnapshot(
  raw: Record<string, unknown>,
  dealType: DealType,
  fetchedAt: string,
): BulkDealRow | null {
  const symbol = safeStr(raw.symbol ?? raw.Symbol).toUpperCase();
  if (!symbol) return null;
  return {
    trade_date: normalizeTradeDate(
      safeStr(raw.date ?? raw.tradeDate ?? raw.trade_date),
    ),
    symbol,
    security_name: safeStr(raw.secName ?? raw.securityName ?? raw.name),
    client_name: safeStr(raw.clientName ?? raw.client_name),
    side: normalizeSide(safeStr(raw.buySell ?? raw.buy_sell ?? raw.side)),
    quantity: parseNum(raw.quantity ?? raw.qty ?? raw.QuantityTraded),
    price: parseNum(
      raw.tradePrice ??
        raw.watp ??
        raw.avgPrice ??
        raw["TradePrice/Wght.Avg.Price"],
    ),
    deal_type: dealType,
    exchange: "NSE",
    fetched_at: fetchedAt,
  };
}

/** Parse NSE historical CSV text into deal rows. */
export function parseBulkDealsCsv(
  csv: string,
  dealType: DealType,
  fetchedAt: string,
): BulkDealRow[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const idx = (names: string[]) =>
    header.findIndex((h) => names.some((n) => h.includes(n)));

  const iDate = idx(["date"]);
  const iSym = idx(["symbol"]);
  const iName = idx(["security"]);
  const iClient = idx(["client"]);
  const iSide = idx(["buy", "sell"]);
  const iQty = idx(["quantity"]);
  const iPrice = idx(["price", "avg"]);

  const out: BulkDealRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const symbol = (cols[iSym] || "").toUpperCase().replace(/"/g, "");
    if (!symbol) continue;
    out.push({
      trade_date: normalizeTradeDate(cols[iDate] || ""),
      symbol,
      security_name: (cols[iName] || "").replace(/"/g, ""),
      client_name: (cols[iClient] || "").replace(/"/g, ""),
      side: normalizeSide(cols[iSide] || ""),
      quantity: parseNum(cols[iQty]),
      price: parseNum(cols[iPrice]),
      deal_type: dealType,
      exchange: "NSE",
      fetched_at: fetchedAt,
    });
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cols.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

/** Today's bulk + block deals from NSE snapshot API. */
export async function fetchNseDealSnapshot(): Promise<BulkDealRow[]> {
  const jar = await warmNseSession();
  const fetchedAt = new Date().toISOString();
  const out: BulkDealRow[] = [];

  for (const [mode, dealType] of [
    ["bulk_deals", "bulk"],
    ["block_deals", "block"],
  ] as const) {
    try {
      const res = await nseFetch(SNAPSHOT_URL, jar, {
        params: { mode },
        referer: NSE_LARGE_DEALS,
      });
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, unknown>;
      const key = mode;
      const arr =
        (json[key] as unknown[]) ??
        (json.data as unknown[]) ??
        (Array.isArray(json) ? json : []);
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (item && typeof item === "object") {
          const row = rowFromSnapshot(
            item as Record<string, unknown>,
            dealType,
            fetchedAt,
          );
          if (row) out.push(row);
        }
      }
    } catch (e) {
      console.warn(`[bulk-deals] snapshot ${mode} failed:`, e);
    }
  }
  return out;
}

/** Historical bulk or block deals for a date range (max ~365 days per call). */
export async function fetchNseDealsHistorical(opts: {
  from: Date;
  to: Date;
  dealType?: DealType;
}): Promise<BulkDealRow[]> {
  const jar = await warmNseSession();
  const fetchedAt = new Date().toISOString();
  const optionType =
    opts.dealType === "block" ? "block_deals" : "bulk_deals";
  const out: BulkDealRow[] = [];

  try {
    const res = await nseFetch(HISTORICAL_URL, jar, {
      params: {
        optionType,
        from: formatNseDate(opts.from),
        to: formatNseDate(opts.to),
        csv: "true",
      },
      referer: NSE_LARGE_DEALS,
    });
    if (!res.ok) return out;
    const text = await res.text();
    if (text.trim().startsWith("{")) {
      // JSON fallback
      const json = JSON.parse(text) as { data?: unknown[] };
      const arr = json.data ?? [];
      for (const item of arr) {
        if (item && typeof item === "object") {
          const row = rowFromSnapshot(
            item as Record<string, unknown>,
            opts.dealType ?? "bulk",
            fetchedAt,
          );
          if (row) out.push(row);
        }
      }
      return out;
    }
    out.push(
      ...parseBulkDealsCsv(text, opts.dealType ?? "bulk", fetchedAt),
    );
  } catch (e) {
    console.warn("[bulk-deals] historical fetch failed:", e);
  }
  return out;
}

/** Fetch bulk + block deals for the last N calendar days. */
export async function fetchNseDealsLastDays(
  days = 30,
): Promise<BulkDealRow[]> {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - Math.max(1, days));

  const [bulk, block] = await Promise.all([
    fetchNseDealsHistorical({ from, to, dealType: "bulk" }),
    fetchNseDealsHistorical({ from, to, dealType: "block" }),
  ]);

  // Snapshot may have today's deals before historical is updated
  let snapshot: BulkDealRow[] = [];
  try {
    snapshot = await fetchNseDealSnapshot();
  } catch {
    /* ignore */
  }

  return dedupeDeals([...bulk, ...block, ...snapshot]);
}

function dealKey(d: BulkDealRow): string {
  return [
    d.trade_date,
    d.symbol,
    d.client_name.toLowerCase(),
    d.side,
    d.deal_type,
    d.quantity ?? "",
    d.price ?? "",
  ].join("|");
}

export function dedupeDeals(rows: BulkDealRow[]): BulkDealRow[] {
  const seen = new Set<string>();
  const out: BulkDealRow[] = [];
  for (const r of rows) {
    const k = dealKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** Normalize symbol for matching universe (strip -SM.NS, .NS). */
export function bareSymbol(symbol: string): string {
  return symbol
    .trim()
    .toUpperCase()
    .replace(/-SM\.NS$/i, "")
    .replace(/\.(NS|BO)$/i, "");
}

export function symbolsMatch(a: string, b: string): boolean {
  const x = bareSymbol(a);
  const y = bareSymbol(b);
  return x === y || x.startsWith(y) || y.startsWith(x);
}
