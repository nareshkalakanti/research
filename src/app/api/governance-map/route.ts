import { NextRequest, NextResponse } from "next/server";
import {
  countNamelessDinDirectors,
  governanceMapStats,
  loadAboutMap,
  loadGovernanceFamilyMap,
  loadGovernanceMap,
  tickerMatchesSearch,
  type GovernanceMapRow,
  type GovCompanySeat,
} from "@/lib/governance-map";
import { mcapCapCode, pledgedDirectorScore, scoreCompanyBoard } from "@/lib/gov-score";
import {
  boardIndependenceForTicker,
  independenceFloorCounts,
  independentBoardCount,
  independentBoardTickerSet,
  rankedBoardIndependence,
} from "@/lib/gov-independence";
import { researchLinks } from "@/lib/links";
import { loadMetricsMap } from "@/lib/metrics";
import {
  combinePatterns,
  matchedKeywords,
  patternMatches,
} from "@/lib/pattern";
import { FUND_WATCHLIST_KEYS } from "@/lib/fund-watchlist-meta";
import {
  anyFundFilterActive,
  parseFundFiltersFromSearchParams,
} from "@/lib/fund-watchlists";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type View = "director" | "company" | "role" | "family" | "independence";

/** Theme match uses About + products + HQ location. */
function seatAboutText(c: GovCompanySeat): string {
  return c.about_search || c.about || "";
}

function seatWithHighlights(
  c: GovCompanySeat,
  themePattern: string | null,
): GovCompanySeat & { highlights: string[] } {
  const search = seatAboutText(c);
  const about = [c.about, c.headquarters].filter(Boolean).join("\n");
  return {
    ...c,
    highlights: themePattern
      ? matchedKeywords(about, themePattern, search)
      : [],
  };
}

function seatMatchesCap(
  c: { cap_code: string | null },
  cap: string,
): boolean {
  if (!cap || cap === "All") return true;
  if (cap === "NC") return !c.cap_code;
  return (c.cap_code || "").toUpperCase() === cap.toUpperCase();
}

function seatMatchesMcap(
  c: { market_cap_cr: number | null },
  mcapMin: number | null,
  mcapMax: number | null,
): boolean {
  if (mcapMin != null && mcapMin > 0) {
    if (c.market_cap_cr == null || c.market_cap_cr < mcapMin) return false;
  }
  if (mcapMax != null) {
    if (c.market_cap_cr == null || c.market_cap_cr > mcapMax) return false;
  }
  return true;
}

