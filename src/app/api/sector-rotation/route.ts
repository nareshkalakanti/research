import { NextRequest, NextResponse } from "next/server";
import { bootstrapCompanyTicker } from "@/lib/company-ticker-bootstrap";
import { invalidateCompanyCache } from "@/lib/db";
import {
  addRotationMember,
  createRotationSector,
  deleteRotationSector,
  getRotationSector,
  listRotationSectors,
  removeRotationMember,
  renameRotationSector,
  setRotationStarred,
} from "@/lib/sector-rotation";
import {
  buildRotationBoard,
  buildRotationDetail,
} from "@/lib/sector-rotation-board";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const range = sp.get("range") || "6M";
  const weight = sp.get("weight") === "cap" ? "cap" : "equal";
  const id = (sp.get("id") || "").trim();
  try {
    if (sp.get("summary") === "1") {
      const rows = listRotationSectors().map((s) => ({
        id: s.id,
        label: s.label,
        n: s.members.length,
        starred: s.starred,
      }));
      return NextResponse.json({
        ok: true,
        n: rows.length,
        sectors: rows,
      });
    }
    if (id) {
      const sector = getRotationSector(id);
      if (!sector) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      if (sp.get("members") === "1") {
        return NextResponse.json({ ok: true, sector });
      }
      const detail = await buildRotationDetail(sector, range, weight);
      return NextResponse.json({ ok: true, ...detail });
    }
    const board = await buildRotationBoard(range, weight);
    return NextResponse.json({
      ok: true,
      list: listRotationSectors(),
      ...board,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: {
    create?: boolean;
    label?: string;
    id?: string;
    rename?: boolean;
    deleteSector?: boolean;
    add?: boolean;
    remove?: boolean;
    star?: boolean;
    starred?: boolean;
    ticker?: string;
    name?: string;
    market?: string;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  try {
    if (body.create) {
      const sector = createRotationSector(body.label || "");
      return NextResponse.json({ ok: true, sector });
    }
    const id = (body.id || "").trim();
    if (!id) {
      return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
    }
    if (body.rename) {
      renameRotationSector(id, body.label || "");
      return NextResponse.json({ ok: true, sector: getRotationSector(id) });
    }
    if (body.star) {
      setRotationStarred(id, Boolean(body.starred));
      return NextResponse.json({ ok: true, sector: getRotationSector(id) });
    }
    if (body.deleteSector) {
      deleteRotationSector(id);
      return NextResponse.json({ ok: true });
    }
    if (body.add) {
      const ticker = (body.ticker || "").trim().toUpperCase();
      if (!ticker) {
        return NextResponse.json(
          { ok: false, error: "ticker required" },
          { status: 400 },
        );
      }
      addRotationMember(id, {
        ticker,
        name: body.name || ticker,
        market: body.market || "NSE",
      });
      void bootstrapCompanyTicker(ticker, {
        name: body.name || ticker,
        market: body.market || null,
      })
        .then(() => invalidateCompanyCache())
        .catch((err) =>
          console.warn(
            "[rotation] about bootstrap skipped:",
            err instanceof Error ? err.message : err,
          ),
        );
      return NextResponse.json({ ok: true, sector: getRotationSector(id) });
    }
    if (body.remove) {
      removeRotationMember(id, body.ticker || "");
      return NextResponse.json({ ok: true, sector: getRotationSector(id) });
    }
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
