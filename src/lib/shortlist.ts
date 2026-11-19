import { inactiveListingTickers } from "./listing-sync";
import { masterLabels } from "./stock-master";
import { zaubaUrl } from "./momentum";
import { buildStock, loadCtx, markTried, recentlyTried, type FillResult, type NanoStock } from "./nanocap-champs";
import { fetchScreenerPlAndBs } from "./screener-annual";
import { screenerPausedUntil } from "./screener-fetch";
import { loadInvestors } from "./smart-entities";
import { loadSmartMap, type Move } from "./smart-money";
import { openSqliteNamed } from "./sqlite-utils";

/**
 * Shortlist: the Goldiam / Sanghvi Movers process as a screen (₹100–6,000 Cr).
 *   1. Theme + small size   — sector in a trend you believe in, ₹100–6,000 Cr
 *   2. Trust                — board quality from the director network (who sits with whom)
 *   3. Safety               — profitable, pays tax, debt in check, not under GSM / insolvency
 *   4. Cheap + happening    — P/E vs sector, strong director joins, buybacks, profit jumps
 * Past growth is not required (both picks were bought before the numbers showed it).
 */

export const SHORTLIST_RULES = {
  minMcapCr: 100,
  maxMcapCr: 6000,
  topN: 80,
  /** Board events newer than this count as "happening". */
  eventDays: 180,
  buybackDays: 365,
  /** Mid/large board: a director who also sits here brings big-company experience. */
  bigBoardCr: 5000,
  /** More listed boards than this = stretched thin (law caps independents at 7). */
  overboarded: 7,
} as const;

/**
 * Trends to pick from. Matched on industry / sub-sector / sector text; a stock
 * can sit in several. Every stock gets at least one — "other" catches the rest.
 */
export const THEMES: ReadonlyArray<{ id: string; label: string; match: RegExp }> = [
  {
    id: "premium",
    label: "Premiumization",
    match:
      /jewel|precious metal|watches|apparel|footwear|luxury|hotels|resorts|alcoholic|consumer durables|consumer electronics|home electronics|home furnishing|furnishings|housewares|personal products|restaurants|leisure|paints|ceramics|laminates|retail - speciality|retail - apparel|retail - department|retailing/i,
  },
  {
    id: "infra",
    label: "Infrastructure",
    match:
      /construction|engineering|roads|cement|heavy machinery|industrial machinery|pipes|prefab|building products|power infrastructure|transmission|\brail\b|ports|airports|dredging|cables|heavy electrical|water management|infrastructure|metal fabrication|farm & heavy|iron & steel|ferrous|trucks & buses/i,
  },
  { id: "defence", label: "Defence", match: /aerospace|defen[cs]e|shipbuilding/i },
  {
    id: "power",
    label: "Power & renewables",
    match: /renewable|power generation|power trading|transmission|\bpower\b|solar|batteries|heavy electrical|electrical equipment|utilities/i,
  },
  {
    id: "mfg",
    label: "Manufacturing (China+1)",
    match:
      /chemicals|petrochemicals|electronic|electrical components|auto parts|auto components|industrial products|industrial manufacturing|semiconductor|technology hardware|telecom equipment|packaging|plastic products|textile|tires & rubber|castings|forgings/i,
  },
  {
    id: "auto",
    label: "Auto & EV",
    match: /wheelers|automobiles|auto parts|auto components|tires & rubber|trucks & buses|tractors|cycles|batteries/i,
  },
  {
    id: "health",
    label: "Healthcare",
    match: /pharma|hospital|diagnostic|health ?care|labs & life|biotech|medical|wellness/i,
  },
  {
    id: "fin",
    label: "Financials",
    match:
      /financ|banks|asset management|capital markets|brokerage|stock exchanges|insurance|payment|credit services/i,
  },
  {
    id: "staples",
    label: "FMCG & food",
    match: /fmcg|foods?\b|packaged foods|food products|tea & coffee|beverages|tobacco|household products|consumer staples|soft drinks/i,
  },
  {
    id: "agri",
    label: "Agri & rural",
    match: /agro|agricultur|sugar|seeds|fertili[sz]er|tea & coffee|\btea\b|plantation|tractors|farm/i,
  },
  {
    id: "commod",
    label: "Metals & commodities",
    match:
      /iron & steel|ferrous|metals|aluminium|aluminum|copper|\blead\b|zinc|mining|coal|paper|wood|jute|commodit|minerals/i,
  },
  { id: "energy", label: "Oil & gas", match: /oil & gas|\boil\b|petroleum|gas distribution|consumable fuels|refining/i },
  {
    id: "tech",
    label: "Tech & digital",
    match: /\bit\b|it -|software|outsourced|online|communication & networking|technology|internet|e-commerce|retail - online/i,
  },
  {
    id: "media",
    label: "Media & entertainment",
    match: /advertising|publishing|movies|radio|cable & d2h|tv channels|broadcast|animation|entertainment|media|theatres|printing/i,
  },
  {
    id: "realty",
    label: "Real estate & housing",
    match: /real estate|realty|residential|home financing|building products/i,
  },
  {
    id: "services",
    label: "Services",
    match: /business support|employment|commercial services|education|academic|environmental|consumer services|outsourced|stationery/i,
  },
  {
    id: "travel",
    label: "Travel & leisure",
    match: /hotels|tour & travel|airlines|airports|leisure|theme parks|restaurants|theatres/i,
  },
  { id: "logistics", label: "Logistics", match: /logistics|transport services|ports|\brail\b|shipping/i },
  { id: "other", label: "Other", match: /$^/ },
];

