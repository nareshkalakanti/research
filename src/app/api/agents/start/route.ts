import { NextRequest, NextResponse } from "next/server";
import {
  getAgentRunState,
  isAgentRunBusy,
  startAgentRun,
} from "@/lib/agents/runner";
import type { ListMarket, RunMode } from "@/lib/agents/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function parseList(raw: unknown): ListMarket {
  if (
    raw === "NSE SME" ||
    raw === "All" ||
    raw === "Hold" ||
    raw === "Edge"
  ) {
    return raw;
  }
  return "NSE";
}

export async function POST(req: NextRequest) {
  if (isAgentRunBusy()) {
    return NextResponse.json(
      { ok: false, error: "Agent run already in progress" },
      { status: 409 },
    );
  }

  let mode: RunMode = "demo";
  let list: ListMarket = "NSE";
  try {
    const body = (await req.json()) as { mode?: string; list?: string };
    if (body.mode === "live") mode = "live";
    list = parseList(body.list);
  } catch {
    /* defaults */
  }

  void startAgentRun(mode, list);

  return NextResponse.json({
    ok: true,
    started: true,
    mode,
    list,
    state: getAgentRunState(),
  });
}
