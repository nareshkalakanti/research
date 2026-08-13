import { NextRequest, NextResponse } from "next/server";
import {
  addAttachment,
  deleteAttachment,
  listAttachments,
} from "@/lib/note-attachments";
import { invalidateNotesCache } from "@/lib/notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?ticker=XYZ — list screenshots for a note. */
export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "").trim();
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }
  const attachments = listAttachments(ticker);
  return NextResponse.json({
    ok: true,
    ticker: ticker.toUpperCase(),
    attachments,
    count: attachments.length,
  });
}

/** POST multipart: ticker + files[] — upload one or more screenshots. */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const ticker = String(form.get("ticker") || "").trim();
    if (!ticker) {
      return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
    }

    const files: File[] = [];
    for (const [key, val] of form.entries()) {
      if (val instanceof File && val.size > 0) {
        if (key === "file" || key === "files" || key.startsWith("file")) {
          files.push(val);
        }
      }
    }
    // Also accept any File values if named oddly
    if (!files.length) {
      for (const val of form.values()) {
        if (val instanceof File && val.size > 0) files.push(val);
      }
    }
    if (!files.length) {
      return NextResponse.json(
        { ok: false, error: "No image files uploaded" },
        { status: 400 },
      );
    }

    const uploaded = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        const buf = Buffer.from(await file.arrayBuffer());
        const mime = file.type || "image/png";
        const att = await addAttachment({
          ticker,
          buffer: buf,
          mime,
          originalName: file.name,
        });
        uploaded.push(att);
      } catch (e) {
        errors.push(
          `${file.name || "file"}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    invalidateNotesCache();
    return NextResponse.json({
      ok: uploaded.length > 0,
      ticker: ticker.toUpperCase(),
      attachments: listAttachments(ticker),
      uploaded,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Upload failed",
      },
      { status: 500 },
    );
  }
}

/** DELETE ?id=123 — remove one screenshot. */
export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }
  const removed = deleteAttachment(id);
  invalidateNotesCache();
  return NextResponse.json({ ok: true, removed });
}
