/**
 * BSE bulk / block deal fetcher (live API + daily CSV archives).
 */
import type { BulkDealRow, DealType } from "./types";
import { dedupeDeals } from "./nse";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BSE_HOME = "https://www.bseindia.com/";
const BSE_BULK_PAGE =
  "https://www.bseindia.com/markets/equity/EQReports/bulk_deals.aspx";
const BSE_API_BULK = "https://api.bseindia.com/BseIndiaAPI/api/BulkDeal/w";
const BSE_API_BLOCK = "https://api.bseindia.com/BseIndiaAPI/api/BlockDeal/w";
const TIMEOUT_MS = 30_000;

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function parseNum(v: unknown): number | null {
  if (v == null || v === "" || v === "-") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
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
  // DD/MM/YYYY
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    return `${m[3]}-${String(Number(m[2])).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
  }
  // DD-MM-YYYY
  const m2 = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m2) {
    return `${m2[3]}-${String(Number(m2[2])).padStart(2, "0")}-${String(Number(m2[1])).padStart(2, "0")}`;
  }
  return t;
}

function formatBseCsvDate(d: Date): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const dd = String(d.getDate()).padStart(2, "0");
  const mon = months[d.getMonth()]!;
  const yyyy = d.getFullYear();
  return `${dd}${mon}${yyyy}`;
}

async function bseFetch(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json,text/csv,text/plain,*/*",
        Referer: BSE_BULK_PAGE,
        Origin: "https://www.bseindia.com",
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

type BseApiRow = Record<string, unknown>;

function rowFromBseApi(
  raw: BseApiRow,
  dealType: DealType,
  fetchedAt: string,
): BulkDealRow | null {
  const symbol = safeStr(
    raw.scrip_cd ?? raw.ScripCode ?? raw.scripcode ?? raw.symbol,
  ).toUpperCase();
  const securityName = safeStr(
    raw.scrip_name ?? raw.ScripName ?? raw.securityName ?? raw.security_name,
  );
  const client = safeStr(raw.client_name ?? raw.ClientName ?? raw.clientName);
  if (!client && !symbol) return null;

  const dealDate = normalizeTradeDate(
    safeStr(raw.deal_date ?? raw.DealDate ?? raw.date ?? raw.trade_date),
  );
  const sideRaw = safeStr(
    raw.deal_type ?? raw.DealType ?? raw.buy_sell ?? raw.type,
  );

  return {
    trade_date: dealDate,
    symbol: symbol || securityName.split(" ")[0] || "—",
    security_name: securityName,
    client_name: client,
    side: normalizeSide(sideRaw),
    quantity: parseNum(raw.quantity ?? raw.Quantity ?? raw.qty),
    price: parseNum(raw.price ?? raw.Price ?? raw.avg_price),
    deal_type: dealType,
    exchange: "BSE",
    fetched_at: fetchedAt,
  };
}

/** Today's bulk + block deals from BSE JSON API. */
export async function fetchBseDealSnapshot(): Promise<BulkDealRow[]> {
  const fetchedAt = new Date().toISOString();
  const out: BulkDealRow[] = [];

  for (const [url, dealType] of [
    [BSE_API_BULK, "bulk"],
    [BSE_API_BLOCK, "block"],
  ] as const) {
    try {
      const res = await bseFetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      if (text.trim().startsWith("<")) continue; // HTML block / WAF
      const json = JSON.parse(text) as unknown;
      const arr = Array.isArray(json)
        ? json
        : ((json as { Table?: unknown[] }).Table ??
          (json as { table?: unknown[] }).table ??
          []);
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (item && typeof item === "object") {
          const row = rowFromBseApi(
            item as BseApiRow,
            dealType,
            fetchedAt,
          );
          if (row?.client_name) out.push(row);
        }
      }
    } catch (e) {
      console.warn(`[bse-deals] snapshot ${dealType} failed:`, e);
    }
  }
  return out;
}

/** Parse BSE bulk CSV (archive download format). */
export function parseBseBulkCsv(
  csv: string,
  dealType: DealType,
  fetchedAt: string,
): BulkDealRow[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const out: BulkDealRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((c) => c.replace(/"/g, "").trim());
    if (cols.length < 6) continue;
    const symbol = (cols[1] || cols[0] || "").toUpperCase();
    const securityName = cols[2] || "";
    const client = cols[3] || "";
    if (!client) continue;
    out.push({
      trade_date: normalizeTradeDate(cols[0] || ""),
      symbol: symbol || securityName.slice(0, 12),
      security_name: securityName,
      client_name: client,
      side: normalizeSide(cols[4] || ""),
      quantity: parseNum(cols[5]),
      price: parseNum(cols[6]),
      deal_type: dealType,
      exchange: "BSE",
      fetched_at: fetchedAt,
    });
  }
  return out;
}

async function fetchBseCsvArchive(
  date: Date,
  kind: "Bulk" | "Block",
): Promise<BulkDealRow[]> {
  const fetchedAt = new Date().toISOString();
  const stamp = formatBseCsvDate(date);
  const urls = [
    `https://www.bseindia.com/markets/downloads/${kind}_${stamp}.csv`,
    `https://www.bseindia.com/download/BulknBlock/${kind}_${stamp}.csv`,
    `http://www.bseindia.com/markets/downloads/${kind}_${stamp}.csv`,
  ];
  for (const url of urls) {
    try {
      const res = await bseFetch(url);
      if (!res.ok) continue;
      let text = await res.text();
      if (text.trim().startsWith("<") || text.length < 40) continue;
      text = text
        .replace(/,,/g, ",")
        .replace(/,LTD/g, "LTD")
        .replace(/, LTD/g, " LTD");
      const rows = parseBseBulkCsv(
        text,
        kind === "Bulk" ? "bulk" : "block",
        fetchedAt,
      );
      if (rows.length) return rows;
    } catch {
      continue;
    }
  }
  return [];
}

/** Walk back calendar days and pull BSE CSV archives (skips weekends silently). */
export async function fetchBseDealsLastDays(days = 30): Promise<BulkDealRow[]> {
  const out: BulkDealRow[] = [];
  const end = new Date();

  for (let i = 0; i < Math.max(1, days); i++) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;

    const [bulk, block] = await Promise.all([
      fetchBseCsvArchive(d, "Bulk"),
      fetchBseCsvArchive(d, "Block"),
    ]);
    out.push(...bulk, ...block);
    // Gentle pacing — BSE rate-limits aggressive scrapers
    if (i > 0 && i % 5 === 0) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  try {
    out.push(...(await fetchBseDealSnapshot()));
  } catch {
    /* ignore */
  }

  return dedupeDeals(out);
}
