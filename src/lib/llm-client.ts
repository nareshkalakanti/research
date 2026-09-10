import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentConfig } from "./llm-config";

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

  // auto — prefer free local Ollama, then paid APIs (cost last)
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
  if (cfg.openaiApiKey) {
    return {
      available: true,
      provider: "auto",
      model: cfg.llmModel.includes("gpt") ? cfg.llmModel : "gpt-4o-mini",
      engine: "llm",
      detail: "Auto → OpenAI API (gpt-4o-mini fallback)",
      hint: "",
    };
  }
  if (cfg.anthropicApiKey) {
    return {
      available: true,
      provider: "auto",
      model: cfg.llmModel.includes("claude") ? cfg.llmModel : "claude-haiku-4-5",
      engine: "llm",
      detail: "Auto → Anthropic API (haiku fallback)",
      hint: "",
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

function closeTruncatedJson(text: string): string {
  let s = text.trim().replace(/,\s*$/, "");
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inString) s += '"';
  while (stack.length) s += stack.pop();
  return s;
}

/** Escape raw newlines / tabs inside JSON strings (common LLM glitch). */
function escapeControlsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (const ch of text) {
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function repairJsonText(s: string): string {
  return escapeControlsInStrings(
    s
      .replace(/^\uFEFF/, "")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      // Python-ish literals some local models emit
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNone\b/g, "null")
      // Trailing commas
      .replace(/,\s*([}\]])/g, "$1")
      // Bare newlines between values (rare)
      .replace(/\}\s*\{/g, "},{"),
  );
}

/** Pull the largest {...} / [...] block that still parses. */
function extractBalancedJson(text: string): string | null {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  let start = -1;
  let open = "";
  let close = "";
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) {
    start = startObj;
    open = "{";
    close = "}";
  } else if (startArr >= 0) {
    start = startArr;
    open = "[";
    close = "]";
  } else return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Truncated — close it
  return closeTruncatedJson(text.slice(start));
}

