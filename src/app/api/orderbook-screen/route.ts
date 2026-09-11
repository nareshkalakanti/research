import { NextRequest, NextResponse } from "next/server";
import { loadHoldings } from "@/lib/holdings";
import {
  discoverOrderbookAnnounced,
  discoverOrderbookPdfSources,
  downloadOrderbookPdf,
  extractOrderbookPdf,
  isOrderbookPdfProxyUrl,
  listOrderbookHistory,
  listOrderbookScreenedUrls,
  ORDERBOOK_PASS_MIN_PCT,
  refreshOrderbookHistoryPrices,
  scanOrderbookAnnouncements,
  screenOrderbookForTicker,
  screenOrderbookPdf,
  type OrderbookAnnouncedHit,
} from "@/lib/orderbook-screen";
import { ORDERBOOKIQ_DB_FILE } from "@/lib/iq-dbs";

export const runtime = "nodejs";
export const maxDuration = 300;

function bufferFromBase64(raw: string | null | undefined): Buffer | null {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    return Buffer.from(s, "base64");
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const announced = req.nextUrl.searchParams.get("announced");
  if (announced === "1" || announced === "today") {
    const days = Math.min(
      7,
      Math.max(1, Number(req.nextUrl.searchParams.get("days") || 1) || 1),
    );
    try {
      const found = await discoverOrderbookAnnounced(days);
      return NextResponse.json(found);
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: e instanceof Error ? e.message : "Announced scan failed",
        },
        { status: 422 },
      );
    }
  }

  const discoverTicker = req.nextUrl.searchParams.get("discover")?.trim() || "";
  if (discoverTicker) {
    try {
      const found = await discoverOrderbookPdfSources(discoverTicker);
      return NextResponse.json(found);
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: e instanceof Error ? e.message : "Discover failed",
        },
        { status: 422 },
      );
    }
  }

  if (req.nextUrl.searchParams.get("holdings") === "1") {
    const holdings = loadHoldings().map((h) => ({
      ticker: h.ticker.toUpperCase(),
      name: h.name,
      market: h.market,
    }));
    return NextResponse.json({
      ok: true,
      holdings,
      count: holdings.length,
    });
  }

  if (req.nextUrl.searchParams.get("screened") === "1") {
    const urls = [...listOrderbookScreenedUrls()];
    return NextResponse.json({
      ok: true,
      db: ORDERBOOKIQ_DB_FILE,
      urls,
      count: urls.length,
    });
  }

  const pdfUrl = req.nextUrl.searchParams.get("pdf")?.trim() || "";
  if (pdfUrl) {
    if (!isOrderbookPdfProxyUrl(pdfUrl)) {
      return NextResponse.json(
        { ok: false, error: "PDF host not allowed" },
        { status: 400 },
      );
    }
    const buf = await downloadOrderbookPdf(pdfUrl);
    if (!buf) {
      return NextResponse.json(
        { ok: false, error: "Could not fetch PDF" },
        { status: 502 },
      );
    }
    const asDownload = req.nextUrl.searchParams.get("download") === "1";
    const nameFromUrl = (() => {
      try {
        const path = new URL(pdfUrl).pathname;
        const base = path.split("/").pop() || "";
        if (/\.pdf$/i.test(base)) return base.slice(0, 120);
      } catch {
        /* ignore */
      }
      return "orderbook.pdf";
    })();
    const disposition = asDownload
      ? `attachment; filename="${nameFromUrl}"`
      : `inline; filename="${nameFromUrl}"`;
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": disposition,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const limit = Math.min(
    200,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 40) || 40),
  );
  const refresh = req.nextUrl.searchParams.get("prices") !== "0";
  let history = listOrderbookHistory(limit);
  if (refresh && history.length) {
    history = await refreshOrderbookHistoryPrices(history);
  }
  return NextResponse.json({
    ok: true,
    db: ORDERBOOKIQ_DB_FILE,
    history,
    pass_min_pct: ORDERBOOK_PASS_MIN_PCT,
    required_fields: [
      "Ticker / Company",
      "Announcement date",
      "Awarding entity",
      "Order size",
      "Execution",
      "Order ₹ Cr",
      "Annual sales",
      `Order / Sales % (≥${ORDERBOOK_PASS_MIN_PCT}% PASS)`,
      "LTP",
      "Δ order % (post announcement)",
    ],
  });
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const url = String(form.get("url") || "").trim() || null;
      const ticker = String(form.get("ticker") || "").trim() || null;
      const announced_at =
        String(form.get("announced_at") || "").trim() || null;
      const modeRaw = String(form.get("mode") || "").trim().toLowerCase();
      const mode = modeRaw === "llm" ? "llm" : "lexical";
      const file = form.get("file");
      let pdfBuffer: Buffer | null = null;
      if (file && typeof file === "object" && "arrayBuffer" in file) {
        const ab = await (file as File).arrayBuffer();
        pdfBuffer = Buffer.from(ab);
      }
      const result = await screenOrderbookPdf({
        url,
        pdfBuffer,
        ticker,
        mode,
        announced_at,
      });
      return NextResponse.json(result, {
        status: result.ok ? 200 : 422,
      });
    }

    let body: {
      url?: string;
      action?: string;
      ticker?: string;
      company?: string;
      mode?: string;
      announced_at?: string;
      days?: number;
      limit?: number;
      pendingOnly?: boolean;
      sources?: OrderbookAnnouncedHit[] | null;
      skipUrls?: string[] | null;
      bufferBase64?: string | null;
      skipOcr?: boolean;
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }

    const mode =
      String(body.mode || "").trim().toLowerCase() === "lexical"
        ? "lexical"
        : "llm";

    if (body.action === "discover") {
      const found = await discoverOrderbookPdfSources(
        body.ticker || body.url || "",
      );
      return NextResponse.json(found);
    }

    if (body.action === "screen-ticker") {
      const ticker = (body.ticker || "").trim();
      if (!ticker) {
        return NextResponse.json(
          { ok: false, error: "Provide ticker" },
          { status: 400 },
        );
      }
      const result = await screenOrderbookForTicker(ticker, { mode });
      return NextResponse.json(result, {
        status: result.ok || result.decision === "fail" ? 200 : 422,
      });
    }

    if (body.action === "extract") {
      const pdfBuffer = bufferFromBase64(body.bufferBase64);
      const result = await extractOrderbookPdf({
        url: body.url?.trim() || null,
        pdfBuffer,
        skipOcr: body.skipOcr !== false,
      });
      return NextResponse.json(result, {
        status: result.ok ? 200 : 422,
      });
    }

    if (body.action === "scan") {
      const result = await scanOrderbookAnnouncements({
        days: body.days,
        limit: body.limit,
        pendingOnly: body.pendingOnly,
        sources: body.sources ?? null,
        mode,
        skipUrls: Array.isArray(body.skipUrls) ? body.skipUrls : null,
      });
      return NextResponse.json(result);
    }

    if (body.action === "analyse") {
      const pdfBuffer = bufferFromBase64(body.bufferBase64);
      const url = body.url?.trim() || null;
      if (!url && !pdfBuffer) {
        return NextResponse.json(
          { ok: false, error: "Provide url or bufferBase64" },
          { status: 400 },
        );
      }
      const result = await screenOrderbookPdf({
        url,
        pdfBuffer,
        ticker: body.ticker || null,
        company: body.company || null,
        mode,
        announced_at: body.announced_at || null,
      });
      return NextResponse.json(
        {
          ...result,
          history: listOrderbookHistory(200),
        },
        {
          status: result.ok || result.decision === "fail" ? 200 : 422,
        },
      );
    }

    const url = body.url?.trim() || null;
    if (!url) {
      return NextResponse.json(
        { ok: false, error: "Provide url or multipart file" },
        { status: 400 },
      );
    }
    const result = await screenOrderbookPdf({
      url,
      ticker: body.ticker || null,
      company: body.company || null,
      mode,
      announced_at: body.announced_at || null,
    });
    return NextResponse.json(result, {
      status: result.ok ? 200 : 422,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Orderbook screen failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 503 });
  }
}
