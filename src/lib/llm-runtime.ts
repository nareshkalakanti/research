/**
 * Machine-local LLM model overrides (UI picker).
 * Merged on top of .env.local by loadLlmConfig / applyLlmRuntimeToEnv.
 */
import fs from "fs";
import path from "path";

export type LlmRuntimeOverride = {
  llmModel?: string;
  ocrModel?: string;
  updatedAt?: string;
};

const RUNTIME_PATH = path.join(process.cwd(), "data", "llm-runtime.json");

export function readLlmRuntime(): LlmRuntimeOverride {
  try {
    if (!fs.existsSync(RUNTIME_PATH)) return {};
    const raw = fs.readFileSync(RUNTIME_PATH, "utf8");
    const parsed = JSON.parse(raw) as LlmRuntimeOverride;
    return {
      llmModel: typeof parsed.llmModel === "string" ? parsed.llmModel.trim() : undefined,
      ocrModel: typeof parsed.ocrModel === "string" ? parsed.ocrModel.trim() : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch {
    return {};
  }
}

export function writeLlmRuntime(patch: LlmRuntimeOverride): LlmRuntimeOverride {
  const prev = readLlmRuntime();
  const next: LlmRuntimeOverride = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (patch.llmModel !== undefined) {
    next.llmModel = patch.llmModel.trim() || undefined;
  }
  if (patch.ocrModel !== undefined) {
    next.ocrModel = patch.ocrModel.trim() || undefined;
  }
  fs.mkdirSync(path.dirname(RUNTIME_PATH), { recursive: true });
  fs.writeFileSync(RUNTIME_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  applyLlmRuntimeToEnv(next);
  return next;
}

/** Push overrides into process.env so modules that read env directly see them. */
export function applyLlmRuntimeToEnv(over: LlmRuntimeOverride = readLlmRuntime()): void {
  if (over.llmModel) {
    const m = over.llmModel;
    process.env.LLM_MODEL = m;
    process.env.LLM_MODEL_HIGHLIGHTS = m;
    process.env.LLM_MODEL_QUANT = m;
    process.env.LLM_MODEL_UNIFIED = m;
    process.env.LLM_MODEL_TRANSCRIPT_FACTS = m;
    process.env.LLM_MODEL_RESULT_QUALITY = m;
    process.env.LLM_MODEL_MGMT_SENTIMENT = m;
    process.env.LLM_MODEL_CODE = m;
    process.env.LLM_MODEL_ORDERBOOK = m;
    process.env.LLM_MODEL_MARKETIQ = m;
  }
  if (over.ocrModel) {
    process.env.LLM_MODEL_OCR = over.ocrModel;
    process.env.QIANFAN_OCR_MODEL = over.ocrModel;
  }
}
