/**
 * Start / probe Ollama and list local models for the in-app LLM bar.
 */
import { spawn } from "node:child_process";
import fs from "fs";
import path from "path";
import { loadLlmConfig } from "./llm-config";
import { readLlmRuntime } from "./llm-runtime";

export type OllamaStatus = {
  reachable: boolean;
  baseUrl: string;
  models: string[];
  llmModel: string;
  ocrModel: string;
  binary: string | null;
  appPresent: boolean;
  detail: string;
  hint: string;
};

const CANDIDATE_BINS = [
  "ollama",
  "/usr/local/bin/ollama",
  "/opt/homebrew/bin/ollama",
  "/Applications/Ollama.app/Contents/Resources/ollama",
];

function whichSync(cmd: string): string | null {
  if (cmd.includes("/")) {
    return fs.existsSync(cmd) ? cmd : null;
  }
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function findOllamaBinary(): string | null {
  for (const c of CANDIDATE_BINS) {
    const hit = whichSync(c);
    if (hit) return hit;
  }
  return null;
}

export function ollamaAppPresent(): boolean {
  return (
    process.platform === "darwin" &&
    fs.existsSync("/Applications/Ollama.app")
  );
}

export async function fetchOllamaModels(baseUrl: string): Promise<{
  reachable: boolean;
  models: string[];
}> {
  const base = baseUrl.replace(/\/$/, "");
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
        .filter((n): n is string => Boolean(n))
        .sort((a, b) => a.localeCompare(b)),
    };
  } catch {
    return { reachable: false, models: [] };
  }
}

export async function getOllamaStatus(): Promise<OllamaStatus> {
  const cfg = loadLlmConfig();
  const runtime = readLlmRuntime();
  const baseUrl = cfg.ollamaBaseUrl;
  const { reachable, models } = await fetchOllamaModels(baseUrl);
  const binary = findOllamaBinary();
  const appPresent = ollamaAppPresent();
  const llmModel = runtime.llmModel || cfg.llmModel;
  const ocrModel =
    runtime.ocrModel || cfg.taskModels.pdfPptOcr || cfg.llmModel;

  let detail: string;
  let hint: string;
  if (reachable) {
    detail = `Ollama online · ${models.length} model${models.length === 1 ? "" : "s"}`;
    hint = "";
  } else if (binary || appPresent) {
    detail = `Ollama offline at ${baseUrl}`;
    hint = "Click Start to launch Ollama";
  } else {
    detail = "Ollama not installed";
    hint =
      "Install from https://ollama.com/download then click Start, or: brew install ollama";
  }

  return {
    reachable,
    baseUrl,
    models,
    llmModel,
    ocrModel,
    binary,
    appPresent,
    detail,
    hint,
  };
}

function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

export async function startOllama(): Promise<{
  ok: boolean;
  detail: string;
  status: OllamaStatus;
}> {
  let status = await getOllamaStatus();
  if (status.reachable) {
    return { ok: true, detail: "Ollama already running", status };
  }

  const attempts: string[] = [];

  if (process.platform === "darwin" && status.appPresent) {
    try {
      spawnDetached("open", ["-a", "Ollama"]);
      attempts.push("open -a Ollama");
    } catch (err) {
      attempts.push(
        `open failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const bin = status.binary || findOllamaBinary();
  if (bin) {
    try {
      spawnDetached(bin, ["serve"]);
      attempts.push(`${bin} serve`);
    } catch (err) {
      attempts.push(
        `serve failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!attempts.length) {
    status = await getOllamaStatus();
    return {
      ok: false,
      detail: status.hint || "Ollama not found on this machine",
      status,
    };
  }

  // Wait briefly for the daemon to come up.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    status = await getOllamaStatus();
    if (status.reachable) {
      return {
        ok: true,
        detail: `Started (${attempts.join(" · ")})`,
        status,
      };
    }
  }

  status = await getOllamaStatus();
  return {
    ok: false,
    detail: `Launched (${attempts.join(" · ")}) but still unreachable at ${status.baseUrl}. Open the Ollama app or run: ollama serve`,
    status,
  };
}

export async function pullOllamaModel(model: string): Promise<{
  ok: boolean;
  detail: string;
  status: OllamaStatus;
}> {
  const name = model.trim();
  if (!name) {
    return {
      ok: false,
      detail: "Model name required",
      status: await getOllamaStatus(),
    };
  }

  let status = await getOllamaStatus();
  if (!status.reachable) {
    const started = await startOllama();
    status = started.status;
    if (!status.reachable) {
      return {
        ok: false,
        detail: `Cannot pull — Ollama offline. ${started.detail}`,
        status,
      };
    }
  }

  const bin = status.binary || findOllamaBinary();
  if (!bin) {
    return {
      ok: false,
      detail: "ollama binary not found — install Ollama first",
      status,
    };
  }

  const result = await new Promise<{ code: number | null; stderr: string }>(
    (resolve) => {
      const child = spawn(bin, ["pull", name], {
        env: process.env,
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        resolve({ code: 1, stderr: err.message });
      });
      child.on("close", (code) => {
        resolve({ code, stderr });
      });
    },
  );

  status = await getOllamaStatus();
  if (result.code === 0) {
    return { ok: true, detail: `Pulled ${name}`, status };
  }
  const tail = result.stderr.trim().split("\n").slice(-3).join(" ");
  return {
    ok: false,
    detail: tail || `ollama pull ${name} failed (exit ${result.code})`,
    status,
  };
}
