import { NextResponse } from "next/server";
import { loadGovernanceFamilyMap, loadGovernanceMap } from "@/lib/governance-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Seat role bucket: Independent, Executive (incl. MD / CFO), or other non-executive. */
type Role = "I" | "E" | "N";

export type RankSeat = {
  t: string;
  n: string;
  m: string;
  mc: number | null;
  r: Role;
  d: string;
  sme: boolean;
  sec: string | null;
  g: string | null;
};

export type RankDirector = {
  id: string;
  din: string | null;
  name: string;
  din_backed: boolean;
  score: number;
  recent: boolean;
  joined_at: string | null;
  seats: RankSeat[];
};

function roleOf(category: string | null | undefined, designation: string | null | undefined): Role {
  const s = `${category ?? ""} ${designation ?? ""}`.toLowerCase();
  if (/independent/.test(s) && !/non[- ]?independent/.test(s)) return "I";
  if (/executive|managing|whole[- ]?time|\bceo\b|\bcfo\b|\bmd\b|chief/.test(s) && !/non[- ]?executive/.test(s)) return "E";
  return "N";
}

/**
 * Every director on 2+ listed boards, compact (one row per person, one entry
 * per seat with cap, role, sector and business group) — the Dashboard ranks,
 * filters and graphs them in the browser.
 */
export async function GET() {
  try {
    const rows = loadGovernanceMap({ minBoards: 2 });
    const groupOf = new Map<string, string>();
    try {
      for (const g of loadGovernanceFamilyMap())
        for (const c of g.companies) groupOf.set(c.ticker.toUpperCase(), g.family_name);
    } catch {
      /* groups optional */
    }
    const out: RankDirector[] = [];
    for (const r of rows) {
      // Same name, different people: the seats can't be trusted as one person.
      if (r.name_collision) continue;
      const seen = new Set<string>();
      const seats: RankSeat[] = [];
      for (const c of r.companies) {
        const t = c.ticker.toUpperCase();
        if (seen.has(t)) continue;
        seen.add(t);
        seats.push({
          t,
          n: c.name,
          m: c.market,
          mc: c.market_cap_cr ?? null,
          r: roleOf(c.category, c.designation),
          d: c.designation || "",
          sme: Boolean(c.is_sme),
          sec: c.sector || null,
          g: groupOf.get(t) ?? null,
        });
      }
      if (seats.length < 2) continue;
      out.push({
        id: r.person_id,
        din: r.din,
        name: r.name,
        din_backed: r.din_backed,
        score: Math.round(r.dir_score * 10) / 10,
        recent: Boolean(r.recent_join),
        joined_at: r.joined_at ?? null,
        seats,
      });
    }
    return NextResponse.json({ ok: true, rows: out });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
