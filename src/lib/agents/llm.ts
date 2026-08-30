import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentConfig } from "./config";
import {
  checkLlmStatus,
  completeJson as completeJsonShared,
  resolveLlmEngine as resolveLlmEngineShared,
} from "@/lib/llm-client";
import type { EvidenceBundle, EvaluationResult } from "./types";
import { evaluateDeterministic } from "./scoring";
import { verifyEvaluation } from "./verify";

const execFileAsync = promisify(execFile);

const DEBATE_PROMPT = `You are an equity research panel for Indian NSE stocks.
Return ONLY valid JSON (no markdown) with this shape:
{
  "technician": {"score": 0-100, "point": "≤25 words"},
  "fundamentalist": {"score": 0-100, "point": "≤25 words"},
  "newsdesk": {"score": 0-100, "point": "≤25 words"},
  "bull": {"score": 0-100, "point": "≤25 words"},
  "bear": {"score": 0-100, "point": "≤25 words"},
  "judge": {
    "winner": "Bull" or "Bear",
    "verdict": "BUY" or "WATCH" or "AVOID",
    "confidence": 1-10,
    "rationale": "≤2 lines",
    "key_catalyst": "short phrase"
  }
}
Rules: BUY needs favorable risk/reward with momentum/volume confirmation.
WATCH if promising but unconfirmed. AVOID if poor.
Every number you cite MUST exist in the evidence JSON. If missing, say "data unavailable".
Never invent figures.`;

export async function resolveLlmEngine(
  cfg: AgentConfig,
): Promise<"deterministic" | "llm"> {
  return resolveLlmEngineShared(cfg);
}

async function callClaudeCode(
  prompt: string,
  model: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", prompt, "--output-format", "json", "--model", model],
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

async function callAnthropic(
  prompt: string,
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
      max_tokens: 1200,
      system: DEBATE_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const body = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = body.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("empty anthropic response");
  return text;
}

async function callOpenAI(prompt: string, cfg: AgentConfig): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.llmModel.includes("gpt") ? cfg.llmModel : "gpt-4o-mini",
      messages: [
        { role: "system", content: DEBATE_PROMPT },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error("empty openai response");
  return text;
}

function parseLlmJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in LLM output");
  return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
}

function agentScore(obj: unknown): { score: number; reasons: string[] } {
  if (!obj || typeof obj !== "object") return { score: 50, reasons: [] };
  const o = obj as { score?: number; point?: string };
  const score = Number(o.score);
  const point = String(o.point || "").trim();
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 50,
    reasons: point ? [point] : [],
  };
}

function llmToEvaluation(
  parsed: Record<string, unknown>,
  bullScore: number,
  bearScore: number,
): EvaluationResult["verdict"] {
  const j = (parsed.judge ?? {}) as Record<string, unknown>;
  const verdictRaw = String(j.verdict || "WATCH").toUpperCase();
  const verdict =
    verdictRaw === "BUY" || verdictRaw === "AVOID" ? verdictRaw : "WATCH";
  let confidence = Number(j.confidence);
  if (!Number.isFinite(confidence)) confidence = 5;
  confidence = Math.max(1, Math.min(10, Math.round(confidence)));
  if (verdict === "BUY" && confidence < 7) confidence = 7;
  if (verdict !== "BUY" && confidence > 6) confidence = 6;
  const winnerRaw = String(j.winner || "");
  const winner = winnerRaw.toLowerCase().includes("bear") ? "Bear" : "Bull";
  return {
    winner,
    verdict,
    confidence,
    rationale: String(j.rationale || "").slice(0, 240),
    key_catalyst: String(j.key_catalyst || "").slice(0, 120),
    bull_score: bullScore,
    bear_score: bearScore,
    net: bullScore - bearScore,
  };
}

export async function evaluateWithEngine(
  evidence: EvidenceBundle,
  cfg: AgentConfig,
  engine: "deterministic" | "llm",
): Promise<EvaluationResult> {
  if (engine === "deterministic") {
    const r = evaluateDeterministic(evidence);
    r.verification_warnings = verifyEvaluation(evidence, r);
    return r;
  }

  const user = `Evidence JSON:\n${JSON.stringify(evidence)}`;

  try {
    let parsed: Record<string, unknown>;
    if (cfg.llmProvider === "ollama") {
      parsed = await completeJsonShared(cfg, DEBATE_PROMPT, user);
    } else {
      let raw: string;
      if (
        cfg.llmProvider === "openai" ||
        (cfg.llmProvider === "auto" && cfg.openaiApiKey && !cfg.anthropicApiKey)
      ) {
        raw = await callOpenAI(`${DEBATE_PROMPT}\n\n${user}`, cfg);
      } else if (cfg.llmProvider === "anthropic" || cfg.anthropicApiKey) {
        raw = await callAnthropic(`${DEBATE_PROMPT}\n\n${user}`, cfg);
      } else {
        raw = await callClaudeCode(`${DEBATE_PROMPT}\n\n${user}`, cfg.llmModel);
      }
      parsed = parseLlmJson(raw);
    }

    const bull = agentScore(parsed.bull);
    const bear = agentScore(parsed.bear);
    const result: EvaluationResult = {
      scores: {
        technician: agentScore(parsed.technician),
        fundamentalist: agentScore(parsed.fundamentalist),
        newsdesk: agentScore(parsed.newsdesk),
        bull,
        bear,
      },
      verdict: llmToEvaluation(parsed, bull.score, bear.score),
      engine: "llm",
    };
    result.verification_warnings = verifyEvaluation(evidence, result);
    return result;
  } catch {
    const fallback = evaluateDeterministic(evidence);
    fallback.verification_warnings = verifyEvaluation(evidence, fallback);
    return fallback;
  }
}

export async function llmEngineLabel(cfg: AgentConfig): Promise<string> {
  const status = await checkLlmStatus(cfg);
  if (status.engine === "offline") return "deterministic";
  if (cfg.llmProvider === "claude_code") return "claude CLI";
  if (cfg.llmProvider === "ollama") return "ollama";
  if (cfg.openaiApiKey && cfg.llmProvider !== "anthropic") return "openai";
  if (cfg.anthropicApiKey) return "anthropic";
  return status.detail || "llm";
}