function parseJsonBlock(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1]?.trim() || trimmed;

  const candidates: string[] = [];
  const balanced = extractBalancedJson(body);
  if (balanced) {
    candidates.push(balanced, repairJsonText(balanced));
  }
  const start = body.indexOf("{");
  if (start >= 0) {
    const end = body.lastIndexOf("}");
    if (end > start) {
      const slice = body.slice(start, end + 1);
      candidates.push(slice, repairJsonText(slice));
    }
    const truncated = closeTruncatedJson(body.slice(start));
    candidates.push(truncated, repairJsonText(truncated));
  }
  // Strip leading prose before first {
  const proseStripped = body.replace(/^[^{[]+/, "");
  if (proseStripped && proseStripped !== body) {
    const b = extractBalancedJson(proseStripped);
    if (b) candidates.push(b, repairJsonText(b));
  }

  let lastErr: Error | null = null;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || candidate.length < 2) continue;
    const key = candidate.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      // Array root → wrap so callers still get an object
      if (Array.isArray(parsed)) {
        return { items: parsed };
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  const msg = lastErr?.message || "invalid JSON in LLM output";
  if (/unexpected end|no json/i.test(msg)) {
    throw new Error("LLM returned incomplete JSON — try again");
  }
  throw new Error("invalid JSON in LLM output");
}

export type LlmJsonOpts = {
  numPredict?: number;
  temperature?: number;
  skipStatusCheck?: boolean;
  maxTokens?: number;
  model?: string;
  /** Ollama structured output / OpenAI json_schema when supported. */
  jsonSchema?: Record<string, unknown>;
};

function withModel(cfg: AgentConfig, model?: string): AgentConfig {
  if (!model?.trim()) return cfg;
  return { ...cfg, llmModel: model.trim() };
}

async function callOllama(
  system: string,
  user: string,
  cfg: AgentConfig,
  opts?: LlmJsonOpts,
): Promise<string> {
  const base = cfg.ollamaBaseUrl.replace(/\/$/, "");
  // Vision models (…vl…) often break JSON; prefer text instruct twin when present
  let model = (opts?.model || cfg.llmModel).trim();
  if (/vl/i.test(model)) {
    try {
      const tags = await ollamaReachable(cfg);
      const twin =
        model.replace(/vl:/i, ":").replace(/:(\d+)b$/i, ":$1b-instruct") ||
        "";
      const alt = twin.replace(/-instruct-instruct$/i, "-instruct");
      if (alt && modelMatches(tags.models, alt)) model = alt;
      else if (
        tags.models.some((n) => /qwen2\.5:7b-instruct/i.test(n))
      ) {
        model = tags.models.find((n) => /qwen2\.5:7b-instruct/i.test(n))!;
      }
    } catch {
      /* keep cfg.llmModel */
    }
  }
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
      format: opts?.jsonSchema ?? "json",
      options: {
        num_predict: opts?.maxTokens ?? opts?.numPredict ?? 720,
        temperature: opts?.temperature ?? 0.15,
      },
    }),
    signal: AbortSignal.timeout(
      (opts?.maxTokens ?? opts?.numPredict ?? 720) >= 3000
        ? 300_000
        : (opts?.maxTokens ?? opts?.numPredict ?? 720) >= 1200
          ? 150_000
          : 90_000,
    ),
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
  opts?: LlmJsonOpts,
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
      max_tokens: opts?.maxTokens ?? opts?.numPredict ?? 1600,
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
  opts?: LlmJsonOpts,
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
      max_tokens: opts?.maxTokens ?? opts?.numPredict ?? 900,
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
  const effectiveCfg = withModel(cfg, opts?.model);
  if (!opts?.skipStatusCheck) {
    const status = await checkLlmStatus(effectiveCfg);
    if (!status.available) {
      throw new Error(status.detail || "LLM unavailable");
    }
  }

  const runOnce = async (sys: string, usr: string) => {
    let raw: string;
    if (effectiveCfg.llmProvider === "ollama") {
      raw = await callOllama(sys, usr, effectiveCfg, opts);
    } else if (effectiveCfg.llmProvider === "openai") {
      raw = await callOpenAI(sys, usr, effectiveCfg, opts);
    } else if (effectiveCfg.llmProvider === "anthropic") {
      raw = await callAnthropic(sys, usr, effectiveCfg, opts);
    } else if (effectiveCfg.llmProvider === "claude_code") {
      raw = await callClaudeCode(sys, usr, effectiveCfg);
    } else if (effectiveCfg.llmProvider === "auto") {
      // Cost: local Ollama first, then cheapest cloud
      const ollama = await ollamaReachable(effectiveCfg);
      if (ollama.reachable && modelMatches(ollama.models, effectiveCfg.llmModel)) {
        raw = await callOllama(sys, usr, effectiveCfg, opts);
      } else if (effectiveCfg.openaiApiKey) {
        raw = await callOpenAI(
          sys,
          usr,
          {
            ...effectiveCfg,
            llmModel: effectiveCfg.llmModel.includes("gpt")
              ? effectiveCfg.llmModel
              : "gpt-4o-mini",
          },
          opts,
        );
      } else if (effectiveCfg.anthropicApiKey) {
        raw = await callAnthropic(
          sys,
          usr,
          {
            ...effectiveCfg,
            llmModel: effectiveCfg.llmModel.includes("claude")
              ? effectiveCfg.llmModel
              : "claude-haiku-4-5",
          },
          opts,
        );
      } else if (await claudeCodeAvailable()) {
        raw = await callClaudeCode(sys, usr, effectiveCfg);
      } else {
        throw new Error("No LLM backend available");
      }
    } else {
      throw new Error("LLM disabled");
    }
    return parseJsonBlock(raw);
  };

  try {
    return await runOnce(system, user);
  } catch (firstErr) {
    const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    if (!/invalid JSON|incomplete JSON/i.test(msg)) throw firstErr;
    // One repair pass — ask model to re-emit valid JSON only
    try {
      return await runOnce(
        "You fix broken JSON. Return ONLY a valid JSON object. No markdown, no commentary.",
        `The previous reply was not valid JSON (${msg}). Re-output the same content as a single valid JSON object.\n\nOriginal task (for context):\n${user.slice(0, 6000)}`,
      );
    } catch {
      throw firstErr instanceof Error
        ? firstErr
        : new Error("invalid JSON in LLM output");
    }
  }
}
