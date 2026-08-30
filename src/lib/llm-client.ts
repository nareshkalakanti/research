import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentConfig } from "./agents/config";

const execFileAsync = promisify(execFile);

export type LlmStatus = {
  available: boolean;
  provider: AgentConfig["llmProvider"];
  model: string;
  engine: "llm" | "offline";
  detail: string;
  hint: string;
};

function modelMatches(available: string[], wanted: string): boolean {
  const w = wanted.trim().toLowerCase();
  if (!w) return false;
  return available.some((name) => {
    const n = name.toLowerCase();
    return n === w || n.startsWith(`${w}:`) || w.startsWith(`${n}:`);
  });
}

async function claudeCodeAvailable(): Promise<boolean> {
  try {
    await execFileAsync("which", ["claude"]);
    return true;
  } catch {
    return false;
  }
}

async function ollamaReachable(cfg: AgentConfig): Promise<{
  reachable: boolean;
  models: string[];
}> {
  const base = cfg.ollamaBaseUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { reachable: false, models: [] };
    const body = (await res.json()) as {
      models?: Array<{ name?: string }>;
    };
    return {
      reachable: true,
      models: (body.models ?? [])
        .map((m) => m.name?.trim())
        .filter((n): n is string => Boolean(n)),
    };
  } catch {
    return { reachable: false, models: [] };
  }
}

function startHint(cfg: AgentConfig): string {
  switch (cfg.llmProvider) {
    case "ollama":
      return [
        "Start Ollama: ollama serve  (or: brew services start ollama)",
        `Pull model: ollama pull ${cfg.llmModel}`,
        "In .env.local: LLM_PROVIDER=ollama",
      ].join(" · ");
    case "openai":
      return "Set OPENAI_API_KEY in .env.local, then restart npm run dev.";
    case "anthropic":
      return "Set ANTHROPIC_API_KEY in .env.local, then restart npm run dev.";
    case "claude_code":
      return "Install Claude Code CLI (claude) and sign in, or set an API key provider.";
    case "none":
      return "Set LLM_PROVIDER=ollama|openai|anthropic|auto in .env.local.";
    default:
      return [
        "Ollama: ollama serve && ollama pull " + cfg.llmModel,
        "Or set OPENAI_API_KEY / ANTHROPIC_API_KEY in .env.local",
      ].join(" · ");
  }
}

export async function checkLlmStatus(cfg: AgentConfig): Promise<LlmStatus> {
  const hint = startHint(cfg);

  if (cfg.llmProvider === "none") {
    return {
      available: false,
      provider: cfg.llmProvider,
      model: cfg.llmModel,
      engine: "offline",
      detail: "LLM disabled (LLM_PROVIDER=none)",
      hint,
    };
  }

  if (cfg.llmProvider === "openai") {
    const ok = Boolean(cfg.openaiApiKey);
    return {
      available: ok,
      provider: cfg.llmProvider,
      model: cfg.llmModel,
      engine: ok ? "llm" : "offline",
      detail: ok ? "OpenAI API key configured" : "Missing OPENAI_API_KEY",
      hint,
    };
  }

  if (cfg.llmProvider === "anthropic") {
    const ok = Boolean(cfg.anthropicApiKey);
    return {
      available: ok,
      provider: cfg.llmProvider,
      model: cfg.llmModel,
      engine: ok ? "llm" : "offline",
      detail: ok ? "Anthropic API key configured" : "Missing ANTHROPIC_API_KEY",
      hint,
    };
  }

  if (cfg.llmProvider === "claude_code") {
    const ok = await claudeCodeAvailable();
    return {
      available: ok,
      provider: cfg.llmProvider,
      model: cfg.llmModel,
      engine: ok ? "llm" : "offline",
      detail: ok ? "Claude CLI available" : "claude CLI not found on PATH",
      hint,
    };
  }

  if (cfg.llmProvider === "ollama") {
    const { reachable, models } = await ollamaReachable(cfg);
    if (!reachable) {
      return {
        available: false,
        provider: cfg.llmProvider,
        model: cfg.llmModel,
        engine: "offline",
        detail: `Ollama not reachable at ${cfg.ollamaBaseUrl}`,
        hint,
      };
    }
    const hasModel = modelMatches(models, cfg.llmModel);
    return {
      available: hasModel,
      provider: cfg.llmProvider,
      model: cfg.llmModel,
      engine: hasModel ? "llm" : "offline",
      detail: hasModel
        ? `Ollama running · ${cfg.llmModel}`
        : `Ollama running but model "${cfg.llmModel}" not pulled`,
      hint: hasModel ? "" : `Run: ollama pull ${cfg.llmModel}`,
    };
  }

  // auto — prefer cloud keys, then Ollama, then Claude CLI
  if (cfg.anthropicApiKey) {
    return {
      available: true,
      provider: "auto",
      model: cfg.llmModel,
      engine: "llm",
      detail: "Auto → Anthropic API",
      hint: "",
    };
  }
  if (cfg.openaiApiKey) {
    return {
      available: true,
      provider: "auto",
      model: cfg.llmModel,
      engine: "llm",
      detail: "Auto → OpenAI API",
      hint: "",
    };
  }
  const ollama = await ollamaReachable(cfg);
  if (ollama.reachable && modelMatches(ollama.models, cfg.llmModel)) {
    return {
      available: true,
      provider: "auto",
      model: cfg.llmModel,
      engine: "llm",
      detail: `Auto → Ollama · ${cfg.llmModel}`,
      hint: "",
    };
  }
  if (ollama.reachable) {
    return {
      available: false,
      provider: "auto",
      model: cfg.llmModel,
      engine: "offline",
      detail: `Ollama running but model "${cfg.llmModel}" not pulled`,
      hint: `Run: ollama pull ${cfg.llmModel}`,
    };
  }
  if (await claudeCodeAvailable()) {
    return {
      available: true,
      provider: "auto",
      model: cfg.llmModel,
      engine: "llm",
      detail: "Auto → Claude CLI",
      hint: "",
    };
  }
  return {
    available: false,
    provider: "auto",
    model: cfg.llmModel,
    engine: "offline",
    detail: "No LLM backend available",
    hint,
  };
}