function themesFor(hay: string): string[] {
  const ids = THEMES.filter((th) => th.id !== "other" && th.match.test(hay)).map((th) => th.id);
  return ids.length ? ids : ["other"];
}

export type Check = { id: "watch" | "profit" | "tax" | "debt"; ok: boolean | null; note: string };

export type ShortlistRow = {
  ticker: string;
  name: string;
  market: string;
  mcap_cr: number | null;
  pe: number | null;
  sector: string | null;
  sub_sector: string | null;
  industry: string | null;
  website: string | null;
  group: string | null;
  zauba_url: string | null;
  themes: string[];
  /** 0–100 each; null = no data. */
  trust: number | null;
  cheap: number | null;
  events: number;
  quality: number | null;
  /** Recent growth: sales and profit on last year's quarter (0–100). */
  growth: number | null;
  /** Value style: trust, cheapness, events. */
  score: number;
  /** Growth style: trust, quality, growth (Listed Ventures kind). */
  score_growth: number;
  board: number;
  independent: number;
  /** Directors who also sit on a ₹5,000 Cr+ board, with one example board each. */
  big_links: Array<{ name: string; board: string }>;
  /** Average ROCE (%) of the other listed boards these directors sit on. */
  linked_roce: number | null;
  red_flags: string[];
  checks: Check[];
  happenings: string[];
  roce: number | null;
  sales_cagr_5y: number | null;
  opm_range: [number, number] | null;
  sector_pe: number | null;
  /** Tracked investors (Smart Money tab) holding it, with this quarter's move. */
  smart: Array<{ label: string; pct: number | null; move: Move }>;
};

export type ShortlistPage = {
  rows: ShortlistRow[];
  themes: Array<{ id: string; label: string }>;
  rules: typeof SHORTLIST_RULES;
  counts: {
    universe: number;
    no_board: number;
    failed_safety: number;
    shown: number;
    need_fill: number;
  };
  paused_until: string | null;
  /** Listed Ventures (Lotusdew) holdings — to check the screen against. */
  lv: { current: string[]; past: string[] };
  computed_at: string;
};

const pctile = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function cagr(series: Array<number | null>, years: number): number | null {
  const vals = series.filter((v): v is number => v != null && Number.isFinite(v));
  if (vals.length < years + 1) return null;
  const end = vals[vals.length - 1]!;
  const start = vals[vals.length - 1 - years]!;
  if (start <= 0 || end <= 0) return null;
  return (Math.pow(end / start, 1 / years) - 1) * 100;
}

function monthLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" })
    : iso.slice(0, 7);
}

type Seat = { person: string; designation: string; category: string };

const KMP_SQL = `NOT (LOWER(COALESCE(category, '') || ' ' || designation) LIKE '%kmp%'
  OR LOWER(COALESCE(category, '') || ' ' || designation) LIKE '%cfo%'
  OR LOWER(designation) LIKE '%chief financial%'
  OR LOWER(designation) LIKE '%company secretary%'
  OR LOWER(TRIM(COALESCE(category, ''))) = 'cs'
  OR LOWER(TRIM(designation)) = 'cs')`;

function isIndependent(designation: string | null, category: string | null): boolean {
  const d = (designation || "").toLowerCase();
  if (d.includes("non independent") || d.includes("non-independent")) return false;
  return d.includes("independent") || (category || "").toLowerCase() === "independent";
}

type Gov = {
  seats: Map<string, Seat[]>;
  boardsOf: Map<string, Set<string>>;
  names: Map<string, string>;
  cins: Map<string, string>;
  joins: Map<string, Array<{ person: string; name: string; at: string }>>;
  indResigns: Map<string, number>;
};

function loadGov(): Gov {
  const seats = new Map<string, Seat[]>();
  const boardsOf = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  const cins = new Map<string, string>();
  const joins = new Map<string, Array<{ person: string; name: string; at: string }>>();
  const indResigns = new Map<string, number>();
  const db = openSqliteNamed("governance.db", { readonly: true, wal: true });
  try {
    for (const r of db
      .prepare(
        `SELECT UPPER(ticker) AS t, person_id AS p, designation AS d, COALESCE(category, '') AS c
         FROM board_seats WHERE ${KMP_SQL}`,
      )
      .all() as Array<{ t: string; p: string; d: string; c: string }>) {
      if (!seats.has(r.t)) seats.set(r.t, []);
      seats.get(r.t)!.push({ person: r.p, designation: r.d, category: r.c });
      if (!boardsOf.has(r.p)) boardsOf.set(r.p, new Set());
      boardsOf.get(r.p)!.add(r.t);
    }
    for (const r of db.prepare(`SELECT person_id AS p, name FROM directors`).all() as Array<{
      p: string;
      name: string;
    }>)
      names.set(r.p, r.name);
    for (const r of db
      .prepare(`SELECT UPPER(ticker) AS t, cin FROM companies WHERE TRIM(COALESCE(cin, '')) != ''`)
      .all() as Array<{ t: string; cin: string }>)
      cins.set(r.t, r.cin);
    // The first scan day logged every existing seat as a change — skip it.
    const first = (
      db.prepare(`SELECT MIN(substr(detected_at, 1, 10)) AS d FROM board_seat_events`).get() as {
        d: string | null;
      }
    ).d;
    const since = new Date(Date.now() - SHORTLIST_RULES.eventDays * 86_400_000).toISOString();
    for (const r of db
      .prepare(
        `SELECT UPPER(ticker) AS t, person_id AS p, director_name AS n, event_type AS e,
                old_designation AS od, old_category AS oc, detected_at AS at
         FROM board_seat_events
         WHERE detected_at >= ? AND substr(detected_at, 1, 10) > ?`,
      )
      .all(since, first ?? "") as Array<{
      t: string;
      p: string;
      n: string;
      e: string;
      od: string | null;
      oc: string | null;
      at: string;
    }>) {
      if (r.e === "joined") {
        if (!joins.has(r.t)) joins.set(r.t, []);
        joins.get(r.t)!.push({ person: r.p, name: r.n, at: r.at });
      } else if (r.e === "resigned" && isIndependent(r.od, r.oc)) {
        indResigns.set(r.t, (indResigns.get(r.t) ?? 0) + 1);
      }
    }
  } finally {
    db.close();
  }
  return { seats, boardsOf, names, cins, joins, indResigns };
}

