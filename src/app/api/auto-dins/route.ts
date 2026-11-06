import { NextRequest, NextResponse } from "next/server";
import { previewAutoDins, saveAutoDins } from "@/lib/auto-dins";
import { inferDirectorCategory, type BoardSeat } from "@/lib/nse-governance";

export const runtime = "nodejs";
export const maxDuration = 180;

function asSeats(raw: unknown): BoardSeat[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const r = row as Record<string, unknown>;
      const designation = String(r.designation || "Director").trim() || "Director";
      return {
        din: String(r.din || "").replace(/\D/g, ""),
        name: String(r.name || "").trim(),
        designation,
        category: inferDirectorCategory(designation),
        source: String(r.source || "nse_filing_pdf"),
        as_of: "",
      } as BoardSeat;
    })
    .filter((s) => s.din.length === 8 && s.name.length >= 4);
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action?: string;
      ticker?: string;
      company?: string;
      seats?: unknown;
      maxPdfs?: number;
    };
    const action = (body.action || "preview").trim() || "preview";
    const ticker = (body.ticker || "").trim();

    if (action === "preview") {
      const preview = await previewAutoDins({
        ticker,
        maxPdfs: body.maxPdfs,
      });
      return NextResponse.json({ ok: true as const, ...preview });
    }

    if (action === "save") {
      const seats = asSeats(body.seats);
      if (!ticker) {
        return NextResponse.json(
          { ok: false, error: "Need ticker" },
          { status: 400 },
        );
      }
      if (!seats.length) {
        return NextResponse.json(
          { ok: false, error: "Need DIN seats" },
          { status: 400 },
        );
      }
      const saved = await saveAutoDins({
        ticker,
        company: body.company,
        seats,
      });
      return NextResponse.json({ ok: true as const, ...saved });
    }

    return NextResponse.json(
      { ok: false, error: "Need action preview or save" },
      { status: 400 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
