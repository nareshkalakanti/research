import { NextRequest, NextResponse } from "next/server";
import {
  downloadOrderbookPdf,
  isOrderbookPdfProxyUrl,
  listOrderbookHistory,
  refreshOrderbookHistoryPrices,
  screenOrderbookPdf,
} from "@/lib/orderbook-screen";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
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
    history,
    required_fields: [
      "Ticker / Company",
      "Announcement date",
      "Awarding entity",
      "Order size",
      "Execution",
      "Order ₹ Cr",
      "Annual sales",
      "Order / Sales % (≥50% PASS)",
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
      const file = form.get("file");
      let pdfBuffer: Buffer | null = null;
      if (file && typeof file === "object" && "arrayBuffer" in file) {
        const ab = await (file as File).arrayBuffer();
        pdfBuffer = Buffer.from(ab);
      }
      const result = await screenOrderbookPdf({ url, pdfBuffer });
      return NextResponse.json(result, {
        status: result.ok ? 200 : 422,
      });
    }

    let body: { url?: string } = {};
    try {
      body = (await req.json()) as { url?: string };
    } catch {
      body = {};
    }
    const url = body.url?.trim() || null;
    if (!url) {
      return NextResponse.json(
        { ok: false, error: "Provide url or multipart file" },
        { status: 400 },
      );
    }
    const result = await screenOrderbookPdf({ url });
    return NextResponse.json(result, {
      status: result.ok ? 200 : 422,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Orderbook screen failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 503 });
  }
}