function filterRows(
  rows: GovernanceMapRow[],
  opts: {
    q: string;
    dinOnly: boolean;
    namelessDin: boolean;
    bridge: boolean;
    tinyBridge: boolean;
    tiBridge: boolean;
    smeCross: boolean;
    multiLc: boolean;
    bb: boolean;
    tq: boolean;
    hold: boolean;
    edge: boolean;
    funds: Partial<Record<(typeof FUND_WATCHLIST_KEYS)[number], boolean>>;
    hideCollision: boolean;
    minScore: number;
    minBoards: number;
    themePattern: string | null;
    themeShowAll: boolean;
    family: boolean;
    control: boolean;
    pattern: boolean;
    familyTickers?: Set<string>;
    controlTickers?: Set<string>;
    patternTickers?: Set<string>;
    /** Cap band filter: All | NC | TI | MIC | SC | MC | LC */
    cap: string;
    mcapMin: number | null;
    mcapMax: number | null;
    /** NSE SME seats only */
    sme: boolean;
    independence: boolean;
    independenceTickers?: Set<string>;
    /** When searching by company, drop non-matching seats (Companies tab). */
    narrowCompanies: boolean;
  },
): GovernanceMapRow[] {
  const q = opts.q.trim().toLowerCase();
  const out: GovernanceMapRow[] = [];
  const cap = (opts.cap || "All").toUpperCase();
  const capActive = cap !== "ALL" && Boolean(cap);
  const mcapActive =
    (opts.mcapMin != null && opts.mcapMin > 0) || opts.mcapMax != null;

  for (const r of rows) {
    if (opts.dinOnly && !r.din_backed) continue;
    if (opts.namelessDin && !r.nameless_din) continue;
    if (opts.tiBridge && !r.ti_bridge) continue;
    if (opts.tinyBridge && !r.tiny_bridge) continue;
    if (opts.bridge && !r.bridge) continue;
    if (opts.multiLc && !r.multi_lc) continue;
    if (opts.smeCross && !r.sme_cross) continue;
    if (opts.hideCollision && r.name_collision) continue;
    if (r.dir_score < opts.minScore) continue;
    // Company/director search includes 1-board rows; only enforce minBoards when browsing.
    if (!q && r.board_count < opts.minBoards) continue;

    let companies = r.companies;
    let themeMatched = 0;

    if (opts.themePattern) {
      const matched = companies.filter((c) => {
        const text = seatAboutText(c);
        return text.trim() && patternMatches(text, opts.themePattern!);
      });
      themeMatched = matched.length;
      if (!themeMatched) continue;
      companies = opts.themeShowAll ? companies : matched;
    }

    if (opts.pattern && !opts.family && !opts.control) {
      const matched = opts.patternTickers
        ? companies.filter((c) => opts.patternTickers!.has(c.ticker.toUpperCase()))
        : companies;
      if (!matched.length) continue;
      companies = matched;
    } else {
      if (opts.family && opts.familyTickers) {
        const matched = companies.filter((c) =>
          opts.familyTickers!.has(c.ticker.toUpperCase()),
        );
        if (!matched.length) continue;
        companies = matched;
      } else if (opts.family && !opts.familyTickers) {
        continue;
      }
      if (opts.control && opts.controlTickers) {
        const matched = companies.filter((c) =>
          opts.controlTickers!.has(c.ticker.toUpperCase()),
        );
        if (!matched.length) continue;
        companies = matched;
      } else if (opts.control && !opts.controlTickers) {
        continue;
      }
    }

    if (capActive) {
      const matched = companies.filter((c) => seatMatchesCap(c, cap));
      if (!matched.length) continue;
      companies = matched;
    }

    if (mcapActive) {
      const matched = companies.filter((c) =>
        seatMatchesMcap(c, opts.mcapMin, opts.mcapMax),
      );
      if (!matched.length) continue;
      companies = matched;
    }

    if (opts.sme) {
      const matched = companies.filter((c) => c.is_sme);
      if (!matched.length) continue;
      companies = matched;
    }

    if (opts.independence) {
      const ok = opts.independenceTickers;
      if (!ok) continue;
      const matched = companies.filter((c) => ok.has(c.ticker.toUpperCase()));
      if (!matched.length) continue;
      companies = matched;
    }

    // Thesis chip: identify the SME names that share directors with mainboard.
    if (opts.smeCross && opts.narrowCompanies) {
      const matched = companies.filter((c) => c.is_sme);
      if (!matched.length) continue;
      companies = matched;
    }

    if (opts.bb || opts.tq) {
      const hit = companies.some(
        (c) => (opts.bb && c.has_bb) || (opts.tq && c.has_tq),
      );
      if (!hit) continue;
    }

    if (
      opts.hold ||
      opts.edge ||
      anyFundFilterActive(opts.funds)
    ) {
      const matched = companies.filter(
        (c) =>
          (opts.hold && c.has_hold) ||
          (opts.edge && c.has_edge) ||
          FUND_WATCHLIST_KEYS.some((k) => opts.funds[k] && c.fund_tags?.includes(k)),
      );
      if (!matched.length) continue;
      // Companies tab: only the matching names, not every board those directors sit on.
      if (opts.narrowCompanies) companies = matched;
    }

    if (q) {
      const nameHit = r.name.toLowerCase().includes(q);
      const dinHit = Boolean(r.din && r.din.toLowerCase().includes(q));
      const matchingCos = companies.filter(
        (c) =>
          tickerMatchesSearch(c.ticker, q) ||
          c.name.toLowerCase().includes(q) ||
          (c.designation || "").toLowerCase().includes(q),
      );
      const coHit = matchingCos.length > 0;
      if (!nameHit && !dinHit && !coHit) continue;
      // Narrow seats only for Companies view — Directors keep full board network.
      if (opts.narrowCompanies && coHit && !nameHit && !dinHit) {
        companies = matchingCos;
      }
    }

    if (opts.themePattern && opts.themeShowAll && themeMatched > 0) {
      companies = [...companies].sort((a, b) => {
        const am = patternMatches(seatAboutText(a), opts.themePattern!) ? 1 : 0;
        const bm = patternMatches(seatAboutText(b), opts.themePattern!) ? 1 : 0;
        return bm - am;
      });
    }

    const boardCount = new Set(companies.map((c) => c.ticker.toUpperCase())).size;

    if (companies !== r.companies || boardCount !== r.board_count) {
      out.push({
        ...r,
        board_count: boardCount,
        companies,
        tickers: companies.map((c) => c.ticker).join(", "),
        theme_matched: themeMatched || undefined,
      });
    } else {
      out.push({
        ...r,
        theme_matched: themeMatched || undefined,
      });
    }
  }

  return out;
}

