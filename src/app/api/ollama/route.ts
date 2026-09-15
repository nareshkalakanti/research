import { NextRequest, NextResponse } from "next/server";
import { writeLlmRuntime } from "@/lib/llm-runtime";
import {
  getOllamaStatus,
  pullOllamaModel,
  startOllama,
} from "@/lib/ollama-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getOllamaStatus();
  return NextResponse.json({ ok: true, ...status });
}

export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    llmModel?: string;
    ocrModel?: string;
    model?: string;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const action = (body.action || "").trim().toLowerCase();

  if (action === "start") {
    const result = await startOllama();
    return NextResponse.json({
      ok: result.ok,
      ...result.status,
      detail: result.detail,
    });
  }

  if (action === "pull") {
    const model = (body.model || body.llmModel || "").trim();
    const result = await pullOllamaModel(model);
    return NextResponse.json({
      ok: result.ok,
      ...result.status,
      detail: result.detail,
    });
  }

  if (action === "select") {
    const patch: { llmModel?: string; ocrModel?: string } = {};
    if (typeof body.llmModel === "string") patch.llmModel = body.llmModel;
    if (typeof body.ocrModel === "string") patch.ocrModel = body.ocrModel;
    const runtime = writeLlmRuntime(patch);
    const status = await getOllamaStatus();
    return NextResponse.json({
      ok: true,
      ...status,
      runtime,
      detail: "Models updated for this machine",
    });
  }

  if (action === "refresh" || !action) {
    const status = await getOllamaStatus();
    return NextResponse.json({ ok: true, ...status });
  }

  return NextResponse.json(
    { ok: false, detail: `Unknown action: ${action}` },
    { status: 400 },
  );
}
