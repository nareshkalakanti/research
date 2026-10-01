/**
 * Local Ollama Qwen for Napkin. No OpenAI. No cloud LLM.
 * Model from QWEN_MODEL / LLM_MODEL / UI picker — not hardcoded in this module.
 */
import { loadLlmConfig } from "@/lib/llm-config";
import { napkinLog } from "./log";

export const QWEN_DOWN = "Local Qwen is not running.";

export function napkinQwenModel(): string | null {
  const cfg = loadLlmConfig();
  const named =
    process.env.QWEN_MODEL?.trim() ||
    process.env.LLM_MODEL?.trim() ||
    cfg.llmModel.trim();
  return named || null;
}

export async function askQwen(
  prompt: string,
  system: string,
  opts?: { json?: boolean; numPredict?: number },
): Promise<string> {
  const cfg = loadLlmConfig();
  const model = napkinQwenModel();
  if (!model) {
    throw new Error("Set QWEN_MODEL or LLM_MODEL in .env");
  }
  const base = cfg.ollamaBaseUrl.replace(/\/$/, "");
  napkinLog("qwen ask", { model, prompt_len: prompt.length, json: Boolean(opts?.json) });
  let res: Response;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        stream: false,
        ...(opts?.json ? { format: "json" } : {}),
        options: {
          temperature: 0.15,
          num_predict: opts?.numPredict ?? 2200,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    napkinLog("qwen down", { error: e instanceof Error ? e.message : String(e) });
    throw new Error(QWEN_DOWN);
  }
  if (!res.ok) {
    if (res.status === 404 || res.status >= 500) throw new Error(QWEN_DOWN);
    throw new Error(`Ollama error ${res.status}`);
  }
  const body = (await res.json()) as { message?: { content?: string } };
  const text = body.message?.content?.trim();
  if (!text) throw new Error("empty Qwen response");
  return text;
}

export function splitQwenSections(text: string): Array<{ heading: string; body: string }> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: Array<{ heading: string; body: string }> = [];
  let heading = "QWEN";
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (heading || body) out.push({ heading, body: body || "Not available" });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^#{1,3}\s+(.+)\s*$/);
    if (m) {
      if (buf.length || out.length) flush();
      heading = m[1]!.trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out.filter((s) => s.heading !== "QWEN" || Boolean(s.body.trim()));
}
