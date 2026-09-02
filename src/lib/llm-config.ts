export type LlmConfig = {
  llmProvider: "auto" | "claude_code" | "anthropic" | "openai" | "ollama" | "none";
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  llmModel: string;
  ollamaBaseUrl: string;
};

/** Alias used by the LLM client. */
export type AgentConfig = LlmConfig;

function envStr(key: string): string | null {
  const v = process.env[key]?.trim();
  return v || null;
}

export function loadLlmConfig(): LlmConfig {
  const provider = (envStr("LLM_PROVIDER") || "auto").toLowerCase();
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
    : "auto";

  return {
    llmProvider,
    anthropicApiKey: envStr("ANTHROPIC_API_KEY"),
    openaiApiKey: envStr("OPENAI_API_KEY"),
    llmModel: envStr("LLM_MODEL") || "claude-haiku-4-5",
    ollamaBaseUrl: envStr("OLLAMA_BASE_URL") || "http://127.0.0.1:11434",
  };
}
