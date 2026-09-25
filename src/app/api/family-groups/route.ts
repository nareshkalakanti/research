import { NextRequest, NextResponse } from "next/server";
import {
  addFamilyGroupTicker,
  removeFamilyGroupTicker,
  renameFamilyGroup,
  searchListedCompanies,
} from "@/lib/family-group-edits";
import { loadGovernanceFamilyMap } from "@/lib/governance-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (q) {
    return NextResponse.json({
      ok: true as const,
      rows: searchListedCompanies(q, 12),
    });
  }
  return NextResponse.json({ ok: false, error: "Need q" }, { status: 400 });
}

export async function POST(req: NextRequest) {
  let body: {
    group_id?: string;
    label?: string;
    ticker?: string;
    rename?: boolean;
    add?: boolean;
    remove?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const groupId = (body.group_id || "").trim();
  if (!groupId) {
    return NextResponse.json({ ok: false, error: "Need group_id" }, { status: 400 });
  }
  if (body.rename) {
    const saved = renameFamilyGroup(groupId, body.label || "");
    if (!saved) {
      return NextResponse.json({ ok: false, error: "Need a group name" }, { status: 400 });
    }
  } else if (body.add) {
    const saved = addFamilyGroupTicker(groupId, body.ticker || "");
    if (!saved) {
      return NextResponse.json({ ok: false, error: "Need a ticker" }, { status: 400 });
    }
  } else if (body.remove) {
    const saved = removeFamilyGroupTicker(groupId, body.ticker || "");
    if (!saved) {
      return NextResponse.json({ ok: false, error: "Need a ticker" }, { status: 400 });
    }
  } else {
    return NextResponse.json({ ok: false, error: "Need rename, add, or remove" }, { status: 400 });
  }
  const families = loadGovernanceFamilyMap();
  const row = families.find((g) => g.group_id === groupId) || null;
  return NextResponse.json({ ok: true as const, group: row, total: families.length });
}
