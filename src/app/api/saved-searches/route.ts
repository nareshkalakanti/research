import { NextRequest, NextResponse } from "next/server";
import {
  deleteSavedSearch,
  listSavedSearches,
  upsertSavedSearch,
  type SavedSearchScope,
} from "@/lib/saved-searches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseScope(raw: string | null): SavedSearchScope | null {
  if (raw === "theme" || raw === "watching") return raw;
  return null;
}

/** GET ?scope=theme|watching — list saved searches (newest first). */
export async function GET(req: NextRequest) {
  const scope = parseScope(req.nextUrl.searchParams.get("scope"));
  const rows = listSavedSearches(scope ?? undefined);
  return NextResponse.json({ ok: true, count: rows.length, searches: rows });
}

/** POST { name, pattern, theme_ids?, scope } — create or update by name+scope. */
export async function POST(req: NextRequest) {
  let body: {
    name?: string;
    pattern?: string;
    theme_ids?: string[];
    scope?: string;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const name = (body.name || "").trim();
  const pattern = (body.pattern || "").trim();
  const scope = parseScope(body.scope ?? null) ?? "theme";
  const theme_ids = Array.isArray(body.theme_ids)
    ? body.theme_ids.map((s) => String(s).trim()).filter(Boolean)
    : [];

  if (!name) {
    return NextResponse.json({ ok: false, error: "name required" }, { status: 400 });
  }
  if (!pattern && !theme_ids.length) {
    return NextResponse.json(
      { ok: false, error: "pattern or theme_ids required" },
      { status: 400 },
    );
  }

  try {
    const row = upsertSavedSearch({ name, pattern, theme_ids, scope });
    return NextResponse.json({ ok: true, search: row });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "save failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const idRaw = req.nextUrl.searchParams.get("id");
  const id = idRaw ? Number(idRaw) : NaN;
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }
  const removed = deleteSavedSearch(id);
  return NextResponse.json({ ok: true, id, removed });
}
