/**
 * Governance map data — multi-board directors from local governance.db,
 * enriched with metrics / about / BB·TQ.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { pickAboutText } from "./db";
import { holdingsTickerSet } from "./holdings";
import { edgeTickerSet } from "./edge";
import { fundTagsForTicker, fundChangesForTicker } from "./fund-watchlists";
import { researchLinks } from "./links";
import { loadMetricsMap } from "./metrics";
import { loadBreakoutMap } from "./signals";
import {
  mcapCapCode,
  mcapCapLabel,
  pledgedDirectorScore,
  scoreCompanyBoard,
  scoreDirectorSeats,
  type DirectorScore,
} from "./gov-score";
import {
  FUND_WATCHLIST_KEYS,
  type FundChangeInfo,
  type FundWatchlistKey,
} from "./fund-watchlist-meta";
import { isPlaceholderDirectorName } from "./gov-director-name";
import {
  groupFingerprint,
  loadAllFamilyLabels,
  scheduleFamilyGroupRefine,
} from "./family-group-refine";
import { applyFamilyGroupEdits, loadFamilyGroupEditMap } from "./family-group-edits";
import { closeGovernanceWriteDb, getGovernanceWriteDb } from "./governance-write";
import {
  DATA_DIR as SQLITE_DATA_DIR,
  isSqliteWalDamage,
  openSqliteNamed,
  removeWalSidecars,
} from "./sqlite-utils";

export type GovCompanySeat = {
  ticker: string;
  name: string;
  market: string;
  designation: string;
  category: string | null;
  source: string | null;
  as_of: string | null;
  market_cap_cr: number | null;
  price: number | null;
  cap_code: string | null;
  cap_label: string | null;
  website: string | null;
  about: string | null;
  /** About + products + end-markets + HQ — used for theme matching. */
  about_search: string;
  headquarters: string | null;
  sector: string | null;
  industry: string | null;
  is_sme: boolean;
  is_main: boolean;
  has_bb: boolean;
  has_bb_w: boolean;
  has_bb_m: boolean;
  has_tq: boolean;
  has_hold: boolean;
  has_edge: boolean;
  fund_tags: FundWatchlistKey[];
  fund_changes?: Partial<Record<FundWatchlistKey, FundChangeInfo>>;
  web: string | null;
  sc: string;
  tv: string;
};

export type GovernanceMapRow = {
  person_id: string;
  din: string | null;
  name: string;
  board_count: number;
  dir_score: number;
  din_backed: boolean;
  name_collision: boolean;
  nameless_din: boolean;
  big_n: number;
  small_n: number;
  tiny_n: number;
  ti_n: number;
  lc_n: number;
  bridge: boolean;
  tiny_bridge: boolean;
  ti_bridge: boolean;
  multi_lc: boolean;
  sme_n: number;
  main_n: number;
  sme_cross: boolean;
  tickers: string;
  companies: GovCompanySeat[];
  score_breakdown: DirectorScore;
  /** Theme-matched board count when a theme filter is active. */
  theme_matched?: number;
};

type SeatRow = {
  person_id: string;
  din: string | null;
  director_name: string;
  ticker: string;
  company_name: string;
  market: string;
  designation: string;
  category: string | null;
  source: string | null;
  as_of: string | null;
};

type AboutBits = {
  name: string | null;
  website: string | null;
  about: string | null;
  products: string | null;
  end_markets: string | null;
  headquarters: string | null;
  sector: string | null;
  industry: string | null;
};

function normalizedSurname(name: string): string {
  const bits = name
    .replace(/[().,]/g, " ")
    .split(/\s+/)
    .map((b) => b.trim())
    .filter(Boolean);
  return (bits[bits.length - 1] || "").toUpperCase();
}

function looksLikeControlRole(designation: string, category: string | null): boolean {
  const text = `${designation} ${category || ""}`.toLowerCase();
  return /founder|managing|whole[-\s]?time|joint managing|executive|chairman/.test(text);
}

export function companyHasFamilyPattern(companies: GovCompanySeat[]): boolean {
  const seats = companies.filter((c) => c.name.trim() && c.din !== "");
  if (!seats.length) return false;

  const surnameCounts = new Map<string, number>();

  for (const seat of seats) {
    const surname = normalizedSurname(seat.name);
    if (surname) surnameCounts.set(surname, (surnameCounts.get(surname) || 0) + 1);
  }

  return [...surnameCounts.values()].some((n) => n >= 2);
}

export function companyHasControlPattern(companies: GovCompanySeat[]): boolean {
  const seats = companies.filter((c) => c.name.trim() && c.din !== "");
  if (!seats.length) return false;

  let controlRoles = 0;
  let independentCount = 0;

  for (const seat of seats) {
    if (/independent/i.test(seat.designation || seat.category || "")) independentCount += 1;
    if (looksLikeControlRole(seat.designation, seat.category)) controlRoles += 1;
  }

  return (
    (controlRoles >= 3 && seats.length >= 4) ||
    (controlRoles >= 2 && independentCount >= 1 && seats.length >= 5)
  );
}

export function companyHasGovernancePattern(companies: GovCompanySeat[]): boolean {
  return companyHasFamilyPattern(companies) || companyHasControlPattern(companies);
}

export type GovFamilyCompany = {
  ticker: string;
  name: string;
  market: string;
  cap_code: string | null;
  market_cap_cr: number | null;
  is_sme: boolean;
  family_directors: number;
  /** Board seats on record. */
  directors: number;
  /** Seats whose director has a valid 8-digit DIN. */
  din_verified: number;
};

export type GovFamilyPerson = {
  person_id: string;
  name: string;
  din: string | null;
  /** Tickers this person sits on (group and outside). */
  tickers: string[];
  /** Same director score as People & boards. */
  dir_score: number;
};

export type GovFamilyOutside = {
  ticker: string;
  name: string;
  cap_code: string | null;
  market_cap_cr?: number | null;
};

export type GovFamilyGroup = {
  family_name: string;
  company_count: number;
  companies: GovFamilyCompany[];
  /** Stable id for user edits (auto membership fingerprint). */
  group_id?: string;
  /** Non-independent board people linking two or more boards. */
  people?: GovFamilyPerson[];
  /** Outside companies where those people also sit. */
  outside?: GovFamilyOutside[];
  /** Cap / name for every ticker on this map (group + outside). */
  listings?: GovFamilyOutside[];
};

const FAMILY_GRAPH_MAX_PEOPLE = 40;

