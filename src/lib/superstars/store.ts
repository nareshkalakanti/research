import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { researchLinks } from "@/lib/links";
import {
  CURATED_NAMES,
  SUPERSTAR_INVESTORS,
  shortName,
} from "./catalog";
import { mergeAllDisclosedRaw } from "./disclosed";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "superstar_holdings.db");
const CLASS_PATH = path.join(DATA_DIR, "classifications.db");
const ABOUT_PATH = path.join(DATA_DIR, "company_about.db");

export type HoldingRow = {
  investor: string;
  investor_short: string;
  symbol: string;
  exchange: string;
  company_name: string | null;
  holding_percent: number | null;
  change_qtr: number | null;
  change_type: string | null;
  holding_value_cr: number | null;
  price: number | null;
  sector: string | null;
  sub_sector: string | null;
  industry: string | null;
  holding_entity: string | null;
  fetched_at: string | null;
  web: string | null;
  sc: string;
  tv: string;
};

export type InvestorSummary = {
  name: string;
  short: string;
  curated: boolean;
  holdings: number;
  new_picks: number;
  increased: number;
  decreased: number;
};

export type ActivityPart = {
  investor: string;
  investor_short: string;
  change_type: string;
  change_qtr: number | null;
  label: string;
};

export type ConsensusRow = {
  symbol: string;
  company_name: string | null;
  exchange: string;
  sector: string | null;
  price: number | null;
  /** Max holding % among consensus investors (for display/filter). */
  holding_percent: number | null;
  investor_count: number;
  new_count: number;
  increased_count: number;
  investors: string[];
  investor_shorts: string[];
  activity: string;
  activity_parts: ActivityPart[];
  combined_value_cr: number | null;
  web: string | null;
  sc: string;
  tv: string;
};

export type SuperstarsStats = {
  total_holdings: number;
  unique_symbols: number;
  investors: number;
  curated_investors: number;
  new_picks: number;
  increased: number;
  decreased: number;
  consensus: number;
  fetched_at: string | null;
};

type RawRow = {
  investor: string;
  symbol: string;
  exchange: string;
  company_name: string | null;
  holding_percent: number | null;
  change_qtr: number | null;
  change_type: string | null;
  holding_value_cr: number | null;
  price: number | null;
  sector: string | null;
  sub_sector: string | null;
  industry: string | null;
  holding_entity: string | null;
  fetched_at: string | null;
};