function loadIndustry(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [t, m] of masterLabels()) if (m.industry) out.set(t, m.industry);
  const db = openSqliteNamed("classifications.db", { readonly: true, wal: true });
  try {
    for (const r of db
      .prepare(`SELECT UPPER(ticker) AS t, industry FROM classifications WHERE TRIM(COALESCE(industry, '')) != ''`)
      .all() as Array<{ t: string; industry: string }>)
      if (!out.has(r.t)) out.set(r.t, r.industry);
  } finally {
    db.close();
  }
  return out;
}

type Annual = {
  roce: Map<string, number>;
  sales5: Map<string, number>;
  pl: Map<string, { tax: Array<number | null>; pbt: Array<number | null>; opm: number[] }>;
  debt: Map<string, number>;
  /** Tickers the fill already tried (cached or blocked). */
  tried: Set<string>;
};

function loadAnnual(): Annual {
  const roce = new Map<string, number>();
  const sales5 = new Map<string, number>();
  const pl = new Map<string, { tax: Array<number | null>; pbt: Array<number | null>; opm: number[] }>();
  const debt = new Map<string, number>();
  const tried = new Set<string>();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  const each = <T>(sql: string, fn: (t: string, j: T) => void) => {
    try {
      for (const r of db.prepare(sql).all() as Array<{ t: string; j: string }>) {
        tried.add(r.t);
        try {
          fn(r.t, JSON.parse(r.j) as T);
        } catch {
          /* bad row */
        }
      }
    } catch {
      /* table missing */
    }
  };
  try {
    each<{ sales: Array<number | null>; roce: Array<number | null> }>(
      `SELECT UPPER(ticker) AS t, annual_json AS j FROM screener_annual_cache`,
      (t, j) => {
        const last = [...(j.roce ?? [])].reverse().find((v) => v != null);
        if (last != null) roce.set(t, last);
        const c = cagr(j.sales ?? [], 5);
        if (c != null) sales5.set(t, c);
      },
    );
    tried.clear();
    each<{ revenue: Array<number | null>; operating_profit: Array<number | null>; tax: Array<number | null>; pbt: Array<number | null> }>(
      `SELECT UPPER(ticker) AS t, pl_json AS j FROM screener_annual_pl_cache`,
      (t, j) => {
        const opm: number[] = [];
        (j.revenue ?? []).forEach((rev, i) => {
          const op = j.operating_profit?.[i];
          if (rev != null && rev > 0 && op != null) opm.push((op / rev) * 100);
        });
        pl.set(t, { tax: j.tax ?? [], pbt: j.pbt ?? [], opm });
      },
    );
    const plTried = new Set(tried);
    tried.clear();
    each<{ borrowings: Array<number | null>; book_value: Array<number | null> }>(
      `SELECT UPPER(ticker) AS t, bs_json AS j FROM screener_annual_bs_cache`,
      (t, j) => {
        const b = [...(j.borrowings ?? [])].reverse().find((v) => v != null);
        const bv = [...(j.book_value ?? [])].reverse().find((v) => v != null);
        if (b != null && bv != null && bv > 0) debt.set(t, b / bv);
      },
    );
    // "Tried" = both caches have a row (data or a block marker).
    for (const t of [...tried]) if (!plTried.has(t)) tried.delete(t);
  } finally {
    db.close();
  }
  return { roce, sales5, pl, debt, tried };
}

function loadWatchlisted(): Map<string, string> {
  const out = new Map<string, string>();
  const db = openSqliteNamed("metrics.db", { readonly: true, wal: true });
  try {
    for (const r of db
      .prepare(`SELECT UPPER(symbol) AS t, list, COALESCE(stage, '') AS s FROM nse_surveillance`)
      .all() as Array<{ t: string; list: string; s: string }>) {
      if (r.list === "GSM" || /IBC/i.test(r.s)) out.set(r.t, /IBC/i.test(r.s) ? "insolvency (IBC)" : `GSM ${r.s}`);
    }
  } catch {
    /* table missing */
  } finally {
    db.close();
  }
  return out;
}

