import { NextRequest, NextResponse } from "next/server";
import {
  addEntity,
  addInvestor,
  clearSuggestions,
  entityHoldCounts,
  loadEntities,
  loadInvestors,
  nameKey,
  setEntityStatus,
  suggestEntities,
  type EntityStatus,
} from "@/lib/smart-entities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET: investors and the names they file under (confirmed, suggested, rejected). */
export async function GET() {
  try {
    const holds = entityHoldCounts();
    const entities = loadEntities().map((e) => ({
      ...e,
      holds: e.match_type === "exact" ? holds.get(nameKey(e.name)) ?? 0 : undefined,
    }));
    return NextResponse.json({ ok: true, investors: loadInvestors(), entities });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

type Body = {
  action?: "add_investor" | "add_entity" | "status" | "suggest" | "clear";
  label?: string;
  note?: string;
  investor?: string;
  name?: string;
  kind?: string;
  id?: number;
  status?: EntityStatus | "delete";
};

/** POST: add an investor / name, confirm / reject / delete a name, or ask for suggestions. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Body;
  try {
    if (body.action === "add_investor") {
      return NextResponse.json({ ok: true, investor: addInvestor(String(body.label || ""), body.note) });
    }
    if (body.action === "add_entity") {
      addEntity(String(body.investor || ""), String(body.name || ""), body.kind);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "status" && body.id != null && body.status) {
      setEntityStatus(Number(body.id), body.status);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "clear") {
      return NextResponse.json({ ok: true, removed: clearSuggestions(body.investor) });
    }
    if (body.action === "suggest") {
      const ids = body.investor ? [body.investor] : loadInvestors().map((i) => i.id);
      const results: Record<string, { asked: number; suggested: number; rejected: number } | { error: string }> = {};
      for (const id of ids) {
        try {
          results[id] = await suggestEntities(id);
        } catch (e) {
          results[id] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      return NextResponse.json({ ok: true, results });
    }
    return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
