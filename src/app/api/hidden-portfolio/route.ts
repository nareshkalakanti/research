import { NextRequest, NextResponse } from "next/server";
import { loadHiddenUniverse } from "@/lib/hidden-portfolio/universe";
import {
  loadHiddenPortfolioView,
  runHiddenPortfolioScan,
} from "@/lib/hidden-portfolio/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET — cached candidates + universe size. */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const minScore = Number(sp.get("minScore") || "0") || 0;
    const limit = Math.min(500, Number(sp.get("limit") || "100") || 100);
    const universe = loadHiddenUniverse({
      includeDbSme: sp.get("db") !== "0",
    });
    const view = loadHiddenPortfolioView({ minScore, limit });
    return NextResponse.json(
      {
        ok: true,
        universe_count: universe.length,
        run: view.run,
        candidates: view.candidates,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}

type ScanBody = {
  symbols?: string[];
  limit?: number;
  force?: boolean;
  writeReport?: boolean;
  includeDbSme?: boolean;
  /** NDJSON progress stream (default true from UI). */
  stream?: boolean;
};

function progressLabel(symbol: string, status: string): string {
  if (status === "start") return `Queued ${symbol}`;
  if (status === "fundamentals") return `${symbol} · fundamentals`;
  if (status === "news") return `${symbol} · news catalysts`;
  if (status === "cache") return `${symbol} · cache hit`;
  if (status.startsWith("score")) return `${symbol} · ${status}`;
  if (status.startsWith("error")) return `${symbol} · error`;
  return `${symbol} · ${status}`;
}

function progressPct(done: number, total: number, status: string): number {
  if (total <= 0) return 0;
  const base = done / total;
  // Mid-symbol steps: nudge bar forward before completion of that ticker.
  const bump =
    status === "fundamentals"
      ? 0.15
      : status === "news"
        ? 0.45
        : status === "start"
          ? 0.05
          : 0;
  return Math.min(99, Math.round((base + bump / total) * 100));
}

/**
 * POST — run scan.
 * Body: { symbols?, limit?, force?, writeReport?, stream? }
 * When stream=true, responds with NDJSON progress + final result.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as ScanBody;
  const stream = body.stream === true;

  const scanOpts = {
    symbols: body.symbols,
    limit: body.limit ?? (body.symbols?.length ? undefined : 5),
    force: body.force === true,
    writeReport: body.writeReport !== false,
    includeDbSme: body.includeDbSme !== false,
  };

  if (!stream) {
    try {
      const result = await runHiddenPortfolioScan(scanOpts);
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        },
        { status: 500 },
      );
    }
  }

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };

      try {
        send({
          type: "start",
          label: "Starting Hidden Portfolio scan",
          pct: 1,
          detail: "Connecting…",
        });

        const result = await runHiddenPortfolioScan({
          ...scanOpts,
          onProgress: (p) => {
            send({
              type: "progress",
              done: p.done,
              total: p.total,
              symbol: p.symbol,
              status: p.status,
              pct: progressPct(p.done, p.total, p.status),
              label: progressLabel(p.symbol, p.status),
              detail: `${p.done}/${p.total} · ${p.status}`,
            });
          },
        });

        send({
          type: "done",
          pct: 100,
          label: "Scan complete",
          detail: `Universe ${result.universe_count} · filtered ${result.filtered_count}`,
          ok: true,
          ...result,
        });
      } catch (e) {
        send({
          type: "error",
          pct: 100,
          label: "Scan failed",
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
