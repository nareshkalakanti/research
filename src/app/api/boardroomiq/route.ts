import { NextRequest, NextResponse } from "next/server";
import {
  analyseBoardRoomAnnouncement,
  discoverBoardRoomAnnounced,
  listBoardRoomHistory,
  listScreenedBoardRoomUrls,
  loadLdrGovernanceCategories,
  pushBoardRoomHistoryToGovernance,
  saveBoardRoomHits,
  scanBoardRoomAnnouncements,
  type BoardRoomHit,
} from "@/lib/boardroom-screen";
import { BOARDROOMIQ_DB_FILE } from "@/lib/iq-dbs";
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
    const cat = loadLdrGovernanceCategories();
    return NextResponse.json({ ok: true, ...cat });
  }

  if (sp.get("history") === "1" || sp.get("limit")) {
    const limit = Math.min(
      200,
      Math.max(1, Number(sp.get("limit") || 40) || 40),
    );
    return NextResponse.json({
      ok: true,
      db: BOARDROOMIQ_DB_FILE,
      history: listBoardRoomHistory(limit),
    });
  }

  if (sp.get("screened") === "1") {
    const urls = [...listScreenedBoardRoomUrls()];
    return NextResponse.json({
      ok: true,
      db: BOARDROOMIQ_DB_FILE,
      urls,
      count: urls.length,
    });
  }

  if (sp.get("announced") === "1" || sp.get("announced") === "today") {
    const days = clampAnnouncedDays(Number(sp.get("days") || 1) || 1);
    const q = sp.get("q")?.trim() || null;
    const bust = sp.get("fresh") === "1";
    const cacheKey = announcedCacheKey("boardroom", days, q);
    if (!bust) {
      const cached = announcedCacheGet<Record<string, unknown>>(cacheKey);
      if (cached) {
        return NextResponse.json({ ...cached, cached: true });
      }
    }
    try {
      const found = await discoverBoardRoomAnnounced(days, { q });
      announcedCacheSet(cacheKey, found);
      return NextResponse.json({ ...found, cached: false });
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error:
            e instanceof Error ? e.message : "NSE board announcement fetch failed",
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
        "POST { action: 'analyse', url?, ticker?, company?, title?, announced_at?, historyId? }",
      scan: "POST { action: 'scan', days?, limit?, pendingOnly?, sources?, q?, skipOcr? }",
      push_gov:
        "POST { action: 'push_gov', limit?, unclassifiedOnly? } — push saved DINs into governance.db",
    },
  });
}

export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    sources?: BoardRoomHit[] | null;
    url?: string | null;
    ticker?: string | null;
    company?: string | null;
    title?: string | null;
    announced_at?: string | null;
    historyId?: number | null;
    days?: number;
    limit?: number;
    pendingOnly?: boolean;
    q?: string | null;
    unclassifiedOnly?: boolean;
    skipOcr?: boolean;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const action = String(body.action || "").trim().toLowerCase();

  if (action === "save") {
    const sources = Array.isArray(body.sources) ? body.sources : [];
    const n = saveBoardRoomHits(sources);
    return NextResponse.json({
      ok: true,
      saved: n,
      history: listBoardRoomHistory(200),
    });
  }

  if (action === "scan") {
    try {
      const result = await scanBoardRoomAnnouncements({
        days: body.days,
        limit: body.limit,
        pendingOnly: body.pendingOnly,
        sources: body.sources ?? null,
        q: body.q,
        skipOcr: body.skipOcr === true,
      });
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: e instanceof Error ? e.message : "Scan failed",
        },
        { status: 422 },
      );
    }
  }

  if (action === "analyse") {
    try {
      const result = await analyseBoardRoomAnnouncement({
        url: body.url,
        ticker: body.ticker,
        company: body.company,
        title: body.title,
        announced_at: body.announced_at,
        historyId: body.historyId,
      });
      return NextResponse.json(result, {
        status: result.ok ? 200 : 422,
      });
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: e instanceof Error ? e.message : "Analyse failed",
        },
        { status: 422 },
      );
    }
  }

  if (action === "push_gov") {
    try {
      const result = pushBoardRoomHistoryToGovernance({
        limit: body.limit,
        unclassifiedOnly: body.unclassifiedOnly === true,
      });
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: e instanceof Error ? e.message : "Push to governance failed",
        },
        { status: 422 },
      );
    }
  }

  return NextResponse.json(
    { ok: false, error: "Unknown action" },
    { status: 400 },
  );
}