function loadBuybacks(): Map<string, string> {
  const out = new Map<string, string>();
  const since = new Date(Date.now() - SHORTLIST_RULES.buybackDays * 86_400_000).toISOString().slice(0, 10);
  try {
    const db = openSqliteNamed("strategy.db", { readonly: true, wal: true });
    try {
      for (const r of db
        .prepare(
          `SELECT UPPER(ticker) AS t, MAX(announced_at) AS at FROM buyback_events
           WHERE announced_at >= ? GROUP BY UPPER(ticker)`,
        )
        .all(since) as Array<{ t: string; at: string }>)
        out.set(r.t, r.at);
    } finally {
      db.close();
    }
  } catch {
    /* optional */
  }
  return out;
}

function computePage(): ShortlistPage {
  const R = SHORTLIST_RULES;
  const ctx = loadCtx();
  const inactive = inactiveListingTickers();
  const gov = loadGov();
  const industry = loadIndustry();
  const annual = loadAnnual();
  const flagged = loadWatchlisted();
  const buybacks = loadBuybacks();
  let smartMap: ReturnType<typeof loadSmartMap> = new Map();
  try {
    smartMap = loadSmartMap();
  } catch {
    /* smart money optional */
  }
  let invLabel = new Map<string, string>();
  try {
    invLabel = new Map(loadInvestors().map((i) => [i.id, i.label]));
  } catch {
    /* optional */
  }

  const mcapOf = (t: string) => ctx.mcap.get(t) ?? null;
  const roceOf = (t: string): number | null => {
    const a = annual.roce.get(t);
    if (a != null) return a;
    const r = ctx.ratios.get(t)?.roce;
    return r != null ? r * 100 : null;
  };

  // Universe: active listings in the size band.
  const base: NanoStock[] = [];
  for (const t of ctx.cos.keys()) {
    if (inactive.has(t)) continue;
    const m = mcapOf(t);
    if (m == null || m < R.minMcapCr || m > R.maxMcapCr) continue;
    base.push(buildStock(t, ctx));
  }

  // Sector P/E medians for "cheap vs peers".
  const peBySector = new Map<string, number[]>();
  for (const s of base) {
    if (!s.sector || s.pe == null || s.pe <= 0 || s.pe > 200) continue;
    if (!peBySector.has(s.sector)) peBySector.set(s.sector, []);
    peBySector.get(s.sector)!.push(s.pe);
  }
  const sectorPe = new Map([...peBySector].map(([k, v]) => [k, median(v)!]));

  const rows: ShortlistRow[] = [];
  let noBoard = 0;
  let failed = 0;
  for (const s of base) {
    const t = s.ticker;
    const seats = gov.seats.get(t) ?? [];
    if (seats.length < 3) {
      noBoard++;
      continue;
    }

    // ── Trust: board quality from the network ──
    const ind = seats.filter((x) => isIndependent(x.designation, x.category)).length;
    const indShare = ind / seats.length;
    const indPts = indShare >= 0.5 ? 25 : indShare >= 0.33 ? 10 + ((indShare - 0.33) / 0.17) * 15 : 0;
    const sizePts = seats.length >= 6 ? 10 : seats.length === 5 ? 7 : seats.length === 4 ? 4 : 1;
    const bigLinks: Array<{ name: string; board: string }> = [];
    const otherRoce: number[] = [];
    const seenOther = new Set<string>();
    let badAssoc = 0;
    let overboarded = 0;
    for (const seat of seats) {
      const others = [...(gov.boardsOf.get(seat.person) ?? [])].filter((o) => o !== t);
      if (others.length + 1 > R.overboarded) overboarded++;
      let big: string | null = null;
      let bigCap = 0;
      for (const o of others) {
        const m = mcapOf(o) ?? 0;
        if (m >= R.bigBoardCr && m > bigCap) {
          big = o;
          bigCap = m;
        }
        if (!seenOther.has(o)) {
          seenOther.add(o);
          const r = roceOf(o);
          if (r != null && Number.isFinite(r)) otherRoce.push(Math.max(-50, Math.min(100, r)));
        }
      }
      if (big) bigLinks.push({ name: gov.names.get(seat.person) ?? seat.person, board: big });
      if (others.some((o) => flagged.has(o))) badAssoc++;
    }
    const linkedRoce = otherRoce.length ? otherRoce.reduce((a, b) => a + b, 0) / otherRoce.length : null;
    const bigPts = Math.min(3, bigLinks.length) * 7;
    const rocePts = linkedRoce == null ? 0 : linkedRoce >= 18 ? 14 : linkedRoce >= 12 ? 8 : linkedRoce >= 8 ? 3 : 0;
    const resigns = gov.indResigns.get(t) ?? 0;
    const redFlags: string[] = [];
    if (resigns) redFlags.push(`${resigns} independent director${resigns > 1 ? "s" : ""} resigned (last ${R.eventDays} days)`);
    if (badAssoc) redFlags.push(`${badAssoc} director${badAssoc > 1 ? "s" : ""} also on a GSM / insolvency company`);
    if (overboarded) redFlags.push(`${overboarded} director${overboarded > 1 ? "s" : ""} on more than ${R.overboarded} listed boards`);
    const penalty = Math.min(24, resigns * 8) + Math.min(20, badAssoc * 10) + Math.min(9, overboarded * 3);
    const raw = indPts + sizePts + bigPts + rocePts - penalty;
    const trust = Math.round(Math.max(0, Math.min(100, (raw / 70) * 100)));

    // ── Safety ──
    const checks: Check[] = [];
    const flag = flagged.get(t);
    checks.push(
      flag
        ? { id: "watch", ok: false, note: `Under ${flag}` }
        : { id: "watch", ok: s.market.startsWith("NSE") ? true : null, note: s.market.startsWith("NSE") ? "Not on GSM / insolvency lists" : "BSE: NSE lists don't cover it" },
    );
    const profitable = s.pe != null && s.pe > 0 ? true : s.np_now != null && s.np_now <= 0 ? false : null;
    checks.push({
      id: "profit",
      ok: profitable,
      note: profitable ? "Profitable (last 4 quarters)" : profitable === false ? "Loss in the latest quarter" : "No recent results",
    });
    const pl = annual.pl.get(t);
    let taxOk: boolean | null = null;
    let taxNote = "No yearly P&L yet — use Fill tax & debt";
    if (pl) {
      const rates: number[] = [];
      for (let i = pl.tax.length - 1; i >= 0 && rates.length < 3; i--) {
        const p = pl.pbt[i];
        const x = pl.tax[i];
        if (p != null && p > 0 && x != null) rates.push(x);
      }
      if (rates.length) {
        const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
        taxOk = avg >= 10;
        taxNote = `Tax ${Math.round(avg)}% of profit (last ${rates.length} profitable years)${avg < 10 ? " — profit may not be real" : ""}`;
      } else {
        taxNote = "No profitable year to check tax";
      }
    }
    checks.push({ id: "tax", ok: taxOk, note: taxNote });
    const de = annual.debt.get(t);
    checks.push(
      de == null
        ? { id: "debt", ok: null, note: "No balance sheet yet — use Fill tax & debt" }
        : { id: "debt", ok: de <= 1.5, note: `Debt is ${de.toFixed(2)}× equity${de > 1.5 ? " — heavy" : ""}` },
    );
    if (checks.some((c) => c.ok === false)) {
      failed++;
      continue;
    }

    // ── Cheap vs sector ──
    const spe = s.sector ? sectorPe.get(s.sector) ?? null : null;
    const cheap =
      s.pe != null && s.pe > 0 && spe ? Math.round((1 - pctile(s.pe / spe, 0.5, 1.5)) * 100) : null;

    // ── Happening ──
    const happenings: string[] = [];
    let ev = 0;
    const strongJoins = (gov.joins.get(t) ?? []).filter((j) => {
      const others = [...(gov.boardsOf.get(j.person) ?? [])].filter((o) => o !== t);
      return others.length >= 3 || others.some((o) => (mcapOf(o) ?? 0) >= R.bigBoardCr);
    });
    if (strongJoins.length) {
      const j = strongJoins[0]!;
      const others = [...(gov.boardsOf.get(j.person) ?? [])]
        .filter((o) => o !== t)
        .sort((a, b) => (mcapOf(b) ?? 0) - (mcapOf(a) ?? 0));
      happenings.push(
        `${j.name} joined the board (${monthLabel(j.at)}) — also on ${others.slice(0, 2).join(", ")}${strongJoins.length > 1 ? ` · +${strongJoins.length - 1} more` : ""}`,
      );
      ev += strongJoins.length > 1 ? 50 : 40;
    }
    const bb = buybacks.get(t);
    if (bb) {
      happenings.push(`Buyback announced ${monthLabel(bb)}`);
      ev += 30;
    }
    if (s.np_year_ago != null && s.np_year_ago < 0 && s.np_now != null && s.np_now > 0) {
      happenings.push("Turned profitable this quarter");
      ev += 30;
    } else if (s.profit_yoy != null && s.profit_yoy >= 25 && (s.sales_yoy ?? 0) > 0) {
      happenings.push(`Profit +${Math.round(Math.min(999, s.profit_yoy))}% on last year's quarter`);
      ev += 30;
    }
    const events = Math.min(100, ev);

    // ── Quality (light: ranking only, not a gate) ──
    const roce = roceOf(t);
    const sales5 = annual.sales5.get(t) ?? null;
    const opm = pl?.opm.slice(-6) ?? [];
    const parts: Array<[number, number]> = [];
    if (roce != null) parts.push([roce >= 20 ? 40 : roce >= 15 ? 30 : roce >= 10 ? 15 : 0, 40]);
    if (sales5 != null) parts.push([sales5 >= 15 ? 30 : sales5 >= 8 ? 20 : sales5 >= 0 ? 10 : 0, 30]);
    let opmRange: [number, number] | null = null;
    if (opm.length >= 4) {
      const mean = opm.reduce((a, b) => a + b, 0) / opm.length;
      const sd = Math.sqrt(opm.reduce((a, b) => a + (b - mean) ** 2, 0) / opm.length);
      parts.push([sd <= 3 ? 30 : sd <= 6 ? 15 : 0, 30]);
      opmRange = [Math.round(Math.min(...opm)), Math.round(Math.max(...opm))];
    }
    const quality = parts.length
      ? Math.round((parts.reduce((a, p) => a + p[0], 0) / parts.reduce((a, p) => a + p[1], 0)) * 100)
      : null;

    const sy = s.sales_yoy;
    const py = s.profit_yoy;
    const growth =
      sy == null && py == null
        ? null
        : (sy == null ? 0 : sy >= 25 ? 50 : sy >= 15 ? 35 : sy >= 5 ? 15 : 0) +
          (py == null ? 0 : py >= 25 ? 50 : py >= 10 ? 30 : py > 0 ? 15 : 0);
    const score = Math.round(0.4 * trust + 0.25 * (cheap ?? 30) + 0.2 * events + 0.15 * (quality ?? 30));
    const scoreGrowth = Math.round(
      // Growth investors pay up for quality: cheapness doesn't count here.
      0.4 * trust + 0.3 * (quality ?? 30) + 0.2 * (growth ?? 0) + 0.1 * events,
    );
    const ind3 = industry.get(t) ?? null;
    const hay = [s.sector, s.sub_sector, ind3].filter(Boolean).join(" | ");
    rows.push({
      ticker: t,
      name: s.name,
      market: s.market,
      mcap_cr: s.mcap_cr,
      pe: s.pe,
      sector: s.sector ?? null,
      sub_sector: s.sub_sector ?? null,
      industry: ind3,
      website: s.website ?? null,
      group: s.group ?? null,
      zauba_url: zaubaUrl(s.name, gov.cins.get(t)),
      themes: themesFor(hay),
      trust,
      cheap,
      events,
      quality,
      growth,
      score,
      score_growth: scoreGrowth,
      board: seats.length,
      independent: ind,
      big_links: bigLinks.slice(0, 4),
      linked_roce: linkedRoce == null ? null : Math.round(linkedRoce),
      red_flags: redFlags,
      checks,
      happenings,
      roce: roce == null ? null : Math.round(roce),
      sales_cagr_5y: sales5 == null ? null : Math.round(sales5),
      opm_range: opmRange,
      sector_pe: spe == null ? null : Math.round(spe * 10) / 10,
      smart: (smartMap.get(t) ?? [])
        .filter((h) => h.move !== "exit")
        .map((h) => ({ label: invLabel.get(h.investor) ?? h.investor, pct: h.pct, move: h.move })),
    });
  }
  rows.sort((a, b) => b.score - a.score);
  const skip = recentlyTried("shortlist");
  let paused: string | null = null;
  try {
    paused = screenerPausedUntil();
  } catch {
    /* table may not exist */
  }
  return {
    rows,
    themes: THEMES.map(({ id, label }) => ({ id, label })),
    rules: R,
    counts: {
      universe: base.length,
      no_board: noBoard,
      failed_safety: failed,
      shown: rows.length,
      need_fill: rows.filter((r) => !annual.tried.has(r.ticker) && !skip.has(r.ticker)).length,
    },
    paused_until: paused,
    lv: loadLv(),
    computed_at: new Date().toISOString(),
  };
}