type GovSort = "score" | "boards" | "name" | "theme";

function sortDirectorRows(
  rows: GovernanceMapRow[],
  sort: GovSort,
  themePattern: string | null,
): GovernanceMapRow[] {
  const mul = [...rows];
  mul.sort((a, b) => {
    if (sort === "boards") {
      if (b.board_count !== a.board_count) return b.board_count - a.board_count;
      return b.dir_score - a.dir_score;
    }
    if (sort === "name") {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    if (sort === "theme" && themePattern) {
      const at = a.theme_matched ?? 0;
      const bt = b.theme_matched ?? 0;
      if (bt !== at) return bt - at;
    }
    if (b.dir_score !== a.dir_score) return b.dir_score - a.dir_score;
    return b.board_count - a.board_count;
  });
  return mul;
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function directorRowsCsv(rows: GovernanceMapRow[]): string {
  const header = [
    "name",
    "din",
    "dir_score",
    "board_count",
    "bridge",
    "sme_cross",
    "tickers",
    "companies",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.name,
        r.din ?? "",
        r.dir_score,
        r.board_count,
        r.bridge ? 1 : 0,
        r.sme_cross ? 1 : 0,
        r.tickers,
        r.companies
          .map(
            (c) =>
              `${c.ticker}:${c.designation}${c.market_cap_cr != null ? `@${c.market_cap_cr}Cr` : ""}`,
          )
          .join(" | "),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n");
}

type CompanyAgg = {
  ticker: string;
  name: string;
  market: string;
  market_cap_cr: number | null;
  cap_code: string | null;
  board_score: number;
  has_bb: boolean;
  has_bb_w: boolean;
  has_bb_m: boolean;
  has_tq: boolean;
  has_hold: boolean;
  has_edge: boolean;
  fund_tags: import("@/lib/fund-watchlist-meta").FundWatchlistKey[];
  about: string | null;
  headquarters: string | null;
  highlights: string[];
  sc: string;
  tv: string;
  web: string | null;
  directors: Array<{
    person_id: string;
    name: string;
    din: string | null;
    dir_score: number;
    pledged_score?: number;
    din_backed: boolean;
    designation: string;
    category: string | null;
    /** Other board seats (excludes this company). */
    other_boards: Array<{
      ticker: string;
      name: string;
      market: string;
      cap_code: string | null;
      is_sme?: boolean;
    }>;
  }>;
};

type RoleAgg = {
  role: string;
  count: number;
  directors: Array<{
    person_id: string;
    name: string;
    dir_score: number;
    ticker: string;
    company: string;
  }>;
};

type BoardSeatLike = {
  name: string;
  designation: string;
  category: string | null;
  din: string | null;
};

function boardMatchesFamily(seats: BoardSeatLike[]): boolean {
  const surnameCounts = new Map<string, number>();

  for (const seat of seats) {
    const surname = seat.name
      .replace(/[().,]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(-1)[0]
      ?.toUpperCase();
    if (surname) {
      surnameCounts.set(surname, (surnameCounts.get(surname) || 0) + 1);
    }
  }

  return [...surnameCounts.values()].some((n) => n >= 2);
}

function boardMatchesControl(seats: BoardSeatLike[]): boolean {
  let controlRoles = 0;
  let independentCount = 0;

  for (const seat of seats) {
    const text = `${seat.designation} ${seat.category || ""}`.toLowerCase();
    if (/independent/.test(text)) independentCount += 1;
    if (/founder|managing|whole[-\s]?time|joint managing|executive|chairman/.test(text)) {
      controlRoles += 1;
    }
  }

  return (
    (controlRoles >= 3 && seats.length >= 4) ||
    (controlRoles >= 2 && independentCount >= 1 && seats.length >= 5)
  );
}

function boardMatchesPattern(seats: BoardSeatLike[]): boolean {
  return boardMatchesFamily(seats) || boardMatchesControl(seats);
}

function buildBoardPatternTickerSets(rows: GovernanceMapRow[]): {
  family: Set<string>;
  control: Set<string>;
  pattern: Set<string>;
} {
  const byTicker = new Map<string, BoardSeatLike[]>();
  for (const row of rows) {
    for (const seat of row.companies) {
      const ticker = seat.ticker.trim().toUpperCase();
      if (!ticker) continue;
      const list = byTicker.get(ticker) ?? [];
      list.push({
        name: row.name,
        designation: seat.designation,
        category: seat.category,
        din: row.din,
      });
      byTicker.set(ticker, list);
    }
  }

  const family = new Set<string>();
  const control = new Set<string>();
  const pattern = new Set<string>();
  for (const [ticker, seats] of byTicker) {
    const familyHit = boardMatchesFamily(seats);
    const controlHit = boardMatchesControl(seats);
    if (familyHit) family.add(ticker);
    if (controlHit) control.add(ticker);
    if (familyHit || controlHit) pattern.add(ticker);
  }
  return { family, control, pattern };
}

export async function GET(req: NextRequest) {
  try {
    return await buildGovernanceMapResponse(req);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message.slice(0, 240)
        : "Governance map load failed";
    console.error("[api/governance-map]", err);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

async function buildGovernanceMapResponse(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const view = (sp.get("view") || "director") as View;
  const q = sp.get("q") || "";
  const page = Math.max(1, Number(sp.get("page") || 1));
  const pageSize = Math.min(100, Math.max(10, Number(sp.get("pageSize") || 40)));
  const namelessDin = sp.get("namelessDin") === "1";
  const minBoards = namelessDin
    ? 1
    : Math.max(2, Number(sp.get("minBoards") || 2));
  const minScore = Number(sp.get("minScore") || 0);
  const sort = (sp.get("sort") || "score") as GovSort;
  const refresh = sp.get("refresh") === "1";
  const format = sp.get("format") || "json";
  const custom = (sp.get("custom") || "").trim();
  const themePattern = combinePatterns([custom]) || null;
  const pattern = sp.get("pattern") === "1";
  const family = sp.get("family") === "1";
  const control = sp.get("control") === "1";
  if (view === "family") {
    const stats = {
      ...governanceMapStats(loadGovernanceMap({ minBoards, refresh })),
      nameless_din: countNamelessDinDirectors(),
      independent_boards: independentBoardCount(),
      independence_floors: independenceFloorCounts(true),
    };
    const families = loadGovernanceFamilyMap({
      q,
      hold: sp.get("hold") === "1",
    });
    const total = families.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    return NextResponse.json({
      view: "family",
      stats,
      total,
      page,
      pages,
      themePattern: themePattern || null,
      rows: families.slice(start, start + pageSize),
    });
  }
  const all = loadGovernanceMap({ minBoards, refresh, q });
  const boardPatternSets = buildBoardPatternTickerSets(all);
  // Stats from the multi-board universe (stable), not the search subset.
  const stats = {
    ...governanceMapStats(q.trim() ? loadGovernanceMap({ minBoards }) : all),
    nameless_din: countNamelessDinDirectors(),
    independent_boards: independentBoardCount(),
    independence_floors: independenceFloorCounts(true),
  };
  if (view === "independence") {
    const minIndPct = Number(sp.get("minIndPct") || 50);
    const ranked = rankedBoardIndependence({
      minPct: Number.isFinite(minIndPct) ? minIndPct : 50,
      noFamily: sp.get("indFamily") !== "1",
      q,
    });
    const total = ranked.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    const slice = ranked.slice(start, start + pageSize);
    const abouts = loadAboutMap(slice.map((r) => r.ticker));
    const metrics = loadMetricsMap();
    const rows = slice.map((ind, i) => {
      const about = abouts.get(ind.ticker);
      const m = metrics.get(ind.ticker);
      const mcap = m?.market_cap_cr ?? null;
      const links = researchLinks(ind.ticker, ind.market, about?.website ?? null);
      return {
        ticker: ind.ticker,
        name: about?.name || ind.name,
        market: ind.market,
        market_cap_cr: mcap,
        price: m?.price ?? null,
        cap_code: mcapCapCode(mcap),
        has_bb: false,
        has_bb_w: false,
        has_bb_m: false,
        has_tq: false,
        has_hold: false,
        has_edge: false,
        fund_tags: [] as string[],
        about: about?.about ?? null,
        headquarters: about?.headquarters ?? null,
        sector: about?.sector ?? m?.sector ?? null,
        industry: about?.industry ?? null,
        sc: links.sc,
        tv: links.tv,
        web: links.web,
        board_score: Math.round(ind.pct * 1000) / 10,
        rank: start + i + 1,
        independent_pct: Math.round(ind.pct * 100),
        independent_n: ind.independent,
        board_n: ind.total,
        independent_ok: ind.qualifies,
        family_control: ind.family_control,
        directors: [] as Array<Record<string, never>>,
      };
    });
    return NextResponse.json({
      view: "independence",
      stats,
      total,
      page,
      pages,
      themePattern: themePattern || null,
      rows,
    });
  }
  const independenceTickers = independentBoardTickerSet();
  const filtered = filterRows(all, {
    q,
    dinOnly: sp.get("dinOnly") !== "0",
    namelessDin,
    bridge: sp.get("bridge") === "1",
    tinyBridge: sp.get("tinyBridge") === "1",
    tiBridge: sp.get("tiBridge") === "1",
    smeCross: sp.get("smeCross") === "1",
    multiLc: sp.get("multiLc") === "1",
    bb: sp.get("bb") === "1",
    tq: sp.get("tq") === "1",
    hold: sp.get("hold") === "1",
    edge: sp.get("edge") === "1",
    funds: parseFundFiltersFromSearchParams(sp),
    hideCollision: sp.get("hideCollision") !== "0",
    minScore: Number.isFinite(minScore) ? minScore : 0,
    minBoards,
    themePattern,
    themeShowAll: sp.get("themeShowAll") === "1",
    cap: (sp.get("cap") || "All").trim() || "All",
    mcapMin:
      sp.get("mcapMin") != null && Number.isFinite(Number(sp.get("mcapMin")))
        ? Number(sp.get("mcapMin"))
        : null,
    mcapMax:
      sp.get("mcapMax") != null && Number.isFinite(Number(sp.get("mcapMax")))
        ? Number(sp.get("mcapMax"))
        : null,
    sme: sp.get("sme") === "1",
    independence: sp.get("independence") === "1",
    independenceTickers,
    family,
    control,
    pattern,
    familyTickers: boardPatternSets.family,
    controlTickers: boardPatternSets.control,
    patternTickers: boardPatternSets.pattern,
    narrowCompanies: view === "company",
  });

  if (format === "csv" && view === "director") {
    const sorted = sortDirectorRows(filtered, sort, themePattern);
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(directorRowsCsv(sorted), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="govmap-directors-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (view === "company") {
    const fullBoardsByPerson = new Map(
      all.map((r) => [r.person_id, r.companies] as const),
    );
    const byTicker = new Map<string, CompanyAgg>();
    for (const r of filtered) {
      for (const c of r.companies) {
        let agg = byTicker.get(c.ticker);
        if (!agg) {
          const highlighted = seatWithHighlights(c, themePattern);
          agg = {
            ticker: c.ticker,
            name: c.name,
            market: c.market,
            market_cap_cr: c.market_cap_cr,
            cap_code: c.cap_code,
            has_bb: c.has_bb,
            has_bb_w: c.has_bb_w,
            has_bb_m: c.has_bb_m,
            has_tq: c.has_tq,
            has_hold: c.has_hold,
            has_edge: c.has_edge,
            fund_tags: c.fund_tags,
            about: c.about,
            headquarters: c.headquarters,
            highlights: highlighted.highlights,
            sc: c.sc,
            tv: c.tv,
            web: c.web,
            board_score: 0,
            independent_pct: null as number | null,
            independent_n: 0,
            board_n: 0,
            independent_ok: false,
            directors: [],
          };
          byTicker.set(c.ticker, agg);
        }
        const fullBoards = fullBoardsByPerson.get(r.person_id) ?? r.companies;
        const otherSeats = fullBoards.filter(
          (x) => x.ticker.toUpperCase() !== c.ticker.toUpperCase(),
        );
        agg.directors.push({
          person_id: r.person_id,
          name: r.name,
          din: r.din,
          dir_score: r.dir_score,
          pledged_score: pledgedDirectorScore({
            otherSeats,
            personId: r.person_id,
            din: r.din,
          }),
          din_backed: r.din_backed,
          designation: c.designation,
          category: c.category,
          other_boards: otherSeats
            .slice()
            .sort((a, b) => {
              // SME first so small listings stay visible, then largest mcap.
              if (a.is_sme !== b.is_sme) return a.is_sme ? -1 : 1;
              return (b.market_cap_cr ?? -1) - (a.market_cap_cr ?? -1);
            })
            .map((x) => ({
              ticker: x.ticker,
              name: x.name,
              market: x.market,
              cap_code: x.cap_code,
              is_sme: x.is_sme,
            })),
        });
      }
    }
    let companies = [...byTicker.values()].map((agg) => {
      const ind = boardIndependenceForTicker(agg.ticker);
      return {
        ...agg,
        board_score: scoreCompanyBoard(agg.directors),
        independent_pct: ind ? Math.round(ind.pct * 100) : null,
        independent_n: ind?.independent ?? 0,
        board_n: ind?.total ?? 0,
        independent_ok: Boolean(ind?.qualifies),
      };
    });
    companies.sort((a, b) => {
      if (sort === "independence" || sp.get("independence") === "1") {
        const ap = a.independent_pct ?? -1;
        const bp = b.independent_pct ?? -1;
        if (bp !== ap) return bp - ap;
        if (b.independent_n !== a.independent_n) return b.independent_n - a.independent_n;
        if (a.independent_ok !== b.independent_ok) return a.independent_ok ? -1 : 1;
      }
      if (sort === "score" && b.board_score !== a.board_score) {
        return b.board_score - a.board_score;
      }
      const am = a.market_cap_cr ?? -1;
      const bm = b.market_cap_cr ?? -1;
      if (bm !== am) return bm - am;
      return a.ticker.localeCompare(b.ticker);
    });
    const tickerEq = (sp.get("ticker") || "").trim().toUpperCase();
    if (tickerEq) {
      companies = companies.filter((agg) => agg.ticker.toUpperCase() === tickerEq);
    }
    if (pattern && !family && !control) {
      companies = companies.filter((agg) => boardMatchesPattern(agg.directors));
    } else {
      if (family) {
        companies = companies.filter((agg) => boardMatchesFamily(agg.directors));
      }
      if (control) {
        companies = companies.filter((agg) => boardMatchesControl(agg.directors));
      }
    }
    const total = companies.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    return NextResponse.json({
      view,
      stats,
      total,
      page,
      pages,
      themePattern: themePattern || null,
      rows: companies.slice(start, start + pageSize),
    });
  }

  if (view === "role") {
    const byRole = new Map<string, RoleAgg>();
    for (const r of filtered) {
      for (const c of r.companies) {
        const role =
          [c.designation, c.category].filter(Boolean).join(" · ") ||
          "Director";
        let agg = byRole.get(role);
        if (!agg) {
          agg = { role, count: 0, directors: [] };
          byRole.set(role, agg);
        }
        agg.count += 1;
        if (agg.directors.length < 8) {
          agg.directors.push({
            person_id: r.person_id,
            name: r.name,
            dir_score: r.dir_score,
            ticker: c.ticker,
            company: c.name,
          });
        }
      }
    }
    const roles = [...byRole.values()].sort((a, b) => b.count - a.count);
    const total = roles.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    return NextResponse.json({
      view,
      stats,
      total,
      page,
      pages,
      themePattern: themePattern || null,
      rows: roles.slice(start, start + pageSize),
    });
  }

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const sorted = sortDirectorRows(filtered, sort, themePattern);
  const rows = sorted.slice(start, start + pageSize).map((r) => ({
    ...r,
    companies: r.companies.map((c) => {
      const highlighted = seatWithHighlights(c, themePattern);
      const themeHit =
        themePattern &&
        patternMatches(seatAboutText(c), themePattern);
      return { ...highlighted, theme_hit: !!themeHit };
    }),
  }));
  return NextResponse.json({
    view: "director",
    stats,
    total,
    page,
    pages,
    themePattern: themePattern || null,
    rows,
  });
}
