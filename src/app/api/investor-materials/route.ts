import { NextRequest, NextResponse } from "next/server";
import {
  deleteInvestorMaterial,
  discoverInvestorMaterialSources,
  importInvestorMaterialFromSource,
  importLatestInvestorMaterials,
  listInvestorMaterials,
  redistillInvestorMaterial,
  saveInvestorMaterial,
  toClientInvestorMaterial,
  type InvestorMaterialKind,
} from "@/lib/investor-materials";
import { firecrawlConfigured } from "@/lib/firecrawl-parse";
import { loadLlmConfig } from "@/lib/llm-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }

  if (req.nextUrl.searchParams.get("discover") === "1") {
    try {
      const found = await discoverInvestorMaterialSources(ticker);
      return NextResponse.json({
        ok: true,
        ticker,
        ...found,
        count: found.sources.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Discover failed";
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }
  }

  const materials = listInvestorMaterials(ticker).map(toClientInvestorMaterial);
  const cfg = loadLlmConfig();
  return NextResponse.json({
    ok: true,
    ticker,
    materials,
    count: materials.length,
    tools: {
      firecrawl: firecrawlConfigured(),
      llm: cfg.llmProvider !== "none",
    },
  });
}

export async function POST(req: NextRequest) {
  let body: {
    action?: "import" | "import_latest";
    ticker?: string;
    kind?: InvestorMaterialKind;
    title?: string;
    period?: string;
    text?: string;
    url?: string;
    distill?: boolean;
    limit?: number;
    kinds?: InvestorMaterialKind[];
    source?: {
      url: string;
      kind?: InvestorMaterialKind;
      title?: string;
      period?: string | null;
    };
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const ticker = (body.ticker || "").trim();
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }

  try {
    if (body.action === "import_latest") {
      const result = await importLatestInvestorMaterials({
        ticker,
        limit: body.limit,
        kinds: body.kinds,
        distill: body.distill === true,
      });
      const materials = listInvestorMaterials(ticker).map(toClientInvestorMaterial);
      const hasIcons = materials.some(
        (m) => m.kind === "concall" || m.kind === "transcript" || m.kind === "ppt",
      );
      const importedOk = result.imported.length > 0;
      const payload = {
        imported: result.imported.map(toClientInvestorMaterial),
        skipped: result.skipped,
        errors: result.errors,
        parsed_with: result.parsed_with,
        distilled: result.distilled,
        materials,
      };
      if (!hasIcons && !importedOk) {
        const message =
          result.errors[0]?.error ||
          (result.imported.length === 0 && result.skipped.length > 0
            ? "No new files — already downloaded"
            : "No concall / PPT found online");
        return NextResponse.json({
          ok: false,
          error: message,
          ...payload,
        });
      }
      return NextResponse.json({
        ok: true,
        ...payload,
      });
    }

    if (body.action === "import" && body.source?.url) {
      const material = await importInvestorMaterialFromSource({
        ticker,
        source: {
          url: body.source.url,
          kind: body.source.kind ?? "concall",
          title: body.source.title ?? "Concall transcript",
          period: body.source.period ?? null,
        },
        distill: body.distill === true,
      });
      return NextResponse.json({
        ok: true,
        material: toClientInvestorMaterial(material),
        materials: listInvestorMaterials(ticker).map(toClientInvestorMaterial),
      });
    }

    const material = await saveInvestorMaterial({
      ticker,
      kind: body.kind,
      title: body.title,
      period: body.period ?? null,
      text: body.text,
      url: body.url ?? null,
      distill: body.distill === true,
    });
    return NextResponse.json({
      ok: true,
      material: toClientInvestorMaterial(material),
      materials: listInvestorMaterials(ticker).map(toClientInvestorMaterial),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Save failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  let body: { id?: number; action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (body.action === "distill" && body.id) {
    const material = await redistillInvestorMaterial(body.id);
    if (!material) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      material,
      materials: listInvestorMaterials(material.ticker),
    });
  }
  return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }
  const ok = deleteInvestorMaterial(id);
  return NextResponse.json({ ok, removed: ok });
}
