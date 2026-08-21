/**
 * Trendlyne superstar portfolio scrape (fast path).
 * Trendlyne stockrow HTML parser.
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const PORTFOLIO_URL =
  "https://trendlyne.com/portfolio/superstar-shareholders/{id}/latest/{slug}/";
const SEARCH_URL =
  "https://trendlyne.com/portfolio/superstar-shareholders/custom/?query={query}";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "superstar_holdings.db");
const ABOUT_PATH = path.join(DATA_DIR, "company_about.db");

export type FundSource = {
  label: string;
  portfolio_id?: string | null;
  portfolio_slug?: string | null;
  query?: string | null;
};

export type InvestorSource = {
  name: string;
  short?: string;
  portfolio_id?: string | null;
  portfolio_slug?: string | null;
  query?: string | null;
  funds?: FundSource[];
};

export type ParsedHolding = {
  company_name: string;
  holder_name: string;
  price: number | null;
  quantity: number | null;
  holding_percent: number | null;
  change_qtr: number | null;
  change_type: string;
  holding_value_cr: number;
  holding_entity?: string;
};

export type ResolvedHolding = ParsedHolding & {
  symbol: string;
  exchange: string;
  screener_slug: string | null;
  sector: string | null;
  sub_sector: string | null;
  industry: string | null;
};

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(
      /\b(limited|ltd|private|pvt|plc|inc|corp|corporation|company|co)\b\.?/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function stripTags(html: string): string {
  return unescapeHtml(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parsePercent(value: string): number | null {
  const n = Number(String(value).replace(/%/g, "").replace(/\+/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function parseChange(value: string): { num: number | null; type: string } {
  const raw = stripTags(value);
  if (!raw) return { num: null, type: "unchanged" };
  if (raw.toUpperCase() === "NEW") return { num: null, type: "new" };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { num: null, type: "unchanged" };
  if (n > 0) return { num: n, type: "increased" };
  if (n < 0) return { num: n, type: "decreased" };
  return { num: 0, type: "unchanged" };
}

function parseValueCr(value: string): number {
  const raw = stripTags(value).toLowerCase().replace(/,/g, "");
  if (!raw) return 0;
  let m = raw.match(/([\d.]+)\s*cr/);
  if (m) return Number(m[1]) || 0;
  m = raw.match(/([\d.]+)\s*lac/);
  if (m) return (Number(m[1]) || 0) / 100;
  m = raw.match(/([\d.]+)\s*k/);
  if (m) return (Number(m[1]) || 0) / 100_000;
  const n = Number(raw);
  return Number.isFinite(n) ? n / 1e7 : 0;
}

function parseQty(value: string): number | null {
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parsePrice(value: string): number | null {
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function iterStockrowTrs(html: string): string[] {
  const out: string[] = [];
  const lower = html.toLowerCase();
  let start = 0;
  while (true) {
    const idx = lower.indexOf("stockrow", start);
    if (idx < 0) break;
    const trStart = lower.lastIndexOf("<tr", idx);
    const trEnd = lower.indexOf("</tr>", idx);
    if (trStart < 0 || trEnd < 0) {
      start = idx + 8;
      continue;
    }
    out.push(html.slice(trStart, trEnd + 5));
    start = trEnd + 5;
  }
  return out;
}

function cellsFromTr(trHtml: string): string[] {
  const cells: string[] = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trHtml)) !== null) {
    cells.push(stripTags(m[1]));
  }
  while (cells.length && !cells[0]) cells.shift();
  return cells;
}

function companyFromTr(trHtml: string): string {
  const title = trHtml.match(/title="([^"]+?)\s+Share Price"/i);
  if (title) return unescapeHtml(title[1].trim());
  const anchor = trHtml.match(
    /<a[^>]*class="[^"]*stockrow[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
  );
  if (anchor) return stripTags(anchor[1]);
  return "";
}

function detectLayout(cells: string[]): "portfolio" | "search" {
  if (cells.length >= 10) return "portfolio";
  if (cells.length >= 7) {
    if (
      parsePrice(cells[2]) != null &&
      parseQty(cells[3]) != null &&
      cells.length <= 9
    ) {
      return "search";
    }
    if (cells[1].toLowerCase().includes("cr")) return "portfolio";
  }
  if (cells.length >= 4 && cells[1].toLowerCase().includes("cr")) {
    return "portfolio";
  }
  return "search";
}

function rowFromPortfolio(
  cells: string[],
  holderName: string,
): ParsedHolding | null {
  if (cells.length < 5 || !cells[0]) return null;
  const valueCr = parseValueCr(cells[1]);
  const qty = parseQty(cells[2]);
  const change = parseChange(cells[3].replace(/%/g, ""));
  let holdingPct: number | null = null;
  for (const cell of cells.slice(4)) {
    if (cell && cell !== "-" && cell.includes("%")) {
      holdingPct = parsePercent(cell);
      break;
    }
  }
  let price: number | null = null;
  if (qty && valueCr) price = (valueCr * 1e7) / qty;
  return {
    company_name: cells[0],
    holder_name: holderName,
    price,
    quantity: qty,
    holding_percent: holdingPct,
    change_qtr: change.num,
    change_type: change.type,
    holding_value_cr: valueCr,
  };
}

function rowFromSearch(
  cells: string[],
  holderName: string,
): ParsedHolding | null {
  if (cells.length < 7 || !cells[0]) return null;
  const change = parseChange(cells[5]);
  return {
    company_name: cells[0],
    holder_name: cells[1] || holderName,
    price: parsePrice(cells[2]),
    quantity: parseQty(cells[3]),
    holding_percent: parsePercent(cells[4]),
    change_qtr: change.num,
    change_type: change.type,
    holding_value_cr: parseValueCr(cells[6]),
  };
}

export function parseTrendlyneHtml(
  html: string,
  holderName: string,
): ParsedHolding[] {
  if (html.includes("No Results Found") && !html.includes("publicly holds")) {
    return [];
  }
  const byCompany = new Map<string, ParsedHolding>();
  for (const tr of iterStockrowTrs(html)) {
    const cells = cellsFromTr(tr);
    const company = companyFromTr(tr);
    if (company) {
      if (cells.length) cells[0] = company;
      else cells.push(company);
    }
    if (!cells.length) continue;
    const layout = detectLayout(cells);
    const row =
      layout === "search"
        ? rowFromSearch(cells, holderName)
        : rowFromPortfolio(cells, holderName);
    if (!row) continue;
    const key = normName(row.company_name);
    const prev = byCompany.get(key);
    if (!prev || row.holding_value_cr >= prev.holding_value_cr) {
      byCompany.set(key, row);
    }
  }
  return [...byCompany.values()];
}

async function fetchHtml(url: string, timeoutMs = 20_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchSourceHoldings(
  source: {
    label: string;
    portfolio_id?: string | null;
    portfolio_slug?: string | null;
    query?: string | null;
  },
  holderName: string,
): Promise<ParsedHolding[]> {
  let url: string;
  if (source.portfolio_id) {
    url = PORTFOLIO_URL.replace("{id}", source.portfolio_id).replace(
      "{slug}",
      source.portfolio_slug || "portfolio",
    );
  } else if (source.query) {
    url = SEARCH_URL.replace("{query}", encodeURIComponent(source.query));
  } else {
    return [];
  }
  const html = await fetchHtml(url);
  const rows = parseTrendlyneHtml(html, holderName);
  return rows.map((r) => ({
    ...r,
    holding_entity: source.label,
  }));
}

function mergeByCompany(rows: ParsedHolding[]): ParsedHolding[] {
  const by = new Map<string, ParsedHolding & { _entities: Set<string> }>();
  const rank: Record<string, number> = {
    new: 3,
    increased: 2,
    decreased: 1,
    unchanged: 0,
  };
  for (const row of rows) {
    const key = normName(row.company_name);
    if (!key) continue;
    const entity = row.holding_entity || row.holder_name || "Personal";
    const prev = by.get(key);
    if (!prev) {
      by.set(key, { ...row, holding_entity: entity, _entities: new Set([entity]) });
      continue;
    }
    prev._entities.add(entity);
    if ((rank[row.change_type] ?? 0) > (rank[prev.change_type] ?? 0)) {
      prev.change_type = row.change_type;
      prev.change_qtr = row.change_qtr;
    }
    if (
      row.holding_percent != null &&
      (prev.holding_percent == null || row.holding_percent > prev.holding_percent)
    ) {
      prev.holding_percent = row.holding_percent;
    }
    // Prefer max value — Personal page often already includes fund/family stakes
    prev.holding_value_cr = Math.max(
      prev.holding_value_cr || 0,
      row.holding_value_cr || 0,
    );
    if (row.price != null) prev.price = row.price;
    if (row.quantity != null && (prev.quantity == null || row.quantity > prev.quantity)) {
      prev.quantity = row.quantity;
    }
    // Prefer longer / official company name (often has Ltd.)
    if (row.company_name.length > prev.company_name.length) {
      prev.company_name = row.company_name;
    }
  }
  return [...by.values()].map((r) => {
    const { _entities, ...rest } = r;
    const entities = [..._entities].sort((a, b) => {
      if (a === "Personal") return 1;
      if (b === "Personal") return -1;
      return a.localeCompare(b);
    });
    return {
      ...rest,
      holding_entity: entities.join(" · "),
    };
  });
}

/** Fast mode: portfolio_id pages only (skip slow search-query fund pages). */
export async function fetchInvestorHoldings(
  investor: InvestorSource,
  opts?: { includeFunds?: boolean; concurrency?: number },
): Promise<{ rows: ParsedHolding[]; sources: number; error?: string }> {
  const includeFunds = opts?.includeFunds ?? true;
  const sources: Array<{
    label: string;
    portfolio_id?: string | null;
    portfolio_slug?: string | null;
    query?: string | null;
  }> = [];

  if (investor.portfolio_id || investor.query) {
    sources.push({
      label: "Personal",
      portfolio_id: investor.portfolio_id,
      portfolio_slug: investor.portfolio_slug,
      query: investor.portfolio_id ? null : investor.query,
    });
  }
  if (includeFunds) {
    for (const f of investor.funds ?? []) {
      if (!f.portfolio_id && !f.query) continue;
      sources.push({
        label: f.label,
        portfolio_id: f.portfolio_id,
        portfolio_slug: f.portfolio_slug,
        query: f.portfolio_id ? null : f.query,
      });
    }
  }

  // When includeFunds=false, only portfolio_id pages (fast). Otherwise fetch
  // personal + associates (Equity Intelligence, spouse, sons, etc.).
  const toFetch = includeFunds
    ? sources
    : sources.filter((s) => Boolean(s.portfolio_id));
  const errors: string[] = [];
  const collected: ParsedHolding[] = [];

  const limit = Math.max(1, opts?.concurrency ?? 3);
  for (let i = 0; i < toFetch.length; i += limit) {
    const batch = toFetch.slice(i, i + limit);
    const results = await Promise.allSettled(
      batch.map((s) => fetchSourceHoldings(s, investor.name)),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") collected.push(...r.value);
      else {
        errors.push(
          `${batch[j].label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        );
      }
    }
  }

  const merged = mergeByCompany(collected);
  return {
    rows: merged,
    sources: toFetch.length,
    error: merged.length ? undefined : errors.join("; ") || "No holdings",
  };
}

type SymbolMeta = {
  symbol: string;
  exchange: string;
  screener_slug: string | null;
};

let symbolCache: Map<string, SymbolMeta> | null = null;
let aboutLookup: Map<string, SymbolMeta> | null = null;

function loadSymbolCache(): Map<string, SymbolMeta> {
  if (symbolCache) return symbolCache;
  symbolCache = new Map();
  if (!fs.existsSync(DB_PATH)) return symbolCache;
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT norm_name, symbol, exchange, screener_slug FROM superstar_symbol_cache`,
      )
      .all() as Array<{
      norm_name: string;
      symbol: string;
      exchange: string;
      screener_slug: string | null;
    }>;
    for (const r of rows) {
      if (!r.norm_name || !r.symbol) continue;
      symbolCache.set(r.norm_name, {
        symbol: r.symbol.toUpperCase(),
        exchange: r.exchange || "NSE",
        screener_slug: r.screener_slug,
      });
    }
  } catch {
    /* table may be missing */
  } finally {
    db.close();
  }
  return symbolCache;
}

function loadAboutLookup(): Map<string, SymbolMeta> {
  if (aboutLookup) return aboutLookup;
  aboutLookup = new Map();
  if (!fs.existsSync(ABOUT_PATH)) return aboutLookup;
  const db = new Database(ABOUT_PATH, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(`SELECT ticker, name, market FROM company_about`)
      .all() as Array<{ ticker: string; name: string | null; market: string | null }>;
    for (const r of rows) {
      const ticker = (r.ticker || "").toUpperCase();
      if (!ticker) continue;
      const meta: SymbolMeta = {
        symbol: ticker,
        exchange: (r.market || "NSE").includes("BSE") ? "BSE" : "NSE",
        screener_slug: null,
      };
      aboutLookup.set(normName(ticker), meta);
      if (r.name) aboutLookup.set(normName(r.name), meta);
      // strip Ltd/Limited for looser match
      if (r.name) {
        const short = normName(
          r.name.replace(/\b(limited|ltd|llp|pvt|private)\b/gi, ""),
        );
        if (short && !aboutLookup.has(short)) aboutLookup.set(short, meta);
      }
    }
  } finally {
    db.close();
  }
  return aboutLookup;
}

function resolveSymbol(companyName: string): SymbolMeta {
  const key = normName(companyName);
  const ALIASES: Record<string, SymbolMeta> = {
    // BSE-only — not in NSE company_about universe
    "m m rubber": {
      symbol: "MMRUBBR-B",
      exchange: "BSE",
      screener_slug: "MMRUBBR-B",
    },
  };
  if (ALIASES[key]) return ALIASES[key];

  const cached = loadSymbolCache().get(key);
  if (cached?.symbol) return cached;
  const about = loadAboutLookup().get(key);
  if (about?.symbol) return about;

  const candidates = new Set<string>();
  if (key) candidates.add(key);
  const short = normName(
    companyName.replace(
      /\b(limited|ltd|industries|industrial|corporation|corp|india)\b/gi,
      "",
    ),
  );
  if (short) candidates.add(short);

  // singular/plural last-token variants (lining ↔ linings)
  for (const c of [...candidates]) {
    const parts = c.split(" ");
    const last = parts[parts.length - 1];
    if (!last || last.length < 4) continue;
    if (last.endsWith("s")) {
      candidates.add([...parts.slice(0, -1), last.slice(0, -1)].join(" "));
    } else {
      candidates.add([...parts.slice(0, -1), `${last}s`].join(" "));
    }
  }

  for (const cand of candidates) {
    if (ALIASES[cand]) return ALIASES[cand];
    const hit = loadSymbolCache().get(cand) || loadAboutLookup().get(cand);
    if (hit?.symbol) return hit;
  }
  return { symbol: "", exchange: "NSE", screener_slug: null };
}

export function resolveHoldings(rows: ParsedHolding[]): ResolvedHolding[] {
  const classLookup = sectorLookup();
  const resolved = rows.map((r) => {
    const meta = resolveSymbol(r.company_name);
    const sector = meta.symbol
      ? classLookup.get(meta.symbol.toUpperCase())
      : null;
    return {
      ...r,
      symbol: meta.symbol,
      exchange: meta.exchange || "NSE",
      screener_slug: meta.screener_slug,
      sector: sector?.sector ?? null,
      sub_sector: sector?.sub_sector ?? null,
      industry: sector?.industry ?? null,
    };
  });

  // Collapse rows that resolve to the same ticker (e.g. "Geojit Fin Serv" vs Ltd.)
  const bySym = new Map<string, ResolvedHolding & { _entities: Set<string> }>();
  for (const r of resolved) {
    const sym = (r.symbol || "").toUpperCase();
    if (!sym) continue;
    const key = `${sym}|${(r.exchange || "NSE").toUpperCase()}`;
    const entity = r.holding_entity || "Personal";
    const prev = bySym.get(key);
    if (!prev) {
      bySym.set(key, {
        ...r,
        symbol: sym,
        _entities: new Set(entity.split(" · ").map((s) => s.trim()).filter(Boolean)),
      });
      continue;
    }
    for (const e of entity.split(" · ")) {
      if (e.trim()) prev._entities.add(e.trim());
    }
    if (
      r.holding_percent != null &&
      (prev.holding_percent == null || r.holding_percent > prev.holding_percent)
    ) {
      prev.holding_percent = r.holding_percent;
    }
    prev.holding_value_cr = Math.max(
      prev.holding_value_cr || 0,
      r.holding_value_cr || 0,
    );
    if (r.company_name.length > prev.company_name.length) {
      prev.company_name = r.company_name;
    }
  }

  return [...bySym.values()].map((r) => {
    const { _entities, ...rest } = r;
    const entities = [..._entities].sort((a, b) => {
      if (a === "Personal") return 1;
      if (b === "Personal") return -1;
      return a.localeCompare(b);
    });
    return { ...rest, holding_entity: entities.join(" · ") };
  });
}

function sectorLookup(): Map<
  string,
  { sector: string | null; sub_sector: string | null; industry: string | null }
> {
  const map = new Map<
    string,
    { sector: string | null; sub_sector: string | null; industry: string | null }
  >();
  const classPath = path.join(DATA_DIR, "classifications.db");
  if (!fs.existsSync(classPath)) return map;
  const db = new Database(classPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(`SELECT ticker, sector, sub_sector, industry FROM classifications`)
      .all() as Array<{
      ticker: string;
      sector: string | null;
      sub_sector: string | null;
      industry: string | null;
    }>;
    for (const r of rows) {
      map.set((r.ticker || "").toUpperCase(), {
        sector: r.sector,
        sub_sector: r.sub_sector,
        industry: r.industry,
      });
    }
  } finally {
    db.close();
  }
  return map;
}

export function invalidateResolverCaches(): void {
  symbolCache = null;
  aboutLookup = null;
}
