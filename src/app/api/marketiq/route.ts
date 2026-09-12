import { NextRequest, NextResponse } from "next/server";
import {
  analyseMarketIqAnnouncement,
  analyseMarketIqHit,
  discoverMarketIqAnnounced,
  extractMarketIqPdf,
  listMarketIqHistory,
  listScoredMarketIqUrls,
  loadLdrAnnouncementCategories,
  saveMarketIqHits,
  scanMarketIqAnnouncements,
  type MarketIqHit,
} from "@/lib/marketiq-screen";
import { MARKETIQ_DB_FILE } from "@/lib/iq-dbs";
import {
  announcedCacheGet,
  announcedCacheKey,
  announcedCacheSet,
} from "@/lib/announced-cache";
import { clampAnnouncedDays } from "@/lib/announced-lookback";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  if (sp.get("categories") === "1") {
    const cat = loadLdrAnnouncementCategories();
    return NextResponse.json({ ok: true, ...cat });
  }

  if (sp.get("history") === "1" || sp.get("limit")) {
    const limit = Math.min(
      200,
      Math.max(1, Number(sp.get("limit") || 40) || 40),
    );
    return NextResponse.json({
      ok: true,
      db: MARKETIQ_DB_FILE,
      history: listMarketIqHistory(limit),
    });
  }

  if (sp.get("screened") === "1") {
    const urls = [...listScoredMarketIqUrls()];
    return NextResponse.json({
      ok: true,
      db: MARKETIQ_DB_FILE,
      urls,
      count: urls.length,
    });
  }

  if (sp.get("announced") === "1" || sp.get("announced") === "today") {
    const days = clampAnnouncedDays(Number(sp.get("days") || 1) || 1);
    const q = sp.get("q")?.trim() || null;
    const bust = sp.get("fresh") === "1";
    const cacheKey = announcedCacheKey("marketiq", days, q);
    if (!bust) {
      const cached = announcedCacheGet<Record<string, unknown>>(cacheKey);
      if (cached) {
        return NextResponse.json({ ...cached, cached: true });
      }
    }
    try {
      const found = await discoverMarketIqAnnounced(days, { q });
      announcedCacheSet(cacheKey, found);
      return NextResponse.json({ ...found, cached: false });
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: e instanceof Error ? e.message : "NSE announcement fetch failed",
        },
        { status: 422 },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    usage: {
      announced: "?announced=1&days=1&q=",
      history: "?history=1&limit=40",
      categories: "?categories=1",
      save: "POST { action: 'save', sources: [...] }",
      analyse:
        "POST { action: 'analyse', url?, ticker?, company?, title?, announced_at?, historyId?, bufferBase64? } or { action: 'analyse', sources: [...] }",
      extract: "POST { action: 'extract', url? | bufferBase64? }",
      scan: "POST { action: 'scan', days?, limit?, pendingOnly?, sources?, skipOcr? }",
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action?: string;
      sources?: MarketIqHit[];
      url?: string | null;
      ticker?: string | null;
      company?: string | null;
      title?: string | null;
      announced_at?: string | null;
      historyId?: number | null;
      bufferBase64?: string | null;
      skipOcr?: boolean;
      days?: number;
      limit?: number;
      pendingOnly?: boolean;
      q?: string | null;
    };

    if (body.action === "save") {
      const sources = Array.isArray(body.sources) ? body.sources : [];
      const saved = saveMarketIqHits(sources);
      return NextResponse.json({
        ok: true,
        saved,
        history: listMarketIqHistory(40),
      });
    }

    if (body.action === "scan") {
      const scanned = await scanMarketIqAnnouncements({
        days: body.days,
        q: body.q,
        limit: body.limit,
        pendingOnly: body.pendingOnly,
        sources: Array.isArray(body.sources) ? body.sources : null,
        skipOcr: body.skipOcr,
      });
      return NextResponse.json({
        ...scanned,
        history: listMarketIqHistory(200),
      });
    }

    if (body.action === "extract" || body.action === "analyse") {
      let buffer: Buffer | null = null;
      if (body.bufferBase64?.trim()) {
        try {
          buffer = Buffer.from(body.bufferBase64, "base64");
        } catch {
          return NextResponse.json(
            { ok: false, error: "Invalid PDF base64" },
            { status: 400 },
          );
        }
      }

      if (body.action === "extract") {
        const result = await extractMarketIqPdf({
          url: body.url,
          buffer,
          skipOcr: body.skipOcr !== false,
        });
        return NextResponse.json(result);
      }

      const sources = Array.isArray(body.sources) ? body.sources : null;
      if (sources?.length) {
        const capped = sources.slice(0, 8);
        const results = [];
        for (const s of capped) {
          results.push(await analyseMarketIqHit(s));
        }
        const okCount = results.filter((r) => r.ok).length;
        return NextResponse.json({
          ok: okCount > 0,
          analysed: okCount,
          attempted: capped.length,
          results,
          history: listMarketIqHistory(80),
          error:
            okCount === 0
              ? results[0]?.error || "Analyse failed"
              : undefined,
        });
      }

      const result = await analyseMarketIqAnnouncement({
        url: body.url,
        buffer,
        tickerHint: body.ticker,
        companyHint: body.company,
        titleHint: body.title,
        announcedAt: body.announced_at,
        historyId: body.historyId ?? null,
        allowHeadlineOnly: true,
        skipOcr: body.skipOcr === true,
      });
      return NextResponse.json({
        ...result,
        history: listMarketIqHistory(80),
      });
    }

    return NextResponse.json(
      { ok: false, error: "Unknown action" },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "MarketIQ POST failed",
      },
      { status: 500 },
    );
  }
}
