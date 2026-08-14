import { NextRequest, NextResponse } from "next/server";
import {
  getQuantRunState,
  isQuantRunBusy,
  startQuantRun,
} from "@/lib/agents/quant-runner";
import type { QuantListMarket } from "@/lib/agents/quant-shortlist";
import type { RunMode } from "@/lib/agents/types";
import type { CapTier } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function parseMarket(raw: unknown): QuantListMarket {
  if (
    raw === "NSE SME" ||
    raw === "BSE SME" ||
    raw === "All"
  ) {
    return raw;
  }
  return "NSE";
}

function parseCap(raw: unknown): CapTier | "All" {
  if (
    raw === "NC" ||
    raw === "TI" ||
    raw === "MIC" ||
    raw === "SC" ||
    raw === "MC" ||
    raw === "LC"
  ) {
    return raw;
  }
  return "All";
}

type QuantSignalMode = "tq" | "bb" | "either" | "both";

function parseSignal(raw: unknown): QuantSignalMode {
  if (raw === "tq" || raw === "bb" || raw === "both") return raw;
  return "either";
}

export async function POST(req: NextRequest) {
  if (isQuantRunBusy()) {
    return NextResponse.json(
      { ok: false, error: "Quant run already in progress" },
      { status: 409 },
    );
  }

  let mode: RunMode = "demo";
  let market: QuantListMarket = "NSE";
  let cap: CapTier | "All" = "All";
  let signal: QuantSignalMode = "either";
  try {
    const body = (await req.json()) as {
      mode?: string;
      market?: string;
      cap?: string;
      signal?: string;
    };
    if (body.mode === "live") mode = "live";
    market = parseMarket(body.market);
    cap = parseCap(body.cap);
    signal = parseSignal(body.signal);
  } catch {
    /* defaults */
  }

  void startQuantRun({ mode, market, cap, signal });

  return NextResponse.json({
    ok: true,
    started: true,
    mode,
    market,
    cap,
    signal,
    state: getQuantRunState(),
  });
}