function openDb(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

function sectorLookup(): Map<
  string,
  { sector: string | null; sub_sector: string | null }
> {
  const map = new Map<string, { sector: string | null; sub_sector: string | null }>();
  if (!fs.existsSync(CLASS_PATH)) return map;
  const db = new Database(CLASS_PATH, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(`SELECT ticker, sector, sub_sector FROM classifications`)
      .all() as Array<{
      ticker: string;
      sector: string | null;
      sub_sector: string | null;
    }>;
    for (const r of rows) {
      const key = (r.ticker ?? "").toUpperCase();
      if (!key) continue;
      map.set(key, { sector: r.sector, sub_sector: r.sub_sector });
    }
  } finally {
    db.close();
  }
  return map;
}

function enrichSector(
  r: RawRow,
  lookup: Map<string, { sector: string | null; sub_sector: string | null }>,
): RawRow {
  if (r.sector && r.sector.trim() && r.sector !== "—") return r;
  const hit = lookup.get(r.symbol.toUpperCase());
  if (!hit) return r;
  return {
    ...r,
    sector: hit.sector ?? r.sector,
    sub_sector: hit.sub_sector ?? r.sub_sector,
  };
}

function marketFromExchange(exchange: string | null): string {
  const e = (exchange ?? "").trim().toUpperCase();
  if (e === "BSE SME") return "BSE SME";
  if (e === "BSE") return "BSE";
  if (e.includes("SME")) return "NSE SME";
  return "NSE";
}

function websiteLookup(): Map<string, string | null> {
  const map = new Map<string, string | null>();
  if (!fs.existsSync(ABOUT_PATH)) return map;
  const db = new Database(ABOUT_PATH, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(`SELECT ticker, website FROM company_about`)
      .all() as Array<{ ticker: string; website: string | null }>;
    for (const r of rows) {
      const key = (r.ticker ?? "").toUpperCase();
      if (!key) continue;
      map.set(key, r.website);
    }
  } finally {
    db.close();
  }
  return map;
}

function changeBadge(changeType: string | null, changeQtr: number | null): string {
  const ct = (changeType ?? "").toLowerCase();
  if (ct === "new") return "NEW";
  if (ct === "disclosed") return "DISCLOSED";
  if (ct === "increased") {
    if (changeQtr != null && Number.isFinite(changeQtr)) {
      return `↑${changeQtr >= 0 ? "+" : ""}${changeQtr.toFixed(2)}%`;
    }
    return "↑";
  }
  if (ct === "decreased") {
    if (changeQtr != null && Number.isFinite(changeQtr)) {
      return `↓${changeQtr.toFixed(2)}%`;
    }
    return "↓";
  }
  return "";
}

function mapHolding(
  r: RawRow,
  websites: Map<string, string | null>,
): HoldingRow {
  const links = researchLinks(
    r.symbol,
    marketFromExchange(r.exchange),
    websites.get(r.symbol.toUpperCase()) ?? null,
  );
  return {
    investor: r.investor,
    investor_short: shortName(r.investor),
    symbol: r.symbol,
    exchange: r.exchange || "NSE",
    company_name: r.company_name,
    holding_percent: r.holding_percent,
    change_qtr: r.change_qtr,
    change_type: r.change_type,
    holding_value_cr: r.holding_value_cr,
    price: r.price,
    sector: r.sector,
    sub_sector: r.sub_sector,
    industry: r.industry,
    holding_entity: r.holding_entity,
    fetched_at: r.fetched_at,
    web: links.web,
    sc: links.sc,
    tv: links.tv,
  };
}

function loadRaw(): RawRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    const raw = db
      .prepare(
        `SELECT investor, symbol, exchange, company_name, holding_percent,
                change_qtr, change_type, holding_value_cr, price,
                sector, sub_sector, industry, holding_entity, fetched_at
         FROM superstar_holdings
         ORDER BY COALESCE(holding_value_cr, -1) DESC, COALESCE(holding_percent, -1) DESC`,
      )
      .all() as RawRow[];
    const lookup = sectorLookup();
    const enriched = raw.map((r) => enrichSector(r, lookup));
    return mergeAllDisclosedRaw(enriched) as RawRow[];
  } finally {
    db.close();
  }
}

