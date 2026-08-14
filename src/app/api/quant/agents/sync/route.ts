import { NextRequest, NextResponse } from "next/server";
import {
  getQuantRunState,
  isQuantRunBusy,
  syncQuantScanCards,
} from "@/lib/agents/quant-runner";
import type { QuantListMarket } from "@/lib/agents/quant-shortlist";
import type { CapTier } from "@/lib/types";

export const runtime = "nodejs";
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

export async function POST(req: NextRequest) {
  if (isQuantRunBusy()) {
    return NextResponse.json(
      { ok: false, error: "Quant run in progress" },
      { status: 409 },
    );
  }

  let market: QuantListMarket = "NSE";
  let cap: CapTier | "All" = "All";
  try {
    const body = (await req.json()) as { market?: string; cap?: string };
    market = parseMarket(body.market);
    cap = parseCap(body.cap);
  } catch {
    /* defaults */
  }

  syncQuantScanCards(market, cap);
  return NextResponse.json({ ok: true, state: getQuantRunState() });
}
