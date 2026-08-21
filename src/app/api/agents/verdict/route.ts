import { NextRequest, NextResponse } from "next/server";
import { getAgentRunState } from "@/lib/agents/runner";

export const dynamic = "force-dynamic";

/** GET ?ticker= — latest AI verdict for one symbol from the in-memory agent run. */
export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker")?.trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json({ verdict: null }, { status: 400 });
  }

  const state = getAgentRunState();
  const verdict =
    state.verdicts.find((v) => v.symbol.toUpperCase() === ticker) ?? null;

  return NextResponse.json({
    verdict,
    source: verdict ? state.mode ?? "run" : null,
  });
}