export function loadAllHoldings(opts?: {
  investor?: string | null;
  curatedOnly?: boolean;
  change?: string | null;
  q?: string | null;
  sector?: string | null;
  minPct?: number | null;
  minValue?: number | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  limit?: number;
}): {
  holdings: HoldingRow[];
  stats: SuperstarsStats;
  investors: InvestorSummary[];
  sectors: string[];
} {
  const raw = loadRaw();
  if (!raw.length) {
    return { holdings: [], stats: emptyStats(), investors: [], sectors: [] };
  }

  const investorMap = new Map<string, InvestorSummary>();
  for (const r of raw) {
    let s = investorMap.get(r.investor);
    if (!s) {
      s = {
        name: r.investor,
        short: shortName(r.investor),
        curated: CURATED_NAMES.has(r.investor),
        holdings: 0,
        new_picks: 0,
        increased: 0,
        decreased: 0,
      };
      investorMap.set(r.investor, s);
    }
    s.holdings += 1;
    const ct = (r.change_type ?? "").toLowerCase();
    if (ct === "new") s.new_picks += 1;
    else if (ct === "disclosed") s.new_picks += 1;
    else if (ct === "increased") s.increased += 1;
    else if (ct === "decreased") s.decreased += 1;
  }

  const curatedOrder = new Map(SUPERSTAR_INVESTORS.map((i, idx) => [i.name, idx]));
  const investors = [...investorMap.values()].sort((a, b) => {
    const ai = curatedOrder.get(a.name);
    const bi = curatedOrder.get(b.name);
    if (ai != null && bi != null) return ai - bi;
    if (ai != null) return -1;
    if (bi != null) return 1;
    return b.holdings - a.holdings || a.name.localeCompare(b.name);
  });

  let filtered = raw;
  if (opts?.curatedOnly) {
    filtered = filtered.filter((r) => CURATED_NAMES.has(r.investor));
  }
  if (opts?.investor) {
    filtered = filtered.filter((r) => r.investor === opts.investor);
  }
  const change = (opts?.change ?? "").toLowerCase();
  if (change && change !== "all") {
    filtered = filtered.filter((r) => (r.change_type ?? "").toLowerCase() === change);
  }
  const q = (opts?.q ?? "").trim().toLowerCase();
  if (q) {
    filtered = filtered.filter((r) => {
      const hay = [r.symbol, r.company_name, r.investor, r.sector, r.industry]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  const sectors = [
    ...new Set(
      filtered
        .map((r) => (r.sector || "").trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const sector = (opts?.sector ?? "").trim();
  if (sector && sector.toLowerCase() !== "all") {
    filtered = filtered.filter(
      (r) => (r.sector || "").trim().toLowerCase() === sector.toLowerCase(),
    );
  }
  if (opts?.minPct != null && Number.isFinite(opts.minPct)) {
    filtered = filtered.filter(
      (r) => r.holding_percent != null && r.holding_percent >= opts.minPct!,
    );
  }
  if (opts?.minValue != null && Number.isFinite(opts.minValue)) {
    filtered = filtered.filter(
      (r) =>
        r.holding_value_cr != null && r.holding_value_cr >= opts.minValue!,
    );
  }
  if (opts?.minPrice != null && Number.isFinite(opts.minPrice)) {
    filtered = filtered.filter(
      (r) => r.price != null && r.price >= opts.minPrice!,
    );
  }
  if (opts?.maxPrice != null && Number.isFinite(opts.maxPrice)) {
    filtered = filtered.filter(
      (r) => r.price != null && r.price <= opts.maxPrice!,
    );
  }

  const limit = opts?.limit ?? 500;
  const websites = websiteLookup();
  const holdings = filtered.slice(0, limit).map((r) => mapHolding(r, websites));

  const curatedRaw = raw.filter((r) => CURATED_NAMES.has(r.investor));
  const consensus = buildConsensus(curatedRaw, 2, websites);
  const fetchedAt = raw.reduce<string | null>((best, r) => {
    if (!r.fetched_at) return best;
    if (!best || r.fetched_at > best) return r.fetched_at;
    return best;
  }, null);

  const stats: SuperstarsStats = {
    total_holdings: curatedRaw.length,
    unique_symbols: new Set(curatedRaw.map((r) => r.symbol.toUpperCase())).size,
    investors: investors.filter((i) => i.curated).length,
    curated_investors: SUPERSTAR_INVESTORS.length,
    new_picks: curatedRaw.filter((r) => {
      const ct = (r.change_type ?? "").toLowerCase();
      return ct === "new" || ct === "disclosed";
    }).length,
    increased: curatedRaw.filter(
      (r) => (r.change_type ?? "").toLowerCase() === "increased",
    ).length,
    decreased: curatedRaw.filter(
      (r) => (r.change_type ?? "").toLowerCase() === "decreased",
    ).length,
    consensus: consensus.length,
    fetched_at: fetchedAt,
  };

  return {
    holdings,
    stats,
    investors: investors.filter((i) => i.curated || i.holdings > 0),
    sectors,
  };
}

export function loadConsensus(opts?: {
  minInvestors?: number;
  curatedOnly?: boolean;
  q?: string | null;
  sector?: string | null;
  minPct?: number | null;
  minValue?: number | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  limit?: number;
}): {
  consensus: ConsensusRow[];
  stats: SuperstarsStats;
  investors: InvestorSummary[];
  sectors: string[];
} {
  const base = loadAllHoldings({ curatedOnly: opts?.curatedOnly ?? true, limit: 50_000 });
  const raw = loadRaw();
  const websites = websiteLookup();
  const scoped = (opts?.curatedOnly ?? true)
    ? raw.filter((r) => CURATED_NAMES.has(r.investor))
    : raw;
  let consensus = buildConsensus(scoped, opts?.minInvestors ?? 2, websites);

  const sectors = [
    ...new Set(
      consensus
        .map((r) => (r.sector || "").trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const q = (opts?.q ?? "").trim().toLowerCase();
  if (q) {
    consensus = consensus.filter((r) => {
      const hay = [
        r.symbol,
        r.company_name,
        r.sector,
        r.investors.join(" "),
        r.activity,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }
  const sector = (opts?.sector ?? "").trim();
  if (sector && sector.toLowerCase() !== "all") {
    consensus = consensus.filter(
      (r) => (r.sector || "").trim().toLowerCase() === sector.toLowerCase(),
    );
  }
  if (opts?.minPct != null && Number.isFinite(opts.minPct)) {
    consensus = consensus.filter(
      (r) =>
        r.holding_percent != null && r.holding_percent >= opts.minPct!,
    );
  }
  if (opts?.minValue != null && Number.isFinite(opts.minValue)) {
    consensus = consensus.filter(
      (r) =>
        r.combined_value_cr != null &&
        r.combined_value_cr >= opts.minValue!,
    );
  }
  if (opts?.minPrice != null && Number.isFinite(opts.minPrice)) {
    consensus = consensus.filter(
      (r) => r.price != null && r.price >= opts.minPrice!,
    );
  }
  if (opts?.maxPrice != null && Number.isFinite(opts.maxPrice)) {
    consensus = consensus.filter(
      (r) => r.price != null && r.price <= opts.maxPrice!,
    );
  }

  const limit = opts?.limit ?? 200;
  return {
    consensus: consensus.slice(0, limit),
    stats: { ...base.stats, consensus: consensus.length },
    investors: base.investors.filter((i) => i.curated),
    sectors,
  };
}

function buildConsensus(
  raw: RawRow[],
  minInvestors: number,
  websites: Map<string, string | null> = new Map(),
): ConsensusRow[] {
  const bySym = new Map<string, RawRow[]>();
  for (const r of raw) {
    const key = r.symbol.toUpperCase();
    if (!key) continue;
    const list = bySym.get(key) ?? [];
    list.push(r);
    bySym.set(key, list);
  }

  const rows: ConsensusRow[] = [];
  for (const [symbol, grp] of bySym) {
    const invSet = [...new Set(grp.map((r) => r.investor))].sort();
    if (invSet.length < minInvestors) continue;
    const first = grp[0];
    const activityParts: ActivityPart[] = [];
    for (const r of [...grp].sort((a, b) => a.investor.localeCompare(b.investor))) {
      const badge = changeBadge(r.change_type, r.change_qtr);
      const label = shortName(r.investor);
      activityParts.push({
        investor: r.investor,
        investor_short: label,
        change_type: (r.change_type ?? "unchanged").toLowerCase(),
        change_qtr: r.change_qtr,
        label: badge ? `${label} ${badge}` : label,
      });
    }
    const values = grp
      .map((r) => r.holding_value_cr)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const pcts = grp
      .map((r) => r.holding_percent)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const links = researchLinks(
      symbol,
      marketFromExchange(first.exchange),
      websites.get(symbol) ?? null,
    );
    rows.push({
      symbol,
      company_name: first.company_name,
      exchange: first.exchange || "NSE",
      sector: first.sector,
      price: first.price,
      holding_percent: pcts.length ? Math.max(...pcts) : null,
      investor_count: invSet.length,
      new_count: grp.filter((r) => (r.change_type ?? "").toLowerCase() === "new")
        .length,
      increased_count: grp.filter(
        (r) => (r.change_type ?? "").toLowerCase() === "increased",
      ).length,
      investors: invSet,
      investor_shorts: invSet.map(shortName),
      activity: activityParts.map((p) => p.label).join(" · "),
      activity_parts: activityParts,
      combined_value_cr: values.length
        ? Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100
        : null,
      web: links.web,
      sc: links.sc,
      tv: links.tv,
    });
  }

  rows.sort((a, b) => {
    if (b.investor_count !== a.investor_count) {
      return b.investor_count - a.investor_count;
    }
    if (b.new_count !== a.new_count) return b.new_count - a.new_count;
    if (b.increased_count !== a.increased_count) {
      return b.increased_count - a.increased_count;
    }
    return (b.combined_value_cr ?? 0) - (a.combined_value_cr ?? 0);
  });
  return rows;
}

function emptyStats(): SuperstarsStats {
  return {
    total_holdings: 0,
    unique_symbols: 0,
    investors: 0,
    curated_investors: SUPERSTAR_INVESTORS.length,
    new_picks: 0,
    increased: 0,
    decreased: 0,
    consensus: 0,
    fetched_at: null,
  };
}
