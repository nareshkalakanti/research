import { NextRequest, NextResponse } from "next/server";
import {
  closePaperTrade,
  deletePaperTrade,
  listPaperPositions,
  openPaperTrade,
} from "@/lib/agents/paper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — list mock positions with live P&L. */
export async function GET(req: NextRequest) {
  const status = (req.nextUrl.searchParams.get("status") || "all") as
    | "open"
    | "closed"
    | "all";
  try {
    const data = await listPaperPositions({ status });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to load paper trades",
      },
      { status: 500 },
    );
  }
}

/** POST — open a mock buy (e.g. ₹10,000 of top pick). */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      symbol?: string;
      amountInr?: number;
      entryPrice?: number | null;
      confidence?: number | null;
      source?: string | null;
      name?: string | null;
      market?: string | null;
    };
    if (!body.symbol?.trim()) {
      return NextResponse.json({ error: "symbol required" }, { status: 400 });
    }
    const amount = Number(body.amountInr ?? 10_000);
    const position = await openPaperTrade({
      symbol: body.symbol,
      amountInr: amount,
      entryPrice: body.entryPrice,
      confidence: body.confidence,
      source: body.source ?? "top_pick",
      name: body.name,
      market: body.market,
    });
    const data = await listPaperPositions({ status: "all" });
    return NextResponse.json({ position, ...data });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to open mock trade",
      },
      { status: 400 },
    );
  }
}

/** PATCH — close a mock trade or refresh. */
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action?: "close" | "refresh";
      id?: number;
    };
    if (body.action === "refresh") {
      const data = await listPaperPositions({ status: "all" });
      return NextResponse.json(data);
    }
    if (body.action === "close") {
      const id = Number(body.id);
      if (!Number.isFinite(id)) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }
      const closed = await closePaperTrade(id);
      if (!closed) {
        return NextResponse.json({ error: "Trade not found" }, { status: 404 });
      }
      const data = await listPaperPositions({ status: "all" });
      return NextResponse.json({ position: closed, ...data });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Paper trade update failed",
      },
      { status: 500 },
    );
  }
}

/** DELETE — remove a mock trade. */
export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  deletePaperTrade(id);
  const data = await listPaperPositions({ status: "all" });
  return NextResponse.json(data);
}
