import { NextRequest, NextResponse } from "next/server";
import {
  deleteNote,
  getNote,
  listNotes,
  notesTickerSet,
  upsertNote,
} from "@/lib/notes";
import { listAttachments, noteAiContext } from "@/lib/note-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?ticker=XYZ → one note + screenshots; else list all + count. */
export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "").trim();
  if (ticker) {
    const note = getNote(ticker);
    const attachments = listAttachments(ticker);
    const ai = noteAiContext(ticker);
    return NextResponse.json({
      ok: true,
      ticker: ticker.toUpperCase(),
      note,
      attachments,
      ai_text: ai.combined,
      has_note: !!note || attachments.length > 0,
    });
  }
  const notes = listNotes();
  return NextResponse.json({
    ok: true,
    count: notesTickerSet().size,
    notes,
  });
}

/** PUT/POST { ticker, body } — empty body clears. */
export async function PUT(req: NextRequest) {
  let body: { ticker?: string; body?: string } = {};
  try {
    body = (await req.json()) as { ticker?: string; body?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const ticker = (body.ticker || "").trim();
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }
  const note = upsertNote(ticker, body.body ?? "");
  return NextResponse.json({
    ok: true,
    ticker: ticker.toUpperCase(),
    note,
    has_note: !!note,
  });
}

export async function POST(req: NextRequest) {
  return PUT(req);
}

export async function DELETE(req: NextRequest) {
  const ticker =
    req.nextUrl.searchParams.get("ticker") ||
    ((await req.json().catch(() => ({}))) as { ticker?: string }).ticker ||
    "";
  if (!ticker.trim()) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }
  const removed = deleteNote(ticker);
  return NextResponse.json({
    ok: true,
    ticker: ticker.trim().toUpperCase(),
    removed,
    has_note: false,
  });
}
