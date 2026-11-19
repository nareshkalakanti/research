import { NextRequest, NextResponse } from "next/server";
import { deleteScan, listScans, saveScan, type ScanConfig } from "@/lib/scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: saved scans, newest first. */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, scans: listScans() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** POST {action: "save", id?, name, config} | {action: "delete", id}. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    id?: number | null;
    name?: string;
    config?: ScanConfig;
  };
  try {
    if (body.action === "delete" && body.id != null) {
      deleteScan(Number(body.id));
      return NextResponse.json({ ok: true, scans: listScans() });
    }
    if (body.action === "save" && body.config) {
      const scan = saveScan(String(body.name || ""), body.config, body.id ?? null);
      return NextResponse.json({ ok: true, scan, scans: listScans() });
    }
    return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