function titleCaseSurname(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Legal / filler words — not a house name. */
const HOUSE_SKIP = new Set([
  "a",
  "an",
  "and",
  "asian",
  "bank",
  "bharat",
  "capital",
  "central",
  "co",
  "company",
  "corp",
  "corporation",
  "eastern",
  "energy",
  "enterprises",
  "enterprise",
  "finance",
  "financial",
  "for",
  "general",
  "global",
  "great",
  "group",
  "gujarat",
  "hindustan",
  "holding",
  "holdings",
  "inc",
  "india",
  "indian",
  "indo",
  "industries",
  "industry",
  "industrial",
  "international",
  "investment",
  "investments",
  "limited",
  "llp",
  "ltd",
  "maharashtra",
  "national",
  "northern",
  "of",
  "orient",
  "oriental",
  "plc",
  "power",
  "prime",
  "private",
  "products",
  "pvt",
  "royal",
  "services",
  "service",
  "shree",
  "shri",
  "southern",
  "sri",
  "state",
  "steel",
  "super",
  "tech",
  "the",
  "union",
  "united",
  "western",
]);

function companyNameTokens(name: string): string[] {
  return name
    .replace(/[().,'’/&-]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const ACRONYM_SKIP = new Set([
  "a",
  "an",
  "and",
  "for",
  "of",
  "the",
  "co",
  "company",
  "limited",
  "ltd",
  "pvt",
  "private",
  "plc",
  "llp",
  "inc",
]);

function nameAcronym(name: string): string {
  const parts = companyNameTokens(name).filter((t) => {
    const key = t.toLowerCase();
    return !ACRONYM_SKIP.has(key) && /^[a-z]/i.test(t);
  });
  if (parts.length < 2) return "";
  return parts.map((t) => t[0]!.toUpperCase()).join("");
}

function houseTokensFromName(name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of companyNameTokens(name)) {
    const key = token.toLowerCase();
    if (HOUSE_SKIP.has(key)) continue;
    if (!/^[a-z]{3,}$/i.test(token)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(titleCaseSurname(token));
  }
  if (!out.length) {
    const acr = nameAcronym(name);
    if (acr.length >= 3 && acr.length <= 6) out.push(titleCaseSurname(acr));
  }
  return out;
}

/** Keep distinct houses that share a surname ("Patel Group" ≠ "Patel Group of Companies"). */
function declaredMergeKey(groupName: string): string {
  let s = groupName.trim().toLowerCase();
  if (!s || s.length > 80) return "";
  if (/\b(limited|ltd|pvt|private|llc|plc|government|ministry|consortium)\b/.test(s)) {
    return "";
  }
  if (/\b(promoted|subsidiary|owned|late)\b/.test(s)) return "";
  if (/,/.test(s)) return "";
  s = s.replace(/[.,/&'’]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^(the|a|an)\s+/, "").trim();
  if (!s || HOUSE_SKIP.has(s)) return "";
  return s;
}

function declaredCore(key: string): string {
  return key
    .replace(/^(the|a|an)\s+/, "")
    .replace(/\s+groups?(?:\s+of\s+.+)?$/, "")
    .trim();
}

function displayGroupLabel(mergeKey: string): string {
  const small = new Set(["of", "and", "the", "for", "in", "de", "da"]);
  const words = mergeKey
    .split(" ")
    .filter(Boolean)
    .map((w) => {
      const low = w.toLowerCase();
      if (small.has(low)) return low;
      if (w.length <= 3) return w.toUpperCase();
      return titleCaseSurname(w);
    });
  if (words.length >= 2 && words[0]!.toLowerCase() === "group") {
    const rest = words.slice(1);
    if (!rest.some((w) => w.toLowerCase() === "group")) rest.push("Group");
    return rest.join(" ");
  }
  return words.join(" ");
}

function houseContentTokens(house: string): string[] {
  const extra = new Set(["group", "groups", "house", "houses"]);
  return house
    .toLowerCase()
    .split(/\s+/)
    .filter(
      (w) =>
        Boolean(w) &&
        !HOUSE_SKIP.has(w) &&
        !extra.has(w) &&
        /^[a-z]{1,}$/.test(w),
    );
}

function houseSurnameKey(house: string): string {
  const parts = houseContentTokens(house);
  if (!parts.length) {
    return (house.split(/\s+/).pop() || "").toUpperCase();
  }
  return parts[parts.length - 1]!.toUpperCase();
}

function houseLeadToken(house: string): string {
  const parts = houseContentTokens(house);
  const word = parts.find((w) => w.length >= 3) || parts[0] || "";
  return word.toUpperCase();
}

/** "Birla KK" and "KK Birla" are the same house title. */
function canonicalHouseLabel(name: string): string {
  return houseContentTokens(name)
    .map((w) => w.toLowerCase())
    .sort()
    .join(" ");
}

function isHouseControlSeat(designation: string, category: string | null): boolean {
  const text = `${designation} ${category || ""}`.toLowerCase();
  if (/nominee/.test(text)) return false;
  // Independent chairs/directors are not house control.
  if (/independent/.test(text) && !/non[-\s]?independent/.test(text)) {
    return false;
  }
  if (
    /promoter|chair|managing|whole[-\s]?time|founder|\bceo\b|\bcfo\b|chief financial|\bmd\b/.test(
      text,
    )
  ) {
    return true;
  }
  if (/non[-\s]?executive/.test(text)) return false;
  return /\bexecutive\b/.test(text);
}

/** Chair / promoter / founder — used to name a house, not every ED. */
function isHouseFamilySeat(designation: string, category: string | null): boolean {
  const text = `${designation} ${category || ""}`.toLowerCase();
  if (/nominee/.test(text)) return false;
  if (/independent/.test(text) && !/non[-\s]?independent/.test(text)) {
    return false;
  }
  return /promoter|founder|chair/.test(text);
}
function isHouseLinkSeat(designation: string, category: string | null): boolean {
  return (
    isHouseFamilySeat(designation, category) ||
    /promoter/.test(`${designation} ${category || ""}`.toLowerCase())
  );
}
function isHousePromoterSeat(designation: string, category: string | null): boolean {
  const text = `${designation} ${category || ""}`.toLowerCase();
  if (/nominee/.test(text)) return false;
  return !/independent/.test(text) || /non[-\s]?independent/.test(text);
}

let govDb: Database.Database | null = null;
let aboutDb: Database.Database | null = null;
let mapCache: { at: number; rows: GovernanceMapRow[] } | null = null;
let familyMapCache: { at: number; groups: GovFamilyGroup[] } | null = null;
let boardScoreCache: { at: number; map: Map<string, number> } | null = null;
const CACHE_MS = 60_000;

function closeGovReader(): void {
  try {
    govDb?.close();
  } catch {
    /* ignore */
  }
  govDb = null;
}

function healGovernanceWal(): void {
  closeGovReader();
  closeGovernanceWriteDb();
  removeWalSidecars(path.join(SQLITE_DATA_DIR, "governance.db"));
}

function openReadonly(name: string): Database.Database {
  return openSqliteNamed(name, {
    readonly: true,
    fileMustExist: true,
    busyTimeoutMs: 8_000,
  });
}

function getGov(): Database.Database {
  if (govDb) return govDb;
  try {
    govDb = openReadonly("governance.db");
    return govDb;
  } catch (err) {
    if (!isSqliteWalDamage(err)) throw err;
    healGovernanceWal();
    govDb = openReadonly("governance.db");
    return govDb;
  }
}

function getAbout(): Database.Database | null {
  if (aboutDb) return aboutDb;
  try {
    aboutDb = openReadonly("company_about.db");
    // Probe so a corrupt WAL fails here, not mid-request.
    aboutDb.prepare("SELECT 1 FROM company_about LIMIT 1").get();
    return aboutDb;
  } catch {
    try {
      aboutDb?.close();
    } catch {
      /* ignore */
    }
    aboutDb = null;
    return null;
  }
}

const SEAT_SELECT = `
      SELECT
        d.person_id,
        d.din,
        d.name AS director_name,
        s.ticker,
        c.name AS company_name,
        c.market,
        s.designation,
        s.category,
        s.source,
        s.as_of
      FROM directors d
      JOIN board_seats s ON s.person_id = d.person_id
      JOIN companies c ON c.ticker = s.ticker
      WHERE UPPER(c.market) IN ('NSE', 'NSE SME', 'BSE', 'BSE SME')`;

function loadAllBoardSeats(): SeatRow[] {
  if (!fs.existsSync(path.join(SQLITE_DATA_DIR, "governance.db"))) return [];
  const run = () =>
    getGov()
      .prepare(
        `
      ${SEAT_SELECT}
      ORDER BY c.name COLLATE NOCASE, d.name COLLATE NOCASE
      `,
      )
      .all() as SeatRow[];
  try {
    return run();
  } catch (err) {
    if (!isSqliteWalDamage(err)) throw err;
    healGovernanceWal();
    return run();
  }
}

function loadAboutBlobByTicker(): Map<string, string> {
  const about = getAbout();
  if (!about) return new Map();
  const rows = about
    .prepare(
      `SELECT ticker,
              COALESCE(group_name, '') AS group_name,
              COALESCE(about, '') AS about,
              COALESCE(yf_about, '') AS yf_about
       FROM company_about`,
    )
    .all() as Array<{
    ticker: string;
    group_name: string;
    about: string;
    yf_about: string;
  }>;
  const map = new Map<string, string>();
  for (const row of rows) {
    const ticker = (row.ticker || "").toUpperCase();
    if (!ticker) continue;
    map.set(ticker, `${row.group_name}\n${row.about}\n${row.yf_about}`);
  }
  return map;
}

function loadGroupNameByTicker(): Map<string, string> {
  const about = getAbout();
  if (!about) return new Map();
  const rows = about
    .prepare(
      `SELECT ticker, group_name FROM company_about
       WHERE TRIM(COALESCE(group_name, '')) != ''`,
    )
    .all() as Array<{ ticker: string; group_name: string }>;
  const map = new Map<string, string>();
  for (const row of rows) {
    const ticker = (row.ticker || "").toUpperCase();
    if (ticker) map.set(ticker, row.group_name);
  }
  return map;
}

function stocksAiDataDirCandidates(): string[] {
  const home = process.env.HOME || "";
  const extra = (process.env.STOCKS_AI_DATA || "").trim();
  return [
    extra,
    path.join(process.cwd(), "..", "stocks-ai", "data"),
    path.join(home, "Development", "stocks-ai", "data"),
    path.join(home, "Development", "ai.com", "stocks-ai", "data"),
  ].filter(Boolean);
}

function stocksAiDbPaths(): string[] {
  return stocksAiDataDirCandidates().map((dir) => path.join(dir, "stocks_ai.db"));
}

function stocksAiSeedPaths(): string[] {
  return stocksAiDataDirCandidates().map((dir) =>
    path.join(dir, "business_groups_seed.json"),
  );
}

type StocksAiGroupData = {
  groups: Array<{ name: string; tickers: string[] }>;
  /** Demerger parent → spin-off ticker pairs. */
  pairs: Array<{ parent: string; child: string }>;
};

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name),
  );
}

function readStocksAiGroups(db: Database.Database): StocksAiGroupData {
  const out: StocksAiGroupData = { groups: [], pairs: [] };

  if (hasTable(db, "business_groups") && hasTable(db, "business_group_members")) {
    const rows = db
      .prepare(
        `SELECT g.name AS group_name, UPPER(m.ticker) AS ticker
         FROM business_groups g
         JOIN business_group_members m ON m.group_id = g.id
         WHERE TRIM(COALESCE(m.ticker, '')) != ''`,
      )
      .all() as Array<{ group_name: string; ticker: string }>;
    const byName = new Map<string, Set<string>>();
    for (const row of rows) {
      const name = (row.group_name || "").trim();
      if (!name || !row.ticker) continue;
      const set = byName.get(name) ?? new Set<string>();
      set.add(row.ticker);
      byName.set(name, set);
    }
    for (const [name, set] of byName) {
      if (set.size >= 2) out.groups.push({ name, tickers: [...set] });
    }
  }

  const seen = new Set<string>();
  const addPair = (parent: string, child: string) => {
    const p = parent.trim().toUpperCase();
    const c = child.trim().toUpperCase();
    if (!p || !c || p === c) return;
    const key = `${p}>${c}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.pairs.push({ parent: p, child: c });
  };

  if (hasTable(db, "demerger_stocks")) {
    const rows = db
      .prepare(
        `SELECT ticker, role, peer_ticker FROM demerger_stocks
         WHERE TRIM(COALESCE(peer_ticker, '')) != ''`,
      )
      .all() as Array<{ ticker: string; role: string; peer_ticker: string }>;
    for (const row of rows) {
      const role = (row.role || "").toLowerCase();
      if (role.startsWith("parent")) addPair(row.ticker, row.peer_ticker);
      else if (role.startsWith("spin")) addPair(row.peer_ticker, row.ticker);
    }
  }
  for (const [table, childCol, parentCol] of [
    ["spinoffs", "ticker", "parent_ticker"],
    ["parents", "demerged_ticker", "ticker"],
  ] as const) {
    if (!hasTable(db, table)) continue;
    const rows = db
      .prepare(
        `SELECT ${parentCol} AS parent, ${childCol} AS child FROM ${table}
         WHERE TRIM(COALESCE(${parentCol}, '')) != ''
           AND TRIM(COALESCE(${childCol}, '')) != ''`,
      )
      .all() as Array<{ parent: string; child: string }>;
    for (const row of rows) addPair(row.parent, row.child);
  }

  return out;
}

function mergeStocksAiGroupData(
  into: StocksAiGroupData,
  extra: StocksAiGroupData,
): StocksAiGroupData {
  const byName = new Map<string, Set<string>>();
  for (const g of [...into.groups, ...extra.groups]) {
    const name = (g.name || "").trim();
    if (!name) continue;
    const set = byName.get(name) ?? new Set<string>();
    for (const t of g.tickers) {
      const ticker = (t || "").trim().toUpperCase();
      if (ticker) set.add(ticker);
    }
    byName.set(name, set);
  }
  const pairSeen = new Set(
    into.pairs.map((p) => `${p.parent}>${p.child}`),
  );
  const pairs = [...into.pairs];
  for (const p of extra.pairs) {
    const key = `${p.parent}>${p.child}`;
    if (pairSeen.has(key)) continue;
    pairSeen.add(key);
    pairs.push(p);
  }
  return {
    groups: [...byName.entries()].map(([name, set]) => ({
      name,
      tickers: [...set],
    })),
    pairs,
  };
}

function readStocksAiSeedFile(file: string): StocksAiGroupData {
  const out: StocksAiGroupData = { groups: [], pairs: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return out;
  }
  const groups = Array.isArray((raw as { groups?: unknown }).groups)
    ? ((raw as { groups: unknown[] }).groups)
    : [];
  for (const row of groups) {
    if (!row || typeof row !== "object") continue;
    const rec = row as {
      name?: unknown;
      members?: unknown;
    };
    const name = String(rec.name || "").trim();
    const members = Array.isArray(rec.members) ? rec.members : [];
    const tickers: string[] = [];
    const spin: string[] = [];
    const demergeParents: string[] = [];
    for (const m of members) {
      if (!m || typeof m !== "object") continue;
      const mem = m as {
        ticker?: unknown;
        spin_off?: unknown;
        demerger?: unknown;
      };
      const ticker = String(mem.ticker || "").trim().toUpperCase();
      if (!ticker) continue;
      tickers.push(ticker);
      if (mem.spin_off === true) spin.push(ticker);
      else if (mem.demerger === true) demergeParents.push(ticker);
    }
    const uniq = [...new Set(tickers)];
    if (!name || !uniq.length) continue;
    out.groups.push({ name, tickers: uniq });
    const parents = demergeParents.length
      ? demergeParents
      : uniq.filter((t) => !spin.includes(t));
    const parent = parents[0];
    if (!parent) continue;
    for (const child of spin) {
      if (child !== parent) out.pairs.push({ parent, child });
    }
  }
  return out;
}

let stocksAiCache: { at: number; data: StocksAiGroupData } | null = null;

function loadStocksAiGroups(): StocksAiGroupData {
  const now = Date.now();
  if (stocksAiCache && now - stocksAiCache.at < CACHE_MS) return stocksAiCache.data;
  let data: StocksAiGroupData = { groups: [], pairs: [] };
  for (const seedPath of stocksAiSeedPaths()) {
    if (!fs.existsSync(seedPath)) continue;
    try {
      data = mergeStocksAiGroupData(data, readStocksAiSeedFile(seedPath));
      break;
    } catch (err) {
      console.warn("[governance-map] stocks-ai seed unreadable:", seedPath, err);
    }
  }
  for (const dbPath of stocksAiDbPaths()) {
    if (!fs.existsSync(dbPath)) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      data = mergeStocksAiGroupData(data, readStocksAiGroups(db));
      break;
    } catch (err) {
      console.warn("[governance-map] stocks-ai groups unreadable:", dbPath, err);
    } finally {
      db?.close();
    }
  }
  stocksAiCache = { at: now, data };
  return data;
}

function normCompanyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(limited|ltd|pvt|private|plc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Brand houses (name + family directors) plus control-seat affiliates. */
export function loadGovernanceFamilyMap(opts?: {
  q?: string;
  hold?: boolean;
  refresh?: boolean;
}): GovFamilyGroup[] {
  const qNeedle = (opts?.q || "").trim().toLowerCase();
  const now = Date.now();
  if (opts?.refresh) {
    familyMapCache = null;
    closeGovReader();
  }
  if (
    !opts?.hold &&
    !qNeedle &&
    !opts?.refresh &&
    familyMapCache &&
    now - familyMapCache.at < CACHE_MS
  ) {
    return familyMapCache.groups;
  }
  try {
    getGovernanceWriteDb();
    closeGovernanceWriteDb();
    closeGovReader();
  } catch {
    /* SME listing stubs optional */
  }

  const seats = loadAllBoardSeats();
  if (!seats.length) return [];

  const holdings = opts?.hold ? holdingsTickerSet() : null;
  const metrics = loadMetricsMap();
  const groupNames = loadGroupNameByTicker();
  const aboutBlobs = loadAboutBlobByTicker();
  const byTicker = new Map<string, SeatRow[]>();
  for (const seat of seats) {
    const ticker = (seat.ticker || "").toUpperCase();
    if (!ticker) continue;
    if (holdings && !holdings.has(ticker)) continue;
    const list = byTicker.get(ticker) ?? [];
    list.push(seat);
    byTicker.set(ticker, list);
  }

  const metaByTicker = new Map<string, GovFamilyCompany>();
  const surnamesByTicker = new Map<string, Set<string>>();
  const controlPeopleByTicker = new Map<string, Set<string>>();
  const promoterPeopleByTicker = new Map<string, Set<string>>();
  const controlSurnamesByTicker = new Map<string, Set<string>>();
  const seatsByPerson = new Map<string, SeatRow[]>();
  const nameHousesByTicker = new Map<string, string[]>();
  const seedHousesByTicker = new Map<string, Set<string>>();
  const declaredByTicker = new Map<string, string>();

  for (const [ticker, grp] of byTicker) {
    const first = grp[0]!;
    const companyName = first.company_name || ticker;
    let market = (first.market || "NSE").toUpperCase();
    const isSme = market === "NSE SME" || market === "BSE SME";
    if (!isSme && market.startsWith("NSE")) market = "NSE";
    else if (!isSme && market.startsWith("BSE")) market = "BSE";
    const mcap = metrics.get(ticker)?.market_cap_cr ?? null;
    metaByTicker.set(ticker, {
      ticker,
      name: companyName,
      market,
      cap_code: mcapCapCode(mcap),
      market_cap_cr: mcap,
      is_sme: isSme,
      family_directors: 0,
      directors: new Set(grp.map((s) => s.person_id)).size,
      din_verified: new Set(
        grp.filter((s) => /^\d{8}$/.test((s.din || "").trim())).map((s) => s.person_id),
      ).size,
    });

    const surnames = new Set<string>();
    const controlPeople = new Set<string>();
    const promoterPeople = new Set<string>();
    const controlSurnames = new Set<string>();
    for (const seat of grp) {
      const surname = normalizedSurname(seat.director_name);
      if (surname.length >= 3) surnames.add(surname);
      if (isHouseControlSeat(seat.designation, seat.category)) {
        controlPeople.add(seat.person_id);
        if (surname.length >= 3) controlSurnames.add(surname);
      }
      if (isHouseLinkSeat(seat.designation, seat.category)) {
        promoterPeople.add(seat.person_id);
      }
      const personSeats = seatsByPerson.get(seat.person_id) ?? [];
      personSeats.push(seat);
      seatsByPerson.set(seat.person_id, personSeats);
    }
    surnamesByTicker.set(ticker, surnames);
    controlPeopleByTicker.set(ticker, controlPeople);
    promoterPeopleByTicker.set(ticker, promoterPeople);
    controlSurnamesByTicker.set(ticker, controlSurnames);

    const nameHouses = houseTokensFromName(companyName);
    nameHousesByTicker.set(ticker, nameHouses);
    const seeds = new Set<string>();
    const firstHouse = nameHouses[0];
    if (firstHouse && surnames.has(firstHouse.toUpperCase())) {
      seeds.add(firstHouse);
    }
    seedHousesByTicker.set(ticker, seeds);
    const declared = declaredMergeKey(groupNames.get(ticker) || "");
    if (declared) declaredByTicker.set(ticker, declared);
  }

  const companyNames = [...metaByTicker.entries()].map(([t, m]) => ({
    ticker: t,
    name: m.name,
  }));
  for (const [ticker, gn] of groupNames) {
    if (!declaredByTicker.has(ticker)) continue;
    const blob = gn.toLowerCase();
    const borrowed = companyNames.some(
      (o) =>
        o.ticker !== ticker &&
        o.name.length >= 12 &&
        blob.includes(o.name.toLowerCase()),
    );
    if (borrowed) declaredByTicker.delete(ticker);
  }

  const listingMeta = new Map<string, GovFamilyCompany>();
  const addListingRow = (r: {
    ticker: string;
    name: string;
    market: string;
  }) => {
    const ticker = (r.ticker || "").toUpperCase();
    if (!ticker) return;
    let market = (r.market || "NSE").toUpperCase();
    const isSme = market === "NSE SME" || market === "BSE SME";
    if (!isSme && market.startsWith("NSE")) market = "NSE";
    else if (!isSme && market.startsWith("BSE")) market = "BSE";
    const existing = metaByTicker.get(ticker);
    if (existing) {
      existing.market = market || existing.market;
      existing.is_sme = isSme || existing.is_sme;
      if (r.name?.trim() && r.name.trim() !== ticker) existing.name = r.name.trim();
      return;
    }
    if (listingMeta.has(ticker)) {
      const row = listingMeta.get(ticker)!;
      row.market = market || row.market;
      row.is_sme = isSme || row.is_sme;
      return;
    }
    const mcap = metrics.get(ticker)?.market_cap_cr ?? null;
    listingMeta.set(ticker, {
      ticker,
      name: (r.name || ticker).trim() || ticker,
      market,
      cap_code: mcapCapCode(mcap),
      market_cap_cr: mcap,
      is_sme: isSme,
      family_directors: 0,
      directors: 0,
      din_verified: 0,
    });
    if (!nameHousesByTicker.has(ticker)) {
      nameHousesByTicker.set(ticker, houseTokensFromName(r.name || ticker));
    }
    if (!declaredByTicker.has(ticker)) {
      const declared = declaredMergeKey(groupNames.get(ticker) || "");
      if (declared) declaredByTicker.set(ticker, declared);
    }
  };
  try {
    const rows = getGov()
      .prepare(`SELECT ticker, name, market FROM companies`)
      .all() as Array<{ ticker: string; name: string; market: string }>;
    for (const r of rows) addListingRow(r);
  } catch {
    /* companies table optional */
  }
  try {
    const about = getAbout();
    if (about) {
      const rows = about
        .prepare(
          `SELECT ticker, name, market FROM company_about
           WHERE UPPER(TRIM(COALESCE(market, '')))
             IN ('NSE', 'NSE SME', 'BSE', 'BSE SME')`,
        )
        .all() as Array<{ ticker: string; name: string | null; market: string | null }>;
      for (const r of rows) {
        addListingRow({
          ticker: r.ticker,
          name: (r.name || r.ticker || "").trim() || r.ticker,
          market: r.market || "NSE",
        });
      }
    }
  } catch {
    /* about listings optional */
  }

  const brandHouses = new Set<string>();
  for (const seeds of seedHousesByTicker.values()) {
    for (const house of seeds) brandHouses.add(house);
  }

  type Uf = { parent: Map<string, string> };
  const makeUf = (): Uf => ({ parent: new Map() });
  const find = (uf: Uf, x: string): string => {
    if (!uf.parent.has(x)) uf.parent.set(x, x);
    const p = uf.parent.get(x)!;
    if (p === x) return x;
    const r = find(uf, p);
    uf.parent.set(x, r);
    return r;
  };
  const unite = (uf: Uf, a: string, b: string) => {
    const ra = find(uf, a);
    const rb = find(uf, b);
    if (ra !== rb) uf.parent.set(ra, rb);
  };

  const controlOn = (ticker: string) =>
    controlPeopleByTicker.get(ticker) ?? new Set<string>();
  const promoterOn = (ticker: string) =>
    promoterPeopleByTicker.get(ticker) ?? new Set<string>();
  const sharesControl = (a: string, b: string) => {
    const left = new Set([...controlOn(a), ...promoterOn(a)]);
    if (!left.size) return false;
    for (const pid of [...controlOn(b), ...promoterOn(b)]) {
      if (left.has(pid)) return true;
    }
    return false;
  };
  const groupsShareControl = (a: GovFamilyGroup, b: GovFamilyGroup) => {
    for (const c of a.companies) {
      for (const d of b.companies) {
        if (sharesControl(c.ticker, d.ticker)) return true;
      }
    }
    return false;
  };

  function packCompanies(tickers: Iterable<string>, house: string): GovFamilyCompany[] {
    const companies: GovFamilyCompany[] = [];
    const seen = new Set<string>();
    for (const t of tickers) {
      if (seen.has(t)) continue;
      seen.add(t);
      const meta = metaByTicker.get(t) ?? listingMeta.get(t);
      if (!meta) continue;
      const needle = houseSurnameKey(house);
      const family_directors = needle
        ? [...(byTicker.get(t) ?? [])].filter(
            (s) => normalizedSurname(s.director_name) === needle,
          ).length
        : 0;
      companies.push({ ...meta, family_directors });
    }
    companies.sort((a, b) => {
      const am = a.market_cap_cr ?? -1;
      const bm = b.market_cap_cr ?? -1;
      if (bm !== am) return bm - am;
      return a.ticker.localeCompare(b.ticker);
    });
    return companies;
  }

  function addAffiliates(members: Set<string>, house: string) {
    const houseKey = houseSurnameKey(house);
    const lead = houseLeadToken(house);
    const named = [...members];
    for (const src of named) {
      const srcControlSurnames = controlSurnamesByTicker.get(src) ?? new Set<string>();
      for (const pid of promoterOn(src)) {
        const srcSeat = (seatsByPerson.get(pid) ?? []).find(
          (s) => (s.ticker || "").toUpperCase() === src,
        );
        const expanderSurname = srcSeat
          ? normalizedSurname(srcSeat.director_name)
          : "";
        const expanderMatchesControl = srcControlSurnames.has(expanderSurname);
        for (const seat of seatsByPerson.get(pid) ?? []) {
          const other = (seat.ticker || "").toUpperCase();
          if (!other || members.has(other)) continue;
          if (
            !isHouseLinkSeat(seat.designation, seat.category) &&
            !expanderMatchesControl
          ) {
            continue;
          }
          const otherLead = nameHousesByTicker.get(other)?.[0];
          if (
            otherLead &&
            otherLead.toUpperCase() !== houseKey &&
            brandHouses.has(otherLead) &&
            !expanderMatchesControl
          ) {
            continue;
          }
          const otherSeeds = seedHousesByTicker.get(other);
          if (
            otherSeeds &&
            [...otherSeeds].some((h) => h.toUpperCase() !== houseKey && brandHouses.has(h)) &&
            !expanderMatchesControl
          ) {
            continue;
          }
          if (
            lead.length >= 3 &&
            houseKey &&
            lead !== houseKey &&
            otherLead &&
            otherLead.toUpperCase() === houseKey &&
            otherLead.toUpperCase() !== lead &&
            !(nameHousesByTicker.get(other) ?? []).some(
              (h) => h.toUpperCase() === lead,
            )
          ) {
            continue;
          }
          const otherNamed =
            Boolean(
              otherLead &&
                (otherLead.toUpperCase() === houseKey ||
                  otherLead.toUpperCase() === lead),
            ) || declaredByTicker.get(other)?.toLowerCase() === house.toLowerCase();
          const surnameIsHouse = expanderSurname === houseKey;
          if (!otherNamed && !surnameIsHouse && !expanderMatchesControl) continue;
          members.add(other);
        }
      }
    }
    const houseControlPeople = new Set<string>();
    for (const src of members) {
      for (const pid of controlOn(src)) houseControlPeople.add(pid);
    }
    for (const [ticker, grp] of byTicker) {
      if (members.has(ticker)) continue;
      const hasHouseControl = grp.some(
        (s) =>
          isHouseControlSeat(s.designation, s.category) &&
          normalizedSurname(s.director_name) === houseKey,
      );
      if (!hasHouseControl) continue;
      const sharesControl = grp.some((s) => houseControlPeople.has(s.person_id));
      if (!sharesControl) continue;
      members.add(ticker);
    }
    const memberPromoters = new Set<string>();
    for (const src of members) {
      for (const pid of promoterOn(src)) memberPromoters.add(pid);
    }
    for (const [ticker, grp] of byTicker) {
      if (members.has(ticker)) continue;
      const shared = new Set(
        grp
          .filter((s) => isHouseLinkSeat(s.designation, s.category))
          .map((s) => s.person_id)
          .filter((pid) => memberPromoters.has(pid)),
      );
      if (shared.size < 2) continue;
      members.add(ticker);
    }
    const memberPeople = new Set<string>();
    for (const src of members) {
      for (const s of byTicker.get(src) ?? []) memberPeople.add(s.person_id);
    }
    for (const [ticker, grp] of byTicker) {
      if (members.has(ticker)) continue;
      const otherFirst = nameHousesByTicker.get(ticker)?.[0];
      if (
        otherFirst &&
        otherFirst.toUpperCase() !== houseKey &&
        otherFirst.toUpperCase() !== lead &&
        brandHouses.has(otherFirst)
      ) {
        continue;
      }
      const hasHousePromoter = grp.some(
        (s) =>
          isHouseLinkSeat(s.designation, s.category) &&
          normalizedSurname(s.director_name) === houseKey,
      );
      if (!hasHousePromoter) continue;
      if (!grp.some((s) => memberPeople.has(s.person_id))) continue;
      members.add(ticker);
    }
  }

  const groups: GovFamilyGroup[] = [];
  const covered = new Set<string>();

  const declaredMembers = new Map<string, Set<string>>();
  const addDeclaredTicker = (rawLabel: string, ticker: string) => {
    const key = declaredMergeKey(rawLabel);
    if (!key || !ticker) return;
    const core = declaredCore(key);
    let sink: string | undefined;
    for (const e of declaredMembers.keys()) {
      if (declaredCore(e) === core) {
        sink = e;
        break;
      }
    }
    if (!sink) {
      declaredMembers.set(key, new Set([ticker]));
      return;
    }
    if (key.length > sink.length) {
      const moved = declaredMembers.get(sink)!;
      declaredMembers.delete(sink);
      declaredMembers.set(key, moved);
      sink = key;
    }
    declaredMembers.get(sink)!.add(ticker);
  };
  for (const [ticker, label] of declaredByTicker) {
    addDeclaredTicker(label, ticker);
  }
  const stocksAi = loadStocksAiGroups();
  for (const ext of stocksAi.groups) {
    const label = declaredMergeKey(ext.name) || ext.name.trim().toLowerCase();
    if (!label) continue;
    for (const ticker of ext.tickers) {
      if (metaByTicker.has(ticker)) addDeclaredTicker(label, ticker);
    }
  }
  for (const [label, members] of declaredMembers) {
    const compact = label.replace(/\s+/g, "").toUpperCase();
    if (compact.length >= 3) {
      for (const [ticker, meta] of metaByTicker) {
        if (members.has(ticker)) continue;
        const rawTokens = companyNameTokens(meta.name).filter((t) => {
          const key = t.toLowerCase();
          return !HOUSE_SKIP.has(key) && /^[a-z]{3,}$/i.test(t);
        });
        if (rawTokens.length) continue;
        if (nameAcronym(meta.name) === compact) members.add(ticker);
      }
    }
  }
  function companyCarriesHouseName(ticker: string, house: string): boolean {
    const key = houseSurnameKey(house);
    const lead = houseLeadToken(house);
    const first = (nameHousesByTicker.get(ticker) ?? [])[0];
    if (!first) return false;
    const u = first.toUpperCase();
    return Boolean(u) && (u === key || u === lead);
  }

  function partitionDeclared(members: Set<string>, label: string): Set<string>[] {
    const named = new Set<string>();
    const unnamed = new Set<string>();
    for (const t of members) {
      if (companyCarriesHouseName(t, label)) named.add(t);
      else unnamed.add(t);
    }
    const out: Set<string>[] = [];
    if (named.size) out.push(named);
    const uf = makeUf();
    const peopleToTickers = new Map<string, string[]>();
    for (const t of unnamed) {
      find(uf, t);
      for (const pid of promoterOn(t)) {
        const list = peopleToTickers.get(pid) ?? [];
        list.push(t);
        peopleToTickers.set(pid, list);
      }
    }
    for (const list of peopleToTickers.values()) {
      for (let i = 1; i < list.length; i++) unite(uf, list[0]!, list[i]!);
    }
    const components = new Map<string, Set<string>>();
    for (const t of unnamed) {
      const root = find(uf, t);
      const set = components.get(root) ?? new Set();
      set.add(t);
      components.set(root, set);
    }
    for (const set of components.values()) {
      if (set.size >= 2) out.push(set);
    }
    const coreOf = (t: string) => {
      const raw = declaredByTicker.get(t) || "";
      const key = declaredMergeKey(raw);
      if (!key) return "";
      const core = declaredCore(key);
      return declaredKeyTokens(core).length >= 2 ? core : "";
    };
    const coreSets = new Map<string, Set<string>>();
    const unkeyed: Set<string>[] = [];
    for (const set of out) {
      const cores = [...new Set([...set].map(coreOf).filter(Boolean))];
      if (cores.length !== 1) {
        unkeyed.push(set);
        continue;
      }
      const sink = coreSets.get(cores[0]!) ?? new Set<string>();
      for (const t of set) sink.add(t);
      coreSets.set(cores[0]!, sink);
    }
    return [...coreSets.values(), ...unkeyed].filter((s) => s.size >= 2);
  }

  const declaredKeyTokens = (key: string) => declaredCore(key).split(/\s+/).filter(Boolean);
  const declaredKeys = [...declaredMembers.keys()];
  declaredKeys.sort((a, b) => declaredKeyTokens(a).length - declaredKeyTokens(b).length);
  for (const shorter of declaredKeys) {
    const st = declaredKeyTokens(shorter);
    if (st.length < 2) continue;
    if (!declaredMembers.has(shorter)) continue;
    for (const longer of declaredKeys) {
      if (longer === shorter || !declaredMembers.has(longer)) continue;
      const lt = declaredKeyTokens(longer);
      if (lt.length <= st.length) continue;
      if (!st.every((w, i) => lt[i] === w)) continue;
      const sink = declaredMembers.get(shorter)!;
      for (const t of declaredMembers.get(longer) ?? []) sink.add(t);
      declaredMembers.delete(longer);
    }
  }
  for (const longer of [...declaredMembers.keys()]) {
    const lt = declaredKeyTokens(longer);
    if (lt.length < 2) continue;
    const shortCore = lt[0]!;
    let sink: string | undefined;
    for (const e of declaredMembers.keys()) {
      if (e === longer) continue;
      const et = declaredKeyTokens(e);
      if (et.length === 1 && et[0] === shortCore) {
        if ((declaredMembers.get(e)?.size ?? 0) > (declaredMembers.get(longer)?.size ?? 0)) {
          sink = e;
          break;
        }
      }
    }
    if (!sink) continue;
    for (const t of declaredMembers.get(longer) ?? []) declaredMembers.get(sink)!.add(t);
    declaredMembers.delete(longer);
  }
  for (const key of [...declaredMembers.keys()]) {
    const core = declaredCore(key);
    if (!/^[a-z]{4,}s$/.test(core)) continue;
    const stem = core.slice(0, -1);
    const moreSpecific = [...declaredMembers.keys()].some(
      (other) => other !== key && declaredKeyTokens(other).includes(stem),
    );
    if (moreSpecific) declaredMembers.delete(key);
  }

  const declaredOrder = [...declaredMembers.entries()].sort(
    (a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]),
  );
  for (const [label, members] of declaredOrder) {
    const clusters = partitionDeclared(members, label);
    for (const cluster of clusters) {
      addAffiliates(cluster, label);
      const companies = packCompanies(cluster, label);
      if (companies.length < 2) continue;
      for (const c of companies) covered.add(c.ticker);
      groups.push({
        family_name: displayGroupLabel(label),
        company_count: companies.length,
        companies,
      });
    }
  }

  const declaredLeadTokens = new Set<string>();
  for (const label of declaredMembers.keys()) {
    const lead = houseLeadToken(label);
    if (lead) declaredLeadTokens.add(lead);
  }

  const tokenTickers = new Map<string, string[]>();
  for (const [ticker, nameHouses] of nameHousesByTicker) {
    const house = nameHouses[0];
    if (!house) continue;
    if (!brandHouses.has(house) && !declaredLeadTokens.has(house.toUpperCase())) continue;
    const list = tokenTickers.get(house) ?? [];
    list.push(ticker);
    tokenTickers.set(house, list);
  }

  for (const [house, houseTickers] of tokenTickers) {
    const uniq = [...new Set(houseTickers)];
    const uf = makeUf();
    const peopleToTickers = new Map<string, string[]>();
    for (const t of uniq) {
      find(uf, t);
      for (const pid of controlOn(t)) {
        const list = peopleToTickers.get(pid) ?? [];
        list.push(t);
        peopleToTickers.set(pid, list);
      }
    }
    for (const list of peopleToTickers.values()) {
      for (let i = 1; i < list.length; i++) unite(uf, list[0]!, list[i]!);
    }
    const components = new Map<string, Set<string>>();
    for (const t of uniq) {
      if (!seedHousesByTicker.get(t)?.has(house) && nameHousesByTicker.get(t)?.[0] !== house) {
        continue;
      }
      const root = find(uf, t);
      const set = components.get(root) ?? new Set();
      set.add(t);
      components.set(root, set);
    }
    for (const members of components.values()) {
      addAffiliates(members, house);
      const leftover = [...members].filter((t) => !covered.has(t));
      if (!leftover.length) continue;
      const host = groups.find((g) => {
        const base = (
          g.family_name.split(" · ")[0] || g.family_name
        ).toLowerCase();
        const h = house.toLowerCase();
        return (
          base === h ||
          base === `${h} group` ||
          base.startsWith(`${h} `) ||
          base.endsWith(` ${h}`)
        );
      });
      const hostControl = new Set<string>();
      if (host) {
        for (const c of host.companies) {
          for (const pid of controlOn(c.ticker)) hostControl.add(pid);
        }
      }
      const sharesHost = (t: string) => {
        if (!host) return false;
        for (const pid of controlOn(t)) {
          if (hostControl.has(pid)) return true;
        }
        return (byTicker.get(t) ?? []).some((s) => hostControl.has(s.person_id));
      };
      if (host) {
        const extraTickers = leftover.filter(
          (t) => sharesHost(t) || companyCarriesHouseName(t, house),
        );
        if (extraTickers.length) {
          const extra = packCompanies(extraTickers, house);
          for (const c of extra) {
            if (host.companies.some((x) => x.ticker === c.ticker)) continue;
            host.companies.push(c);
            covered.add(c.ticker);
          }
          host.companies.sort((a, b) => {
            const am = a.market_cap_cr ?? -1;
            const bm = b.market_cap_cr ?? -1;
            if (bm !== am) return bm - am;
            return a.ticker.localeCompare(b.ticker);
          });
          host.company_count = host.companies.length;
        }
      }
      const orphan = leftover.filter((t) => !covered.has(t));
      if (orphan.length < 2) continue;
      const companies = packCompanies(orphan, house);
      if (companies.length < 2) continue;
      for (const c of companies) covered.add(c.ticker);
      groups.push({
        family_name: house,
        company_count: companies.length,
        companies,
      });
    }

    for (const ticker of uniq) {
      if (covered.has(ticker)) continue;
      if (
        !seedHousesByTicker.get(ticker)?.has(house) &&
        nameHousesByTicker.get(ticker)?.[0] !== house
      ) {
        continue;
      }
      const members = new Set([ticker]);
      addAffiliates(members, house);
      const leftover = [...members].filter((t) => !covered.has(t));
      if (leftover.length < 2) continue;
      const companies = packCompanies(leftover, house);
      if (companies.length < 2) continue;
      for (const c of companies) covered.add(c.ticker);
      groups.push({
        family_name: house,
        company_count: companies.length,
        companies,
      });
    }
  }

  const nameIndex = new Map<string, string>();
  for (const [t, meta] of metaByTicker) {
    const key = normCompanyKey(meta.name);
    if (key.length >= 10) nameIndex.set(key, t);
  }

  const addChildToGroup = (
    host: GovFamilyGroup,
    ticker: string,
    house: string,
  ) => {
    if (host.companies.some((c) => c.ticker === ticker)) return;
    const extra = packCompanies([ticker], house);
    host.companies.push(...extra);
    host.companies.sort((a, b) => {
      const am = a.market_cap_cr ?? -1;
      const bm = b.market_cap_cr ?? -1;
      if (bm !== am) return bm - am;
      return a.ticker.localeCompare(b.ticker);
    });
    host.company_count = host.companies.length;
    covered.add(ticker);
  };

  for (const [ticker, blob] of aboutBlobs) {
    if (!metaByTicker.has(ticker)) continue;
    const parentTickers = new Set<string>();
    const parentHouses = new Set<string>();
    for (const m of blob.matchAll(
      /\(([A-Z]{1,12}(?:[&-][A-Z0-9]{1,12})?)\)/g,
    )) {
      const sym = (m[1] || "").toUpperCase();
      if (sym && sym !== ticker && metaByTicker.has(sym)) parentTickers.add(sym);
    }
    const clauseRe = /(?:subsidiary of|manufactured by)\s+([^.,;\n]+)/gi;
    let sm: RegExpExecArray | null;
    while ((sm = clauseRe.exec(blob))) {
      const clause = (sm[1] || "").trim();
      const nk = normCompanyKey(clause);
          if (nk.length >= 10) {
        for (const [key, pt] of nameIndex) {
          if (pt === ticker) continue;
          if (nk === key) {
            parentTickers.add(pt);
            continue;
          }
          if (
            nk.length >= 12 &&
            key.length >= 12 &&
            (nk.startsWith(`${key} `) || key.startsWith(`${nk} `))
          ) {
            parentTickers.add(pt);
          }
        }
      }
      const house = houseTokensFromName(clause)[0];
      if (!house) continue;
      const known = groups.some((g) => {
        const base = (g.family_name.split(" · ")[0] || g.family_name).toLowerCase();
        const h = house.toLowerCase();
        return base === h || base.endsWith(` ${h}`);
      });
      if (brandHouses.has(house) || known) parentHouses.add(house);
    }
    for (const pt of parentTickers) {
      const host = groups.find((g) =>
        g.companies.some((c) => c.ticker === pt),
      );
      if (host) addChildToGroup(host, ticker, host.family_name);
    }
    for (const house of parentHouses) {
      const host = groups.find((g) => {
        const base = g.family_name.split(" · ")[0] || g.family_name;
        return (
          base.toLowerCase() === house.toLowerCase() ||
          base.toLowerCase().endsWith(` ${house.toLowerCase()}`)
        );
      });
      if (host) addChildToGroup(host, ticker, house);
    }
  }

  // Demerged spin-offs stay in the parent's house.
  const groupOf = (ticker: string) =>
    groups.find((g) => g.companies.some((c) => c.ticker === ticker));
  // External pair lists contain errors; require our own board or name evidence.
  const pairCorroborated = (a: string, b: string) => {
    const housesA = new Set(
      (nameHousesByTicker.get(a) ?? []).map((h) => h.toLowerCase()),
    );
    if ((nameHousesByTicker.get(b) ?? []).some((h) => housesA.has(h.toLowerCase()))) {
      return true;
    }
    const peopleB = new Set((byTicker.get(b) ?? []).map((s) => s.person_id));
    return (byTicker.get(a) ?? []).some((s) => peopleB.has(s.person_id));
  };
  for (const { parent, child } of stocksAi.pairs) {
    if (!metaByTicker.has(parent) || !metaByTicker.has(child)) continue;
    if (!pairCorroborated(parent, child)) continue;
    const hostP = groupOf(parent);
    const hostC = groupOf(child);
    if (hostP && hostC) continue;
    if (hostP) {
      addChildToGroup(hostP, child, hostP.family_name);
      continue;
    }
    if (hostC) {
      addChildToGroup(hostC, parent, hostC.family_name);
      continue;
    }
    const parentName = metaByTicker.get(parent)!.name;
    const label = parentName.replace(/\b(limited|ltd\.?)\s*$/i, "").trim() || parent;
    const existing = groups.find(
      (g) => g.family_name.toLowerCase() === label.toLowerCase(),
    );
    if (existing) {
      addChildToGroup(existing, parent, label);
      addChildToGroup(existing, child, label);
      continue;
    }
    const members = new Set([parent, child]);
    const houseKey = houseTokensFromName(parentName)[0];
    if (houseKey) addAffiliates(members, houseKey);
    const companies = packCompanies(
      [...members].filter((t) => t === parent || t === child || !covered.has(t)),
      houseKey || label,
    );
    if (companies.length < 2) continue;
    for (const c of companies) covered.add(c.ticker);
    groups.push({ family_name: label, company_count: companies.length, companies });
  }

  // A company belongs to one house: keep it where its board overlaps most.
  const boardAffinity = (ticker: string, g: GovFamilyGroup) => {
    const mine = new Set([
      ...controlOn(ticker),
      ...promoterOn(ticker),
    ]);
    let score = 0;
    const counted = new Set<string>();
    for (const c of g.companies) {
      if (c.ticker === ticker) continue;
      const theirs = new Set([
        ...controlOn(c.ticker),
        ...promoterOn(c.ticker),
      ]);
      for (const pid of mine) {
        if (!theirs.has(pid) || counted.has(pid)) continue;
        counted.add(pid);
        score += controlOn(ticker).has(pid) || controlOn(c.ticker).has(pid) ? 2 : 1;
      }
    }
    return score;
  };
  const groupsByTicker = new Map<string, GovFamilyGroup[]>();
  for (const g of groups) {
    for (const c of g.companies) {
      const list = groupsByTicker.get(c.ticker) ?? [];
      list.push(g);
      groupsByTicker.set(c.ticker, list);
    }
  }
  for (const [ticker, owners] of groupsByTicker) {
    if (owners.length < 2) continue;
    const firstHouse = (nameHousesByTicker.get(ticker)?.[0] || "").toLowerCase();
    const ranked = owners
      .map((g) => ({
        g,
        score: boardAffinity(ticker, g),
        named: firstHouse !== "" && g.family_name.toLowerCase().startsWith(firstHouse),
      }))
      .sort(
        (a, b) =>
          Number(b.named) - Number(a.named) ||
          b.score - a.score ||
          b.g.companies.length - a.g.companies.length,
      );
    for (const { g } of ranked.slice(1)) {
      g.companies = g.companies.filter((c) => c.ticker !== ticker);
      g.company_count = g.companies.length;
    }
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i]!.companies.length < 2) groups.splice(i, 1);
  }

  for (const g of groups) {
    const lead = houseLeadToken(g.family_name.split(" · ")[0] || g.family_name);
    if (!lead) continue;
    g.companies = g.companies.filter((c) => {
      const first = (nameHousesByTicker.get(c.ticker)?.[0] || "").toUpperCase();
      if (first && first === lead) return true;
      if (first && first !== lead && brandHouses.has(nameHousesByTicker.get(c.ticker)![0]!)) {
        return false;
      }
      return boardAffinity(c.ticker, g) > 0;
    });
    g.company_count = g.companies.length;
    for (const c of g.companies) covered.add(c.ticker);
  }
  for (const g of groups) {
    const lead = houseLeadToken(g.family_name.split(" · ")[0] || g.family_name);
    if (!lead) continue;
    for (const [ticker, houses] of nameHousesByTicker) {
      if (covered.has(ticker)) continue;
      if ((houses[0] || "").toUpperCase() !== lead) continue;
      addChildToGroup(g, ticker, g.family_name);
    }
  }
  const namedByLead = new Map<string, GovFamilyGroup[]>();
  for (const g of groups) {
    const lead = houseLeadToken(g.family_name.split(" · ")[0] || g.family_name);
    if (!lead) continue;
    const namedN = g.companies.filter(
      (c) => (nameHousesByTicker.get(c.ticker)?.[0] || "").toUpperCase() === lead,
    ).length;
    if (!namedN || namedN * 2 < g.companies.length) continue;
    const list = namedByLead.get(lead) ?? [];
    list.push(g);
    namedByLead.set(lead, list);
  }
  for (const list of namedByLead.values()) {
    if (list.length < 2) continue;
    list.sort(
      (a, b) =>
        b.companies.length - a.companies.length ||
        a.family_name.localeCompare(b.family_name),
    );
    const host = list[0]!;
    const labels = list.map((g) => g.family_name.trim()).filter(Boolean);
    for (const g of list.slice(1)) {
      for (const c of g.companies) {
        if (host.companies.some((x) => x.ticker === c.ticker)) continue;
        host.companies.push(c);
        covered.add(c.ticker);
      }
      g.companies = [];
    }
    host.company_count = host.companies.length;
    labels.sort(
      (a, b) => a.length - b.length || a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    const compact = labels.find((n) => /\bgroup\b/i.test(n)) || labels[0];
    if (compact) host.family_name = compact;
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i]!.companies.length < 2) groups.splice(i, 1);
  }

  // Display labels in the casing the member companies use (e.g. "DCM", not "Dcm").
  for (const g of groups) {
    g.family_name = g.family_name.replace(/[A-Za-z][A-Za-z&]+/g, (word) => {
      const re = new RegExp(`\\b${word.replace(/&/g, "\\&")}\\b`, "i");
      const hits = g.companies
        .map((c) => c.name.match(re)?.[0])
        .filter((h): h is string => Boolean(h) && h !== h!.toLowerCase());
      if (!hits.length) return word;
      const votes = new Map<string, number>();
      for (const h of hits) votes.set(h, (votes.get(h) ?? 0) + 1);
      return [...votes.entries()].sort(
        (a, b) =>
          b[1] - a[1] ||
          Number(a[0] === a[0].toUpperCase()) - Number(b[0] === b[0].toUpperCase()),
      )[0]![0];
    });
  }

  const personNameKey = (name: string) =>
    name
      .toLowerCase()
      .replace(/\b(mr|mrs|ms|dr|shri|smt)\.?\b/g, " ")
      .replace(/[^a-z]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const familyLabels = loadAllFamilyLabels();
  for (const g of groups) {
    const cached =
      familyLabels.get(groupFingerprint(g.companies.map((c) => c.ticker))) ||
      null;
    const cacheTokens = houseContentTokens(cached || "")
      .map((w) => w.toLowerCase())
      .filter((w) => w !== "group");
    const cacheFits =
      Boolean(cached) &&
      !cached!.includes("·") &&
      cacheTokens.length > 0 &&
      cacheTokens.every((w) =>
        g.companies.some((c) =>
          `${c.name} ${declaredByTicker.get(c.ticker) || ""}`
            .toLowerCase()
            .includes(w),
        ),
      );
    if (cacheFits) {
      g.family_name = cached!;
      continue;
    }
    const directorKeys = new Set<string>();
    const declaredVotes = new Map<string, number>();
    for (const c of g.companies) {
      for (const s of byTicker.get(c.ticker) ?? []) {
        const k = personNameKey(s.director_name);
        if (k) directorKeys.add(k);
      }
      const d = declaredByTicker.get(c.ticker);
      if (d) declaredVotes.set(d, (declaredVotes.get(d) ?? 0) + 1);
    }
    const baseLabel = (g.family_name.split(" · ")[0] || g.family_name).trim();
    const baseKey = personNameKey(baseLabel);
    const labelTokens = houseContentTokens(baseLabel).map((w) => w.toLowerCase());
    const labelInNames =
      labelTokens.length > 0 &&
      g.companies.filter((c) => {
        const blob = `${c.name} ${declaredByTicker.get(c.ticker) || ""}`.toLowerCase();
        return labelTokens.every((w) => blob.includes(w));
      }).length >= Math.min(2, g.companies.length);
    const looksLikePerson =
      Boolean(baseKey) &&
      (directorKeys.has(baseKey) ||
        [...directorKeys].some(
          (k) =>
            k === baseKey ||
            (baseKey.split(" ").length >= 2 &&
              (k.endsWith(` ${baseKey}`) ||
                k.startsWith(`${baseKey} `) ||
                k.includes(` ${baseKey} `))),
        ) ||
        (labelTokens.length >= 2 && !labelInNames));
    if (looksLikePerson) {
      const topDeclared = [...declaredVotes.entries()]
        .filter(([name]) => !directorKeys.has(personNameKey(name)))
        .sort((a, b) => b[1] - a[1])[0];
      if (topDeclared && topDeclared[1] >= 2) {
        g.family_name = displayGroupLabel(topDeclared[0]);
      } else {
        const lead =
          houseTokensFromName(g.companies[0]?.name || "")[0] || baseLabel;
        g.family_name = /group$/i.test(lead) ? lead : `${lead} Group`;
      }
    }
  }

  const byLead = new Map<string, GovFamilyGroup[]>();
  for (const g of groups) {
    const lead = houseLeadToken(g.family_name.split(" · ")[0] || g.family_name);
    if (!lead) continue;
    const list = byLead.get(lead) ?? [];
    list.push(g);
    byLead.set(lead, list);
  }
  for (const list of byLead.values()) {
    if (list.length < 2) continue;
    const buckets = new Map<string, GovFamilyGroup[]>();
    for (const g of list) {
      const k = g.family_name.toLowerCase().replace(/\s+/g, " ").trim();
      const arr = buckets.get(k) ?? [];
      arr.push(g);
      buckets.set(k, arr);
    }
    for (const same of buckets.values()) {
      if (same.length < 2) continue;
      for (const g of same) {
        const tokens = houseTokensFromName(g.companies[0]?.name || "");
        if (tokens.length >= 2) {
          g.family_name = `${tokens[0]} ${tokens[1]}`;
        }
      }
    }
  }

  const mergedByName = new Map<string, GovFamilyGroup>();
  const leftover: GovFamilyGroup[] = [];
  for (const g of groups) {
    const key =
      canonicalHouseLabel(g.family_name) ||
      g.family_name.toLowerCase().replace(/\s+/g, " ").trim();
    const hit = mergedByName.get(key);
    if (!hit) {
      mergedByName.set(key, g);
      leftover.push(g);
      continue;
    }
    if (!groupsShareControl(hit, g)) {
      leftover.push(g);
      continue;
    }
    for (const c of g.companies) {
      if (hit.companies.some((x) => x.ticker === c.ticker)) continue;
      hit.companies.push(c);
    }
    hit.company_count = hit.companies.length;
  }
  groups.length = 0;
  groups.push(...leftover.filter((g) => g.companies.length >= 2));

  const declaredCoreOfGroup = (g: GovFamilyGroup): string => {
    const votes = new Map<string, number>();
    for (const c of g.companies) {
      const raw = declaredByTicker.get(c.ticker) || "";
      const key = declaredMergeKey(raw);
      if (!key) continue;
      const core = declaredCore(key);
      if (declaredKeyTokens(core).length < 2) continue;
      votes.set(core, (votes.get(core) ?? 0) + 1);
    }
    const top = [...votes.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0];
    return top && top[1] >= 1 ? top[0] : "";
  };
  const mergedByDeclared = new Map<string, GovFamilyGroup>();
  const afterDeclared: GovFamilyGroup[] = [];
  for (const g of groups) {
    const key = declaredCoreOfGroup(g);
    if (!key) {
      afterDeclared.push(g);
      continue;
    }
    const hit = mergedByDeclared.get(key);
    if (!hit) {
      mergedByDeclared.set(key, g);
      afterDeclared.push(g);
      continue;
    }
    for (const c of g.companies) {
      if (hit.companies.some((x) => x.ticker === c.ticker)) continue;
      hit.companies.push(c);
    }
    hit.company_count = hit.companies.length;
    g.companies = [];
  }
  groups.length = 0;
  groups.push(...afterDeclared.filter((g) => g.companies.length >= 2));

  const seedDisplayName = (raw: string) => {
    const key = declaredMergeKey(raw) || raw.trim().toLowerCase();
    return displayGroupLabel(key);
  };
  for (const g of groups) {
    const mine = new Set(g.companies.map((c) => c.ticker));
    let best: { name: string; overlap: number; spec: number } | null = null;
    for (const seed of stocksAi.groups) {
      const overlap = seed.tickers.filter((t) => mine.has(t)).length;
      if (overlap < 2 && !(mine.size === overlap && overlap >= 1)) continue;
      const spec = overlap / Math.max(seed.tickers.length, 1);
      if (
        !best ||
        overlap > best.overlap ||
        (overlap === best.overlap && spec > best.spec)
      ) {
        best = { name: seed.name, overlap, spec };
      }
    }
    if (best?.name) g.family_name = seedDisplayName(best.name);
  }

  applyFamilyGroupEdits(groups, (ticker) => {
    const packed = packCompanies([ticker], "");
    return packed[0] ?? null;
  });

  for (const g of groups) {
    const inGroup = new Set(g.companies.map((c) => c.ticker.toUpperCase()));
    const people = new Map<string, GovFamilyPerson>();
    const scorePerson = (personId: string, din: string | null) =>
      scoreDirectorSeats(
        (seatsByPerson.get(personId) ?? []).map((s) => {
          const t = (s.ticker || "").toUpperCase();
          return {
            ticker: t,
            market_cap_cr: metaByTicker.get(t)?.market_cap_cr ?? null,
            person_id: personId,
            din,
            designation: s.designation,
            category: s.category,
          };
        }),
        { personId, din },
      ).dir_score;
    const addPerson = (
      s: SeatRow,
      tickers: string[],
      inGroupOnly: boolean,
      minListed = 2,
    ) => {
      if (people.has(s.person_id) || isPlaceholderDirectorName(s.director_name)) {
        return;
      }
      const listed = inGroupOnly
        ? tickers.filter((t) => inGroup.has(t))
        : tickers.filter((t) => metaByTicker.has(t) || listingMeta.has(t));
      if (listed.length < minListed) return;
      const din = s.din && /^\d{8}$/.test(s.din.trim()) ? s.din.trim() : null;
      people.set(s.person_id, {
        person_id: s.person_id,
        name: s.director_name,
        din,
        tickers: listed,
        dir_score: scorePerson(s.person_id, din),
      });
    };
    for (const t of inGroup) {
      for (const s of byTicker.get(t) ?? []) {
        if (
          !isHouseFamilySeat(s.designation, s.category) &&
          !isHouseControlSeat(s.designation, s.category)
        ) {
          continue;
        }
        const tickers = [
          ...new Set(
            (seatsByPerson.get(s.person_id) ?? [])
              .map((x) => (x.ticker || "").toUpperCase())
              .filter((x) => metaByTicker.has(x) || listingMeta.has(x)),
          ),
        ];
        addPerson(s, tickers, false);
      }
    }
    for (const t of inGroup) {
      for (const s of byTicker.get(t) ?? []) {
        const tickers = [
          ...new Set(
            (seatsByPerson.get(s.person_id) ?? [])
              .map((x) => (x.ticker || "").toUpperCase())
              .filter((x) => metaByTicker.has(x) || listingMeta.has(x)),
          ),
        ];
        if (!tickers.some((x) => inGroup.has(x))) continue;
        addPerson(s, tickers, false);
      }
    }
    const outsideLinks = new Map<string, number>();
    for (const p of people.values()) {
      for (const t of p.tickers) {
        if (!inGroup.has(t)) outsideLinks.set(t, (outsideLinks.get(t) ?? 0) + 1);
      }
    }
    const inGroupLinked = () => {
      const s = new Set<string>();
      for (const p of people.values()) {
        for (const t of p.tickers) if (inGroup.has(t)) s.add(t);
      }
      return s;
    };
    let linkedIn = inGroupLinked();
    for (const t of inGroup) {
      if (linkedIn.has(t)) continue;
      let bestPid = "";
      let bestTickers: string[] = [];
      for (const s of byTicker.get(t) ?? []) {
        if (isPlaceholderDirectorName(s.director_name)) continue;
        const tickers = [
          ...new Set(
            (seatsByPerson.get(s.person_id) ?? [])
              .map((x) => (x.ticker || "").toUpperCase())
              .filter((x) => metaByTicker.has(x) || listingMeta.has(x)),
          ),
        ];
        if (tickers.length < 2) continue;
        if (tickers.length > bestTickers.length) {
          bestPid = s.person_id;
          bestTickers = tickers;
        }
      }
      if (!bestPid) {
        for (const s of byTicker.get(t) ?? []) {
          if (isPlaceholderDirectorName(s.director_name)) continue;
          addPerson(s, [t], true, 1);
          break;
        }
        linkedIn = inGroupLinked();
        continue;
      }
      const seat = (seatsByPerson.get(bestPid) ?? []).find((x) => x.person_id === bestPid)!;
      addPerson(
        seat,
        bestTickers.filter((x) => inGroup.has(x)),
        true,
        1,
      );
      linkedIn = inGroupLinked();
    }
    const outside = [...outsideLinks.entries()]
      .sort(
        (a, b) =>
          b[1] - a[1] ||
          (metaByTicker.get(b[0])?.market_cap_cr ??
            listingMeta.get(b[0])?.market_cap_cr ??
            -1) -
            (metaByTicker.get(a[0])?.market_cap_cr ??
              listingMeta.get(a[0])?.market_cap_cr ??
              -1),
      )
      .map(([t]) => {
        const meta = metaByTicker.get(t) ?? listingMeta.get(t);
        if (!meta) return null;
        return {
          ticker: t,
          name: meta.name,
          cap_code: meta.cap_code,
          market_cap_cr: meta.market_cap_cr,
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    const ranked = [...people.values()]
      .map((p) => ({
        ...p,
        tickers: p.tickers.filter((x) => metaByTicker.has(x) || listingMeta.has(x)),
      }))
      .filter((p) => p.tickers.length >= 1)
      .sort((a, b) => b.tickers.length - a.tickers.length);
    const picked: GovFamilyPerson[] = [];
    const covered = new Set<string>();
    const take = (p: GovFamilyPerson) => {
      if (picked.some((x) => x.person_id === p.person_id)) return;
      picked.push(p);
      for (const x of p.tickers) if (inGroup.has(x)) covered.add(x);
    };
    for (const p of ranked) {
      if (p.tickers.some((x) => inGroup.has(x) && !covered.has(x))) take(p);
      if (covered.size === inGroup.size) break;
    }
    for (const p of ranked) {
      if (picked.length >= FAMILY_GRAPH_MAX_PEOPLE) break;
      take(p);
    }
    g.people = picked.sort(
      (a, b) =>
        b.dir_score - a.dir_score ||
        b.tickers.length - a.tickers.length ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    const linked = new Set(g.people.flatMap((p) => p.tickers));
    g.outside = outside.filter((o) => linked.has(o.ticker));
    const listingKeys = new Set<string>();
    for (const c of g.companies) listingKeys.add(c.ticker.toUpperCase());
    for (const p of g.people) {
      for (const t of p.tickers) listingKeys.add(t.toUpperCase());
    }
    g.listings = [...listingKeys]
      .map((t) => metaByTicker.get(t) ?? listingMeta.get(t))
      .filter((row): row is GovFamilyCompany => Boolean(row))
      .map((row) => ({
        ticker: row.ticker,
        name: row.name,
        cap_code: row.cap_code,
        market_cap_cr: row.market_cap_cr ?? null,
      }));
  }

  const editMap = loadFamilyGroupEditMap();
  const byLabel = new Map<string, GovFamilyGroup[]>();
  for (const g of groups) {
    const key =
      canonicalHouseLabel(g.family_name) ||
      g.family_name.toLowerCase().replace(/\s+/g, " ").trim();
    const list = byLabel.get(key) ?? [];
    list.push(g);
    byLabel.set(key, list);
  }
  for (const list of byLabel.values()) {
    if (list.length < 2) continue;
    const host = list[0]!;
    for (const g of list.slice(1)) {
      if (!groupsShareControl(host, g)) continue;
      if (
        editMap.has(host.group_id || "") ||
        editMap.has(g.group_id || "")
      ) {
        continue;
      }
      for (const c of g.companies) {
        if (host.companies.some((x) => x.ticker === c.ticker)) continue;
        host.companies.push(c);
      }
      g.companies = [];
    }
    host.company_count = host.companies.length;
  }

  const distinctiveFamilyLabel = (
    g: GovFamilyGroup,
    others: GovFamilyGroup[],
  ): string | null => {
    const otherDeclared = new Set<string>();
    for (const o of others) {
      for (const c of o.companies) {
        const raw = declaredByTicker.get(c.ticker) || "";
        const key = declaredMergeKey(raw) || raw.trim().toLowerCase();
        if (key) otherDeclared.add(key);
      }
    }
    const declaredVotes = new Map<string, number>();
    for (const c of g.companies) {
      const raw = declaredByTicker.get(c.ticker) || "";
      const key = declaredMergeKey(raw) || raw.trim().toLowerCase();
      if (!key || otherDeclared.has(key)) continue;
      const shown = displayGroupLabel(key);
      if (canonicalHouseLabel(shown) === canonicalHouseLabel(g.family_name)) {
        continue;
      }
      declaredVotes.set(key, (declaredVotes.get(key) ?? 0) + 1);
    }
    const topDeclared = [...declaredVotes.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0];
    if (topDeclared) return displayGroupLabel(topDeclared[0]);

    const otherBlob = others
      .flatMap((o) =>
        o.companies.map(
          (c) => `${c.name} ${declaredByTicker.get(c.ticker) || ""}`,
        ),
      )
      .join(" ")
      .toLowerCase();
    const skip = new Set(
      houseContentTokens(g.family_name).map((w) => w.toLowerCase()),
    );
    const tokVotes = new Map<string, number>();
    for (const c of g.companies) {
      for (const tok of houseTokensFromName(c.name)) {
        const w = tok.toLowerCase();
        if (skip.has(w) || HOUSE_SKIP.has(w)) continue;
        if (otherBlob.includes(w)) continue;
        tokVotes.set(tok, (tokVotes.get(tok) ?? 0) + 1);
      }
    }
    const topTok = [...tokVotes.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0];
    if (topTok) return `${g.family_name} · ${topTok[0]}`;
    const lead = houseTokensFromName(g.companies[0]?.name || "")[0];
    if (lead && !skip.has(lead.toLowerCase())) {
      return `${g.family_name} · ${lead}`;
    }
    return null;
  };

  const remainingByCanon = new Map<string, GovFamilyGroup[]>();
  for (const g of groups) {
    if (g.companies.length < 1) continue;
    const key =
      canonicalHouseLabel(g.family_name) ||
      g.family_name.toLowerCase().replace(/\s+/g, " ").trim();
    const list = remainingByCanon.get(key) ?? [];
    list.push(g);
    remainingByCanon.set(key, list);
  }
  for (const list of remainingByCanon.values()) {
    if (list.length < 2) continue;
    for (const g of list) {
      if (editMap.get(g.group_id || "")?.label) continue;
      const next = distinctiveFamilyLabel(
        g,
        list.filter((x) => x !== g),
      );
      if (next) g.family_name = next;
    }
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    if (g.companies.length < 1) {
      if (!editMap.get(g.group_id || "")?.label) groups.splice(i, 1);
      continue;
    }
    if (g.companies.length < 2 && !editMap.has(g.group_id || "")) {
      groups.splice(i, 1);
    }
  }

  const q = qNeedle;
  let out = groups;
  if (q) {
    out = groups
      .map((g) => {
        const nameHit = g.family_name.toLowerCase().includes(q);
        const companies = g.companies.filter(
          (c) =>
            tickerMatchesSearch(c.ticker, q) ||
            c.name.toLowerCase().includes(q),
        );
        if (nameHit) return g;
        if (!companies.length) return null;
        return {
          ...g,
          companies,
          company_count: companies.length,
        };
      })
      .filter((g): g is GovFamilyGroup => Boolean(g && g.company_count >= 1));
  }

  for (const g of out) {
    g.companies.sort((a, b) => {
      const am = a.market_cap_cr ?? -1;
      const bm = b.market_cap_cr ?? -1;
      if (bm !== am) return bm - am;
      return a.ticker.localeCompare(b.ticker);
    });
  }
  out.sort((a, b) => {
    if (b.company_count !== a.company_count) return b.company_count - a.company_count;
    return a.family_name.localeCompare(b.family_name, undefined, {
      sensitivity: "base",
    });
  });
  if (!opts?.hold && !qNeedle) {
    familyMapCache = { at: Date.now(), groups: out };
  }
  scheduleFamilyGroupRefine(
    out.map((g, i) => ({
      id: `g${i}`,
      label: g.family_name,
      companies: g.companies.map((c) => ({
        ticker: c.ticker,
        name: c.name,
        group_name: groupNames.get(c.ticker) || g.family_name,
      })),
    })),
  );
  return out;
}

function loadMultiBoardSeats(minBoards: number): SeatRow[] {
  const min = Math.max(1, minBoards);
  const db = getGov();
  return db
    .prepare(
      `
      ${SEAT_SELECT}
        AND d.person_id IN (
          SELECT s2.person_id
          FROM board_seats s2
          JOIN companies c2 ON c2.ticker = s2.ticker
          WHERE UPPER(c2.market) IN ('NSE', 'NSE SME', 'BSE', 'BSE SME')
          GROUP BY s2.person_id
          HAVING COUNT(DISTINCT s2.ticker) >= ?
        )
      ORDER BY d.name COLLATE NOCASE, c.name COLLATE NOCASE
      `,
    )
    .all(min) as SeatRow[];
}

/**
 * Directors linked to a company (ticker/name) or matching DIN/name —
 * includes single-board directors so company search works.
 */
export function tickerMatchesSearch(ticker: string, q: string): boolean {
  const t = ticker.trim().toLowerCase();
  const n = q.trim().toLowerCase();
  if (!t || !n) return false;
  return t === n || t.startsWith(n);
}

function loadSeatsForSearchQuery(q: string): SeatRow[] {
  const term = q.trim();
  if (!term) return [];
  const needle = term.toLowerCase();
  const like = `%${needle}%`;
  const db = getGov();
  return db
    .prepare(
      `
      ${SEAT_SELECT}
        AND d.person_id IN (
          SELECT DISTINCT d2.person_id
          FROM directors d2
          LEFT JOIN board_seats s2 ON s2.person_id = d2.person_id
          LEFT JOIN companies c2 ON c2.ticker = s2.ticker
            AND UPPER(c2.market) IN ('NSE', 'NSE SME', 'BSE', 'BSE SME')
          WHERE LOWER(d2.name) LIKE ?
             OR (d2.din IS NOT NULL AND LOWER(d2.din) LIKE ?)
             OR (c2.ticker IS NOT NULL AND (
               LOWER(c2.ticker) = ? OR LOWER(c2.ticker) LIKE ?
             ))
             OR (c2.name IS NOT NULL AND LOWER(c2.name) LIKE ?)
        )
      ORDER BY d.name COLLATE NOCASE, c.name COLLATE NOCASE
      `,
    )
    .all(like, like, needle, `${needle}%`, like) as SeatRow[];
}

function loadSeatsForTickers(tickers: string[]): SeatRow[] {
  const keys = [
    ...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)),
  ];
  if (!keys.length) return [];
  if (!fs.existsSync(path.join(SQLITE_DATA_DIR, "governance.db"))) return [];
  const db = getGov();
  const out: SeatRow[] = [];
  const chunk = 200;
  for (let i = 0; i < keys.length; i += chunk) {
    const slice = keys.slice(i, i + chunk);
    const placeholders = slice.map(() => "?").join(",");
    const rows = db
      .prepare(
        `
        ${SEAT_SELECT}
          AND d.person_id IN (
            SELECT DISTINCT s2.person_id
            FROM board_seats s2
            WHERE UPPER(s2.ticker) IN (${placeholders})
          )
        ORDER BY d.name COLLATE NOCASE, c.name COLLATE NOCASE
        `,
      )
      .all(...slice) as SeatRow[];
    out.push(...rows);
  }
  return out;
}

export type StockBoardNetwork = {
  ticker: string;
  name: string;
  market: string;
  companies: GovCompanySeat[];
  people: Array<{
    person_id: string;
    name: string;
    din: string | null;
    tickers: string[];
    dir_score: number;
  }>;
};

/** Ego graph: directors on this ticker plus every other listed board they sit on. */
export function loadStockBoardNetwork(
  raw: string,
): StockBoardNetwork | null {
  const ticker = raw.trim().toUpperCase();
  if (!ticker) return null;
  const seats = loadSeatsForTickers([ticker]);
  const rows = buildRowsFromSeats(seats, 1);
  if (!rows.length) return null;
  const people = rows.map((r) => ({
    person_id: r.person_id,
    name: r.name,
    din: r.din,
    tickers: r.companies.map((c) => c.ticker),
    dir_score: r.dir_score,
  }));
  const byCo = new Map<string, GovCompanySeat>();
  let focal: GovCompanySeat | null = null;
  for (const r of rows) {
    for (const c of r.companies) {
      const key = c.ticker.toUpperCase();
      if (!byCo.has(key)) byCo.set(key, c);
      if (key === ticker) focal = c;
    }
  }
  if (!focal) return null;
  const rest = [...byCo.values()]
    .filter((c) => c.ticker.toUpperCase() !== ticker)
    .sort((a, b) => {
      const am = a.market_cap_cr ?? -1;
      const bm = b.market_cap_cr ?? -1;
      if (bm !== am) return bm - am;
      return a.ticker.localeCompare(b.ticker);
    });
  return {
    ticker: focal.ticker,
    name: focal.name,
    market: focal.market,
    companies: [focal, ...rest],
    people,
  };
}

export function loadAboutMap(tickers: string[]): Map<string, AboutBits> {
  const map = new Map<string, AboutBits>();
  const db = getAbout();
  if (!db || tickers.length === 0) return map;

  const chunk = 400;
  for (let i = 0; i < tickers.length; i += chunk) {
    const slice = tickers.slice(i, i + chunk);
    const placeholders = slice.map(() => "?").join(",");
    let rows: Array<{
      ticker: string;
      name: string | null;
      website: string | null;
      about: string | null;
      yf_about: string | null;
      scraped_about: string | null;
      products: string | null;
      end_markets: string | null;
      headquarters: string | null;
      company_sector: string | null;
      company_industry: string | null;
    }>;
    try {
      rows = db
        .prepare(
          `
        SELECT ticker, name, website, about, yf_about, scraped_about,
               products, end_markets, headquarters,
               company_sector, company_industry
        FROM company_about
        WHERE UPPER(ticker) IN (${placeholders})
        `,
        )
        .all(...slice.map((t) => t.toUpperCase())) as typeof rows;
    } catch (err) {
      console.error("[governance-map] company_about read failed:", err);
      try {
        aboutDb?.close();
      } catch {
        /* ignore */
      }
      aboutDb = null;
      return map;
    }
    for (const r of rows) {
      const about = pickAboutText(r);
      map.set(r.ticker.toUpperCase(), {
        name: r.name,
        website: r.website,
        about,
        products: r.products?.trim() || null,
        end_markets: r.end_markets?.trim() || null,
        headquarters: r.headquarters?.trim() || null,
        sector: r.company_sector || r.company_industry || null,
        industry: r.company_industry || null,
      });
    }
  }
  return map;
}

function buildRowsFromSeats(
  seats: SeatRow[],
  minBoards: number,
): GovernanceMapRow[] {
  if (seats.length === 0) return [];

  const byPerson = new Map<string, SeatRow[]>();
  for (const seat of seats) {
    const list = byPerson.get(seat.person_id) ?? [];
    list.push(seat);
    byPerson.set(seat.person_id, list);
  }

  const allTickers = [
    ...new Set(seats.map((s) => s.ticker.toUpperCase()).filter(Boolean)),
  ];
  const metrics = loadMetricsMap();
  const breakouts = loadBreakoutMap();
  const holdings = holdingsTickerSet();
  const edge = edgeTickerSet();
  const abouts = loadAboutMap(allTickers);

  const rows: GovernanceMapRow[] = [];

  for (const [personId, grp] of byPerson) {
    const companies: GovCompanySeat[] = [];
    for (const seat of grp) {
      const ticker = seat.ticker.toUpperCase();
      if (!ticker) continue;
      let market = (seat.market || "NSE").toUpperCase();
      const isSme = market === "NSE SME" || market === "BSE SME";
      if (market === "NSE SME" || market === "BSE SME") {
        /* keep SME market label */
      } else if (market.startsWith("NSE")) {
        market = "NSE";
      } else if (market.startsWith("BSE")) {
        market = "BSE";
      }

      const m = metrics.get(ticker);
      const mcap = m?.market_cap_cr ?? null;
      const price = m?.price ?? null;
      const about = abouts.get(ticker);
      const bo = breakouts.get(ticker);
      const links = researchLinks(ticker, market, about?.website ?? null);

      companies.push({
        ticker,
        name: seat.company_name || about?.name || ticker,
        market,
        designation: seat.designation || "",
        category: seat.category,
        source: seat.source,
        as_of: seat.as_of,
        market_cap_cr: mcap,
        price,
        cap_code: mcapCapCode(mcap),
        cap_label: mcapCapLabel(mcap),
        website: about?.website ?? null,
        about: about?.about ?? null,
        about_search: [
          about?.headquarters,
          about?.about,
          about?.products,
          about?.end_markets,
          about?.headquarters,
        ]
          .filter(Boolean)
          .join(" \n "),
        headquarters: about?.headquarters ?? null,
        sector: about?.sector ?? m?.sector ?? null,
        industry: about?.industry ?? null,
        is_sme: isSme,
        is_main: !isSme && market === "NSE",
        has_bb: Boolean(bo?.has_bb),
        has_bb_w: Boolean(bo?.has_bb_w),
        has_bb_m: Boolean(bo?.has_bb_m),
        has_tq: Boolean(bo?.has_tq),
        has_hold: holdings.has(ticker),
        has_edge: edge.has(ticker),
        fund_tags: fundTagsForTicker(ticker),
        fund_changes: fundChangesForTicker(ticker),
        web: links.web,
        sc: links.sc,
        tv: links.tv,
      });
    }

    const uniqueTickers = new Set(companies.map((c) => c.ticker));
    if (uniqueTickers.size < minBoards) continue;

    const din = grp[0]?.din?.trim() || null;
    const director = grp[0]?.director_name || "";
    const scored = scoreDirectorSeats(companies, {
      personId,
      din,
    });

    let smeN = 0;
    let mainN = 0;
    for (const c of companies) {
      if (c.is_sme) smeN += 1;
      else if (c.is_main) mainN += 1;
    }

    rows.push({
      person_id: personId,
      din,
      name: director,
      board_count: scored.board_count,
      dir_score: scored.dir_score,
      din_backed: scored.din_backed,
      name_collision: scored.name_collision,
      nameless_din: Boolean(din) && isPlaceholderDirectorName(director),
      big_n: scored.big_n,
      small_n: scored.small_n,
      tiny_n: scored.tiny_n,
      ti_n: scored.ti_n,
      lc_n: scored.lc_n,
      bridge: scored.bridge,
      tiny_bridge: scored.tiny_bridge,
      ti_bridge: scored.ti_bridge,
      multi_lc: scored.multi_lc,
      sme_n: smeN,
      main_n: mainN,
      sme_cross: smeN >= 1 && mainN >= 1,
      tickers: companies.map((c) => c.ticker).join(", "),
      companies,
      score_breakdown: scored,
    });
  }

  rows.sort((a, b) => {
    if (b.dir_score !== a.dir_score) return b.dir_score - a.dir_score;
    if (b.board_count !== a.board_count) return b.board_count - a.board_count;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return rows;
}

function buildRows(minBoards: number): GovernanceMapRow[] {
  return buildRowsFromSeats(loadMultiBoardSeats(minBoards), minBoards);
}

export function invalidateGovernanceMapCache(): void {
  mapCache = null;
  boardScoreCache = null;
  familyMapCache = null;
  closeGovReader();
}

/** Directors with a DIN whose stored name is only "DIN ########". */
export function countNamelessDinDirectors(): number {
  if (!fs.existsSync(path.join(SQLITE_DATA_DIR, "governance.db"))) return 0;
  try {
    const row = getGov()
      .prepare(
        `
        SELECT COUNT(DISTINCT d.person_id) AS n
        FROM directors d
        JOIN board_seats s ON s.person_id = d.person_id
        JOIN companies c ON c.ticker = s.ticker
        WHERE TRIM(COALESCE(d.din, '')) != ''
          AND UPPER(c.market) IN ('NSE', 'NSE SME', 'BSE', 'BSE SME')
          AND lower(trim(d.name)) GLOB 'din [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
        `,
      )
      .get() as { n: number };
    return Number(row?.n) || 0;
  } catch {
    return 0;
  }
}

export function loadGovernanceMap(opts?: {
  minBoards?: number;
  refresh?: boolean;
  /** When set, search directors + companies (incl. single-board). */
  q?: string;
}): GovernanceMapRow[] {
  const minBoards = opts?.minBoards ?? 2;
  const q = (opts?.q || "").trim();
  const now = Date.now();

  if (!fs.existsSync(path.join(SQLITE_DATA_DIR, "governance.db"))) {
    return [];
  }

  if (q) {
    // Company / director search: include 1-board directors so tickers resolve.
    return buildRowsFromSeats(loadSeatsForSearchQuery(q), 1);
  }

  if (
    !opts?.refresh &&
    mapCache &&
    now - mapCache.at < CACHE_MS &&
    minBoards === 2
  ) {
    return mapCache.rows;
  }

  const rows = buildRows(minBoards);
  if (minBoards === 2) {
    mapCache = { at: now, rows };
  }
  return rows;
}

/** Ticker → board reputation (pledged outside network), same as Governance Companies. */
export function loadCompanyBoardScoreMap(opts?: {
  refresh?: boolean;
}): Map<string, number> {
  const now = Date.now();
  if (
    !opts?.refresh &&
    boardScoreCache &&
    now - boardScoreCache.at < CACHE_MS
  ) {
    return boardScoreCache.map;
  }

  const map = boardScoresFromDirectorRows(
    loadGovernanceMap({ minBoards: 2, refresh: opts?.refresh }),
  );
  boardScoreCache = { at: now, map };
  return map;
}

function boardScoresFromDirectorRows(
  rows: GovernanceMapRow[],
): Map<string, number> {
  const byTicker = new Map<
    string,
    Array<{
      pledged_score: number;
      designation: string | null;
      category: string | null;
    }>
  >();

  for (const r of rows) {
    for (const c of r.companies) {
      const key = c.ticker.toUpperCase();
      const otherSeats = r.companies.filter(
        (x) => x.ticker.toUpperCase() !== key,
      );
      const pledged = pledgedDirectorScore({
        otherSeats,
        personId: r.person_id,
        din: r.din,
      });
      let list = byTicker.get(key);
      if (!list) {
        list = [];
        byTicker.set(key, list);
      }
      list.push({
        pledged_score: pledged,
        designation: c.designation,
        category: c.category,
      });
    }
  }

  const map = new Map<string, number>();
  for (const [ticker, directors] of byTicker) {
    map.set(ticker, scoreCompanyBoard(directors));
  }
  return map;
}

/** Scores for a ticker list (includes single-board directors when needed). */
export function companyBoardScoresForTickers(
  tickers: string[],
): Map<string, number> {
  const want = [
    ...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)),
  ];
  const out = new Map<string, number>();
  if (!want.length) return out;

  const extra = boardScoresFromDirectorRows(
    buildRowsFromSeats(loadSeatsForTickers(want), 1),
  );
  for (const t of want) {
    const hit = extra.get(t);
    if (hit != null) out.set(t, hit);
  }
  return out;
}

export type GovernanceMapStats = {
  directors: number;
  din_backed: number;
  name_only: number;
  nameless_din: number;
  bridges: number;
  tiny_bridges: number;
  ti_bridges: number;
  multi_lc: number;
  sme_cross: number;
  companies: number;
  hold: number;
  edge: number;
  pattern: number;
  funds: Partial<Record<FundWatchlistKey, number>>;
  caps: {
    NC: number;
    TI: number;
    MIC: number;
    SC: number;
    MC: number;
    LC: number;
  };
};

export function governanceMapStats(
  rows: GovernanceMapRow[],
): GovernanceMapStats {
  const tickers = new Set<string>();
  const holdTickers = new Set<string>();
  const edgeTickers = new Set<string>();
  const patternTickers = new Set<string>();
  const fundTickers = Object.fromEntries(
    FUND_WATCHLIST_KEYS.map((k) => [k, new Set<string>()]),
  ) as Record<FundWatchlistKey, Set<string>>;
  const capTickers = {
    NC: new Set<string>(),
    TI: new Set<string>(),
    MIC: new Set<string>(),
    SC: new Set<string>(),
    MC: new Set<string>(),
    LC: new Set<string>(),
  };
  let dinBacked = 0;
  let namelessDin = 0;
  let bridges = 0;
  let tinyBridges = 0;
  let tiBridges = 0;
  let multiLc = 0;
  let smeCross = 0;
  for (const r of rows) {
    if (r.din_backed) dinBacked += 1;
    if (r.nameless_din) namelessDin += 1;
    if (r.bridge) bridges += 1;
    if (r.tiny_bridge) tinyBridges += 1;
    if (r.ti_bridge) tiBridges += 1;
    if (r.multi_lc) multiLc += 1;
    if (r.sme_cross) smeCross += 1;
    const hasPattern = companyHasGovernancePattern(r.companies);
    for (const c of r.companies) {
      tickers.add(c.ticker);
      if (c.has_hold) holdTickers.add(c.ticker);
      if (c.has_edge) edgeTickers.add(c.ticker);
      if (hasPattern) patternTickers.add(c.ticker);
      for (const k of c.fund_tags ?? []) fundTickers[k]?.add(c.ticker);
      const code = (c.cap_code || "NC").toUpperCase();
      if (code in capTickers) {
        capTickers[code as keyof typeof capTickers].add(c.ticker);
      } else {
        capTickers.NC.add(c.ticker);
      }
    }
  }
  const funds = Object.fromEntries(
    FUND_WATCHLIST_KEYS.map((k) => [k, fundTickers[k].size]),
  ) as Partial<Record<FundWatchlistKey, number>>;
  return {
    directors: rows.length,
    din_backed: dinBacked,
    name_only: rows.length - dinBacked,
    nameless_din: namelessDin,
    bridges,
    tiny_bridges: tinyBridges,
    ti_bridges: tiBridges,
    multi_lc: multiLc,
    sme_cross: smeCross,
    companies: tickers.size,
    hold: holdTickers.size,
    edge: edgeTickers.size,
    pattern: patternTickers.size,
    funds,
    caps: {
      NC: capTickers.NC.size,
      TI: capTickers.TI.size,
      MIC: capTickers.MIC.size,
      SC: capTickers.SC.size,
      MC: capTickers.MC.size,
      LC: capTickers.LC.size,
    },
  };
}
