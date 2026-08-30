import type { RunMode } from "./types";

export type AgentConfig = {
  brand: string;
  confidenceThreshold: number;
  agentDelayMs: number;
  shortlistPerBucket: number;
  llmProvider: "auto" | "claude_code" | "anthropic" | "openai" | "ollama" | "none";
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  llmModel: string;
  ollamaBaseUrl: string;
  port: number;
};

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(key: string): string | null {
  const v = process.env[key]?.trim();
  return v || null;
}

export function loadAgentConfig(): AgentConfig {
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
    ? (provider as AgentConfig["llmProvider"])
    : "auto";

  return {
    brand: envStr("BRAND") || "Research",
    confidenceThreshold: envInt("CONFIDENCE_THRESHOLD", 7),
    agentDelayMs: envInt("AGENT_DELAY", 450),
    shortlistPerBucket: envInt("SHORTLIST_PER_BUCKET", 4),
    llmProvider,
    anthropicApiKey: envStr("ANTHROPIC_API_KEY"),
    openaiApiKey: envStr("OPENAI_API_KEY"),
    llmModel: envStr("LLM_MODEL") || "claude-haiku-4-5",
    ollamaBaseUrl: envStr("OLLAMA_BASE_URL") || "http://127.0.0.1:11434",
    port: envInt("PORT", 3000),
  };
}

export function publicAgentConfig(cfg: AgentConfig) {
  return {
    brand: cfg.brand,
    confidenceThreshold: cfg.confidenceThreshold,
    agentDelayMs: cfg.agentDelayMs,
    shortlistPerBucket: cfg.shortlistPerBucket,
    llmProvider: cfg.llmProvider,
    hasAnthropicKey: Boolean(cfg.anthropicApiKey),
    hasOpenaiKey: Boolean(cfg.openaiApiKey),
    llmModel: cfg.llmModel,
    ollamaBaseUrl: cfg.ollamaBaseUrl,
  };
}

export type UniverseFile = {
  large: string[];
  mid: string[];
  small: string[];
};

export function defaultRunMode(): RunMode {
  return "demo";
}
