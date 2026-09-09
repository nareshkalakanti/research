"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Extract = Record<string, unknown>;

type ScreenResult = {
  ok?: boolean;
  decision?: "pass" | "review" | "fail";
  why?: string;
  extract?: Extract;
  extract_json?: Extract;
  engine?: string;
  text_chars?: number;
  text_excerpt?: string;
  source_url?: string | null;
  error?: string;
};

type HistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  period: string | null;
  sentiment: string | null;
  decision: string;
  screened_at: string;
};

type Meta = {
  company_name?: string | null;
  nse_symbol?: string | null;
  bse_code?: string | null;
  call_date?: string | null;
  quarter?: string | null;
  fiscal_year?: string | null;
};

type Tone = {
  overall_tone?: string | null;
  net_sentiment_score?: number | null;
  justification?: string | null;
};

const PROGRESS_STEPS = [
  { id: "fetch", label: "Download / read PDF" },
  { id: "text", label: "Extract text (pdf-parse)" },
  { id: "llm", label: "LLM structured JSON extract" },
  { id: "save", label: "Validate shape + save history" },
] as const;

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function decisionClass(d: string | null | undefined): string {
  if (d === "pass") return "buyback-decision pass";
  if (d === "fail") return "buyback-decision fail";
  return "buyback-decision review";
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function ConcallResearchPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [progressStep, setProgressStep] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const [showJson, setShowJson] = useState(true);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/concall-screen?limit=40", {
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        history?: HistoryRow[];
      };
      if (res.ok && json.history) setHistory(json.history);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!file) {
      setFileUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setFileUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  useEffect(() => {
    if (!busy || startedAt == null) return;
    const tick = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => window.clearInterval(tick);
  }, [busy, startedAt]);

  useEffect(() => {
    if (!busy) return;
    const timers = [
      window.setTimeout(() => setProgressStep(1), 400),
      window.setTimeout(() => setProgressStep(2), 2000),
      window.setTimeout(() => setProgressStep(3), 8000),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [busy]);

  const pdfSrc = useMemo(() => {
    if (fileUrl) return fileUrl;
    const u = url.trim();
    if (!u) return null;
    return `/api/concall-screen?pdf=${encodeURIComponent(u)}`;
  }, [fileUrl, url]);

  const downloadPdfHref = useMemo(() => {
    if (fileUrl) return fileUrl;
    const u = url.trim();
    if (!u) return null;
    return `/api/concall-screen?pdf=${encodeURIComponent(u)}&download=1`;
  }, [fileUrl, url]);

  const run = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed && !file) {
      setError("Paste a PDF URL or upload a file");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setShowText(false);
    setShowJson(true);
    setProgressStep(0);
    setStartedAt(Date.now());
    setElapsedMs(0);
    setStatus(
      file
        ? "Step 1/4 · Reading uploaded PDF…"
        : "Step 1/4 · Downloading PDF…",
    );
    try {
      let res: Response;
      if (file) {
        const form = new FormData();
        if (trimmed) form.set("url", trimmed);
        form.set("file", file);
        setStatus("Step 2–4 · Text + LLM JSON extract…");
        res = await fetch("/api/concall-screen", {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(300_000),
        });
      } else {
        setStatus("Step 2–4 · Text + LLM JSON extract…");
        res = await fetch("/api/concall-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
          signal: AbortSignal.timeout(300_000),
        });
      }
      setProgressStep(PROGRESS_STEPS.length);
      setStatus("Done — filling extract…");
      const json = (await res.json()) as ScreenResult & { error?: string };
      if (!res.ok && !json.extract && !json.extract_json) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setResult(json);
      if (!json.ok && json.error) setError(json.error);
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extract failed");
    } finally {
      setBusy(false);
      setStatus(null);
      setStartedAt(null);
    }
  }, [url, file, loadHistory]);

  const ex = result?.extract || result?.extract_json || null;
  const meta = (asObj(ex?.metadata) || {}) as Meta;
  const tone = (asObj(ex?.management_tone) || {}) as Tone;
  const fin = asObj(ex?.reported_financials) || {};
  const finKeys = Object.keys(fin);

  return (
    <section className="panel scan-panel buyback-research-panel buyback-research-panel--split">
      <p className="panel-lead">
        <strong>Research · Concall.</strong> Upload earnings-call transcript
        PDF → structured JSON (metadata, financials, guidance, segments,
        corporate actions, risk flags, tone, catalysts). Same extract JSON /
        raw text pattern as Order book.
      </p>

      <div className="buyback-input-row">
        <input
          type="url"
          className="buyback-url-input"
          placeholder="Paste transcript PDF URL…"
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
        />
        <button
          type="button"
          className={`chip chip-scan tag-chip ${busy ? "busy on" : ""}`}
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? "Working…" : "Extract"}
        </button>
        {downloadPdfHref ? (
          <a
            className="chip tag-chip"
            href={downloadPdfHref}
            download={file ? file.name : undefined}
            target={file ? undefined : "_blank"}
            rel="noreferrer"
            title="Download PDF"
          >
            Download PDF
          </a>
        ) : null}
      </div>

      <div className="buyback-source-bar">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="buyback-file-hidden"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            if (f) {
              setError(null);
              setResult(null);
            }
          }}
        />
        <button
          type="button"
          className="buyback-upload-btn"
          disabled={busy}
          onClick={() => {
            setResult(null);
            setError(null);
            fileInputRef.current?.click();
          }}
        >
          Upload PDF
        </button>
        {file ? (
          <span className="buyback-file-name" title={file.name}>
            Selected: {file.name}
          </span>
        ) : (
          <span className="buyback-file-hint">
            Earnings call transcript PDF
          </span>
        )}
        {file ? (
          <button
            type="button"
            className="link-btn"
            disabled={busy}
            onClick={() => {
              setFile(null);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          >
            Clear upload
          </button>
        ) : null}
      </div>

      {status && !busy ? (
        <p className="buyback-status" role="status">
          {status}
        </p>
      ) : null}
      {error ? <p className="buyback-error">{error}</p> : null}

      <div className="buyback-split">
        <div className="buyback-split-pdf">
          <div className="buyback-split-label">PDF</div>
          {pdfSrc ? (
            <iframe
              title="Concall PDF"
              className="buyback-pdf-frame"
              src={pdfSrc}
            />
          ) : (
            <div className="buyback-pdf-empty">
              Upload a PDF or paste a URL to preview
            </div>
          )}
        </div>

        <div className="buyback-split-out">
          <div className="buyback-split-label">
            Extract
            {busy ? (
              <span className="buyback-progress-elapsed">
                {fmtElapsed(elapsedMs)}
              </span>
            ) : null}
          </div>
          {busy ? (
            <div className="buyback-progress" role="status" aria-live="polite">
              <p className="buyback-progress-title">
                {status || "Working…"}
              </p>
              <ul className="buyback-progress-steps">
                {PROGRESS_STEPS.map((step, i) => {
                  const done = progressStep > i;
                  const current = progressStep === i;
                  return (
                    <li
                      key={step.id}
                      className={
                        done
                          ? "buyback-progress-step done"
                          : current
                            ? "buyback-progress-step current"
                            : "buyback-progress-step"
                      }
                    >
                      <span className="buyback-progress-mark" aria-hidden>
                        {done ? "✓" : current ? "●" : "○"}
                      </span>
                      <span>{step.label}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="buyback-progress-hint">
                Long transcripts need a few minutes for full JSON extract.
              </p>
            </div>
          ) : !result ? (
            <div className="buyback-pdf-empty">
              Click <strong>Extract</strong> for structured concall JSON
            </div>
          ) : (
            <>
              <div className={decisionClass(result.decision)}>
                {result.why || "Concall extract"}
              </div>

              <table className="buyback-out-table">
                <tbody>
                  <tr>
                    <th scope="row">Company</th>
                    <td>{meta.company_name || "—"}</td>
                  </tr>
                  <tr>
                    <th scope="row">NSE / BSE</th>
                    <td>
                      {meta.nse_symbol || "—"}
                      {meta.bse_code ? ` · ${meta.bse_code}` : ""}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Period</th>
                    <td>
                      {[meta.quarter, meta.fiscal_year]
                        .filter(Boolean)
                        .join(" ") || "—"}
                      {meta.call_date ? ` · ${meta.call_date}` : ""}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Tone</th>
                    <td>
                      {tone.overall_tone || "—"}
                      {tone.net_sentiment_score != null
                        ? ` · score ${tone.net_sentiment_score}`
                        : ""}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Financials</th>
                    <td>
                      {finKeys.length
                        ? finKeys.join(", ")
                        : "—"}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Engine</th>
                    <td>
                      {result.engine || "—"} ·{" "}
                      {(result.text_chars ?? 0).toLocaleString()} chars
                    </td>
                  </tr>
                </tbody>
              </table>

              {tone.justification ? (
                <p className="buyback-subject">{tone.justification}</p>
              ) : null}

              <div className="buyback-text-toggles">
                <button
                  type="button"
                  className="buyback-text-toggle"
                  onClick={() => setShowJson((v) => !v)}
                >
                  {showJson ? "Hide" : "Show"} extract JSON
                </button>
                <button
                  type="button"
                  className="buyback-text-toggle"
                  onClick={() => setShowText((v) => !v)}
                >
                  {showText ? "Hide" : "Show"} raw extracted text
                  {result.text_chars != null
                    ? ` (${result.text_chars.toLocaleString()} chars)`
                    : ""}
                </button>
              </div>
              {showJson ? (
                <pre className="buyback-text-pre buyback-json-pre">
                  {JSON.stringify(
                    result.extract_json || result.extract || {},
                    null,
                    2,
                  )}
                </pre>
              ) : null}
              {showText ? (
                <pre className="buyback-text-pre">
                  {result.text_excerpt?.trim() || "(empty)"}
                </pre>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="buyback-history">
        <h3 className="buyback-history-title">
          Extract list
          <span className="buyback-history-count">{history.length}</span>
        </h3>
        {history.length === 0 ? (
          <p className="buyback-history-empty">
            No extracts yet — upload a transcript and click Extract.
          </p>
        ) : (
          <div className="buyback-history-table-wrap">
            <table className="buyback-history-table">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Company</th>
                  <th>Period</th>
                  <th>Tone</th>
                  <th>Decision</th>
                  <th>Screened</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td>{r.ticker || "—"}</td>
                    <td>{r.company || "—"}</td>
                    <td>{r.period || "—"}</td>
                    <td>{r.sentiment || "—"}</td>
                    <td>
                      <span
                        className={`buyback-hist-pill ${r.decision || "need_review"}`}
                      >
                        {r.decision || "review"}
                      </span>
                    </td>
                    <td>{r.screened_at?.slice(0, 19) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