export async function resolveLlmEngine(
  cfg: AgentConfig,
): Promise<"deterministic" | "llm"> {
  const status = await checkLlmStatus(cfg);
  return status.engine;
}

function parseJsonBlock(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in LLM output");
  return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
}

export type LlmJsonOpts = {
  numPredict?: number;
  temperature?: number;
  skipStatusCheck?: boolean;
};

async function callOllama(
  system: string,
  user: string,
  cfg: AgentConfig,
  opts?: LlmJsonOpts,
): Promise<string> {
  const base = cfg.ollamaBaseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.llmModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
      format: "json",
      options: {
        num_predict: opts?.numPredict ?? 720,
        temperature: opts?.temperature ?? 0.15,
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const body = (await res.json()) as { message?: { content?: string } };
  const text = body.message?.content?.trim();
  if (!text) throw new Error("empty ollama response");
  return text;
}

async function callOpenAI(
  system: string,
  user: string,
  cfg: AgentConfig,
): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.llmModel.includes("gpt") ? cfg.llmModel : "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("empty openai response");
  return text;
}

async function callAnthropic(
  system: string,
  user: string,
  cfg: AgentConfig,
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.anthropicApiKey!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.llmModel.includes("claude") ? cfg.llmModel : "claude-haiku-4-5",
      max_tokens: 900,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const body = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = body.content?.find((c) => c.type === "text")?.text?.trim();
  if (!text) throw new Error("empty anthropic response");
  return text;
}

async function callClaudeCode(
  system: string,
  user: string,
  cfg: AgentConfig,
): Promise<string> {
  const prompt = `${system}\n\n${user}`;
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", prompt, "--output-format", "json", "--model", cfg.llmModel],
    {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env },
    },
  );
  const envelope = JSON.parse(stdout) as {
    result?: string;
    is_error?: boolean;
  };
  if (envelope.is_error) throw new Error("claude CLI error");
  if (!envelope.result) throw new Error("empty claude result");
  return envelope.result;
}

export async function completeJson(
  cfg: AgentConfig,
  system: string,
  user: string,
  opts?: LlmJsonOpts,
): Promise<Record<string, unknown>> {
  if (!opts?.skipStatusCheck) {
    const status = await checkLlmStatus(cfg);
    if (!status.available) {
      throw new Error(status.detail || "LLM unavailable");
    }
  }

  let raw: string;
  if (cfg.llmProvider === "ollama") {
    raw = await callOllama(system, user, cfg, opts);
  } else if (
    cfg.llmProvider === "openai" ||
    (cfg.llmProvider === "auto" && cfg.openaiApiKey && !cfg.anthropicApiKey)
  ) {
    raw = await callOpenAI(system, user, cfg);
  } else if (cfg.llmProvider === "anthropic" || cfg.anthropicApiKey) {
    raw = await callAnthropic(system, user, cfg);
  } else if (cfg.llmProvider === "claude_code") {
    raw = await callClaudeCode(system, user, cfg);
  } else if (cfg.llmProvider === "auto") {
    const ollama = await ollamaReachable(cfg);
    if (ollama.reachable && modelMatches(ollama.models, cfg.llmModel)) {
      raw = await callOllama(system, user, cfg, opts);
    } else if (await claudeCodeAvailable()) {
      raw = await callClaudeCode(system, user, cfg);
    } else {
      throw new Error("No LLM backend available");
    }
  } else {
    throw new Error("LLM disabled");
  }

  return parseJsonBlock(raw);
}