function loadLv(): { current: string[]; past: string[] } {
  try {
    const db = openSqliteNamed("named_watchlists.db", { readonly: true, wal: true });
    try {
      const list = (key: string) =>
        (
          db
            .prepare(`SELECT DISTINCT UPPER(ticker) AS t FROM named_watchlists WHERE list_key = ? ORDER BY 1`)
            .all(key) as Array<{ t: string }>
        ).map((r) => r.t);
      const current = list("others");
      const cur = new Set(current);
      return { current, past: list("lvhistorical").filter((t) => !cur.has(t)) };
    } finally {
      db.close();
    }
  } catch {
    return { current: [], past: [] };
  }
}

let cache: { at: number; page: ShortlistPage } | null = null;
const CACHE_MS = 10 * 60_000;

export function buildShortlist(opts?: { fresh?: boolean }): ShortlistPage {
  if (!opts?.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.page;
  const page = computePage();
  cache = { at: Date.now(), page };
  return page;
}

const STOP_KEY = "__shortlistFillStop";
type StopHolder = { [STOP_KEY]?: boolean };

export function stopShortlistFill(): void {
  (globalThis as StopHolder)[STOP_KEY] = true;
}

/**
 * Fetch yearly P&L + balance sheet (tax, margins, debt) for shortlist stocks
 * that don't have them, best-scored first. One Screener page per stock;
 * stops at the first block or when asked.
 */
export async function fillShortlist(
  onProgress: (done: number, total: number, filled: number) => void,
  opts?: { themes?: string[] },
): Promise<FillResult> {
  const holder = globalThis as StopHolder;
  holder[STOP_KEY] = false;
  const page = buildShortlist({ fresh: true });
  const want = opts?.themes?.length ? new Set(opts.themes) : null;
  const tried = loadAnnual().tried;
  const skip = recentlyTried("shortlist");
  const queue = page.rows
    .filter((r) => !tried.has(r.ticker) && !skip.has(r.ticker) && (!want || r.themes.some((x) => want.has(x))))
    .map((r) => r.ticker);
  let done = 0;
  let filled = 0;
  let notFound = 0;
  onProgress(0, queue.length, 0);
  try {
    for (const t of queue) {
      if (holder[STOP_KEY]) break;
      if (screenerPausedUntil()) break;
      try {
        const r = await fetchScreenerPlAndBs(t);
        if (r.pl || r.bs) filled++;
        else notFound++;
        markTried("shortlist", t);
      } catch (e) {
        if (/blocked|paused|429|403|captcha/i.test(String(e))) throw e;
        markTried("shortlist", t);
        notFound++;
      }
      done++;
      onProgress(done, queue.length, filled);
    }
  } finally {
    cache = null;
  }
  return { tried: done, filled, left: queue.length - done, not_found: notFound };
}
