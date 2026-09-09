import { NextResponse } from "next/server";
import { loadCorporateEventKeywords } from "@/lib/corporate-event-keywords";

export const runtime = "nodejs";

export async function GET() {
  try {
    const data = loadCorporateEventKeywords();
    return NextResponse.json({
      ok: true,
      count: data.count,
      keywords: data.keywords,
      concall_focus: data.concall_focus,
      families: Object.keys(data.families).sort((a, b) =>
        a.localeCompare(b),
      ),
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Failed to load keywords",
      },
      { status: 500 },
    );
  }
}
