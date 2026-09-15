"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

type OllamaPayload = {
  ok?: boolean;
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

function uniqModels(...groups: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const name = (g || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function OllamaBar() {
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"start" | "pull" | "select" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<OllamaPayload | null>(null);
  const [llmModel, setLlmModel] = useState("");
  const [ocrModel, setOcrModel] = useState("");
  const [pullName, setPullName] = useState("");

  const applyStatus = useCallback((json: OllamaPayload) => {
    setStatus(json);
    setLlmModel(json.llmModel || "");
    setOcrModel(json.ocrModel || "");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/ollama", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as OllamaPayload;
      applyStatus(json);
    } catch {
      /* ignore */
    }
  }, [applyStatus]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function post(
    body: Record<string, string>,
    kind: "start" | "pull" | "select",
  ) {
    setBusy(kind);
    setMsg(null);
    try {
      const res = await fetch("/api/ollama", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as OllamaPayload & {
        detail?: string;
        ok?: boolean;
      };
      applyStatus(json);
      setMsg(json.detail || (json.ok === false ? "Failed" : null));
      return json;
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Request failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const online = Boolean(status?.reachable);
  const modelOptions = uniqModels(
    ...((status?.models ?? []) as string[]),
    status?.llmModel,
    status?.ocrModel,
    llmModel,
    ocrModel,
  );

  return (
    <div className="ollama-bar" ref={rootRef}>
      <button
        type="button"
        className={`ollama-chip ${online ? "on" : "off"} ${open ? "open" : ""}`}
        aria-expanded={open}
        aria-controls={panelId}
        title={status?.detail || "Ollama"}
        onClick={() => {
          setOpen((v) => !v);
          void refresh();
        }}
      >
        <span className="ollama-dot" aria-hidden />
        <span className="ollama-chip-label">
          {online ? "Ollama" : "Ollama off"}
        </span>
        <span className="ollama-chip-model">
          {status?.llmModel ? status.llmModel.split(":")[0] : "—"}
        </span>
      </button>

      {open ? (
        <div className="ollama-panel" id={panelId} role="dialog" aria-label="Ollama">
          <div className="ollama-panel-head">
            <div>
              <div className="ollama-panel-title">Local models</div>
              <div className="ollama-panel-detail">
                {status?.detail || "Checking…"}
              </div>
            </div>
            <button
              type="button"
              className="btn-ghost ollama-mini-btn"
              disabled={busy != null}
              onClick={() => void refresh()}
            >
              Refresh
            </button>
          </div>

          <div className="ollama-actions">
            <button
              type="button"
              className="btn-secondary ollama-action-btn"
              disabled={busy != null || online}
              onClick={() => void post({ action: "start" }, "start")}
              title={
                online
                  ? "Ollama is already running"
                  : status?.hint || "Start Ollama"
              }
            >
              {busy === "start" ? "Starting…" : online ? "Running" : "Start Ollama"}
            </button>
          </div>

          <label className="ollama-field">
            <span>Text model</span>
            <select
              value={llmModel}
              disabled={busy != null}
              onChange={(e) => setLlmModel(e.target.value)}
            >
              {modelOptions.length ? (
                modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))
              ) : (
                <option value={llmModel || ""}>
                  {llmModel || "No models yet"}
                </option>
              )}
            </select>
          </label>

          <label className="ollama-field">
            <span>OCR / vision</span>
            <select
              value={ocrModel}
              disabled={busy != null}
              onChange={(e) => setOcrModel(e.target.value)}
            >
              {modelOptions.length ? (
                modelOptions.map((m) => (
                  <option key={`ocr-${m}`} value={m}>
                    {m}
                  </option>
                ))
              ) : (
                <option value={ocrModel || ""}>
                  {ocrModel || "No models yet"}
                </option>
              )}
            </select>
          </label>

          <div className="ollama-actions">
            <button
              type="button"
              className="btn-secondary ollama-action-btn"
              disabled={
                busy != null ||
                (!llmModel.trim() && !ocrModel.trim()) ||
                (llmModel === status?.llmModel && ocrModel === status?.ocrModel)
              }
              onClick={() =>
                void post(
                  {
                    action: "select",
                    llmModel: llmModel.trim(),
                    ocrModel: ocrModel.trim(),
                  },
                  "select",
                )
              }
            >
              {busy === "select" ? "Saving…" : "Use models"}
            </button>
          </div>

          <div className="ollama-pull-row">
            <input
              type="text"
              className="ollama-pull-input"
              placeholder="ollama pull name (e.g. qwen2.5:3b-instruct)"
              value={pullName}
              disabled={busy != null}
              onChange={(e) => setPullName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pullName.trim()) {
                  e.preventDefault();
                  void post(
                    { action: "pull", model: pullName.trim() },
                    "pull",
                  ).then((json) => {
                    if (json?.ok) setPullName("");
                  });
                }
              }}
            />
            <button
              type="button"
              className="btn-ghost ollama-mini-btn"
              disabled={busy != null || !pullName.trim()}
              onClick={() =>
                void post(
                  { action: "pull", model: pullName.trim() },
                  "pull",
                ).then((json) => {
                  if (json?.ok) setPullName("");
                })
              }
            >
              {busy === "pull" ? "Pulling…" : "Pull"}
            </button>
          </div>

          {msg ? <p className="ollama-msg">{msg}</p> : null}
          {!online && status?.hint ? (
            <p className="ollama-hint">{status.hint}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
