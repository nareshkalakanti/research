export type LlmConfig = {
  llmProvider: "auto" | "claude_code" | "anthropic" | "openai" | "ollama" | "none";
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  llmModel: string;
  ollamaBaseUrl: string;
  taskModels: {
    transcriptFactExtraction: string;
    highlightsAndShortSummaries: string;
    resultQualitySignals: string;
    managementSentimentEvidence: string;
    pdfPptOcr: string;
    codeGenerationAndDebugging: string;
  };
};

/** Alias used by the LLM client. */
export type AgentConfig = LlmConfig;

function envStr(key: string): string | null {
  const v = process.env[key]?.trim();
  return v || null;
}

export function loadLlmConfig(): LlmConfig {
  const provider = (envStr("LLM_PROVIDER") || "ollama").toLowerCase();
  const valid = [
    "auto",
    "claude_code",
    "anthropic",
    "openai",
    "ollama",
    "none",
  ] as const;
  const llmProvider = valid.includes(provider as (typeof valid)[number])
    ? (provider as LlmConfig["llmProvider"])
    : "ollama";

  // Prefer smallest local models by default (cost = $0). Override via env when needed.
  const cheapText =
    envStr("LLM_MODEL") || "qwen2.5:3b-instruct";
  const cheapVision =
    envStr("LLM_MODEL_OCR") ||
    envStr("QIANFAN_OCR_MODEL") ||
    "qwen2.5vl:3b";

  return {
    llmProvider,
    anthropicApiKey: envStr("ANTHROPIC_API_KEY"),
    openaiApiKey: envStr("OPENAI_API_KEY"),
    llmModel: cheapText,
    ollamaBaseUrl: envStr("OLLAMA_BASE_URL") || "http://127.0.0.1:11434",
    taskModels: {
      transcriptFactExtraction:
        envStr("LLM_MODEL_TRANSCRIPT_FACTS") || cheapText,
      highlightsAndShortSummaries:
        envStr("LLM_MODEL_HIGHLIGHTS") || cheapText,
      resultQualitySignals:
        envStr("LLM_MODEL_RESULT_QUALITY") || cheapText,
      managementSentimentEvidence:
        envStr("LLM_MODEL_MGMT_SENTIMENT") || cheapText,
      pdfPptOcr: cheapVision,
      codeGenerationAndDebugging:
        envStr("LLM_MODEL_CODE") || cheapText,
    },
  };
}
