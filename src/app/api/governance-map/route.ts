import { NextRequest, NextResponse } from "next/server";
import {
  governanceMapStats,
  loadGovernanceMap,
  type GovernanceMapRow,
  type GovCompanySeat,
} from "@/lib/governance-map";
import {
  combinePatterns,
  matchedKeywords,
  patternMatches,
} from "@/lib/pattern";
import { themesByIds } from "@/lib/themes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type View = "director" | "company" | "role";

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

function filterRows(
  rows: GovernanceMapRow[],
  opts: {
    q: string;
    dinOnly: boolean;
    bridge: boolean;
    smeCross: boolean;
    bb: boolean;
    tq: boolean;
    hideCollision: boolean;
    minScore: number;
    minBoards: number;
    themePattern: string | null;
  },
): GovernanceMapRow[] {
  const q = opts.q.trim().toLowerCase();
  const out: GovernanceMapRow[] = [];

  for (const r of rows) {
    if (opts.dinOnly && !r.din_backed) continue;
    if (opts.bridge && !r.bridge) continue;
    if (opts.smeCross && !r.sme_cross) continue;
    if (opts.hideCollision && r.name_collision) continue;
    if (r.dir_score < opts.minScore) continue;
    if (r.board_count < opts.minBoards) continue;

    let companies = r.companies;

    if (opts.themePattern) {
      companies = companies.filter((c) => {
        const text = seatAboutText(c);
        return text.trim() && patternMatches(text, opts.themePattern!);
      });
      if (!companies.length) continue;
    }

    if (opts.bb || opts.tq) {
      const hit = companies.some(
        (c) => (opts.bb && c.has_bb) || (opts.tq && c.has_tq),
      );
      if (!hit) continue;
    }

    if (q) {
      const nameHit = r.name.toLowerCase().includes(q);
      const dinHit = Boolean(r.din && r.din.toLowerCase().includes(q));
      const coHit = companies.some(
        (c) =>
          c.ticker.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q) ||
          (c.designation || "").toLowerCase().includes(q),
      );
      if (!nameHit && !dinHit && !coHit) continue;
    }

    if (companies !== r.companies) {
      out.push({
        ...r,
        companies,
        tickers: companies.map((c) => c.ticker).join(", "),
      });
    } else {
      out.push(r);
    }
  }

  return out;
}

type CompanyAgg = {
  ticker: string;
  name: string;
  market: string;
  market_cap_cr: number | null;
  cap_code: string | null;
  has_bb: boolean;
  has_tq: boolean;
  has_hold: boolean;
  has_edge: boolean;
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
    din_backed: boolean;
    designation: string;
    category: string | null;
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

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const view = (sp.get("view") || "director") as View;
  const q = sp.get("q") || "";
  const page = Math.max(1, Number(sp.get("page") || 1));
  const pageSize = Math.min(100, Math.max(10, Number(sp.get("pageSize") || 40)));
  const minBoards = Math.max(2, Number(sp.get("minBoards") || 2));
  const minScore = Number(sp.get("minScore") || 0);
  const refresh = sp.get("refresh") === "1";
  const themeIds = (sp.get("themes") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const custom = (sp.get("custom") || "").trim();
  const themePatterns = themesByIds(themeIds).map((t) => t.display_pattern);
  const themePattern =
    combinePatterns([...themePatterns, custom]) || null;

  const all = loadGovernanceMap({ minBoards, refresh });
  const filtered = filterRows(all, {
    q,
    dinOnly: sp.get("dinOnly") === "1",
    bridge: sp.get("bridge") === "1",
    smeCross: sp.get("smeCross") === "1",
    bb: sp.get("bb") === "1",
    tq: sp.get("tq") === "1",
    hideCollision: sp.get("hideCollision") !== "0",
    minScore: Number.isFinite(minScore) ? minScore : 0,
    minBoards,
    themePattern,
  });

  const stats = governanceMapStats(filtered);

  if (view === "company") {
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
            has_tq: c.has_tq,
            has_hold: c.has_hold,
            has_edge: c.has_edge,
            about: c.about,
            headquarters: c.headquarters,
            highlights: highlighted.highlights,
            sc: c.sc,
            tv: c.tv,
            web: c.web,
            directors: [],
          };
          byTicker.set(c.ticker, agg);
        }
        agg.directors.push({
          person_id: r.person_id,
          name: r.name,
          din: r.din,
          dir_score: r.dir_score,
          din_backed: r.din_backed,
          designation: c.designation,
          category: c.category,
        });
      }
    }
    const companies = [...byTicker.values()].sort((a, b) => {
      const am = a.market_cap_cr ?? -1;
      const bm = b.market_cap_cr ?? -1;
      if (bm !== am) return bm - am;
      return a.ticker.localeCompare(b.ticker);
    });
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
  const rows = filtered.slice(start, start + pageSize).map((r) => ({
    ...r,
    companies: r.companies.map((c) => seatWithHighlights(c, themePattern)),
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
