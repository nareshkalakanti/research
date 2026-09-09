"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Field = {
  id: string;
  label: string;
  group: string;
  required: boolean;
  notes: string;
  enabled: boolean;
};

type HistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  period: string | null;
  sentiment: string | null;
  screened_at: string;
};

type ReadResult = {
  ok?: boolean;
  engine?: string;
  text_chars?: number;
  text_excerpt?: string;
  source_url?: string | null;
  enabled_fields?: string[];
  error?: string;
};

type ApiPayload = {
  ok?: boolean;
  fields?: Field[];
  pass_rule?: string;
  purpose?: string;
  updated_at?: string;
  history?: HistoryRow[];
  error?: string;
};

const GROUPS = ["meta", "content", "sentiment", "custom"] as const;

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function ConcallResearchPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [passRule, setPassRule] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [result, setResult] = useState<ReadResult | null>(null);
  const [showText, setShowText] = useState(true);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const [newLabel, setNewLabel] = useState("");
  const [newGroup, setNewGroup] = useState<string>("custom");
  const [newNotes, setNewNotes] = useState("");
  const [newRequired, setNewRequired] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/concall-screen?limit=40", {
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as ApiPayload;
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setFields(json.fields || []);
      setHistory(json.history || []);
      setPassRule(json.pass_rule || "");
      setUpdatedAt(json.updated_at || null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  const grouped = useMemo(() => {
    const map = new Map<string, Field[]>();
    for (const f of fields) {
      const g = f.group || "custom";
      const list = map.get(g) || [];
      list.push(f);
      map.set(g, list);
    }
    const order = [
      ...GROUPS,
      ...[...map.keys()].filter(
        (k) => !GROUPS.includes(k as (typeof GROUPS)[number]),
      ),
    ];
    return order
      .filter((g) => map.has(g))
      .map((g) => ({ group: g, fields: map.get(g)! }));
  }, [fields]);

  const enabledCount = fields.filter((f) => f.enabled).length;

  const readPdf = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed && !file) {
      setError("Paste a PDF URL or upload a file");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setShowText(true);
    setStartedAt(Date.now());
    setElapsedMs(0);
    setStatus(
      file ? "Reading uploaded PDF…" : "Downloading PDF…",
    );
    try {
      let res: Response;
      if (file) {
        const form = new FormData();
        if (trimmed) form.set("url", trimmed);
        form.set("action", "read_pdf");
        form.set("file", file);
        res = await fetch("/api/concall-screen", {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(240_000),
        });
      } else {
        res = await fetch("/api/concall-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "read_pdf", url: trimmed }),
          signal: AbortSignal.timeout(240_000),
        });
      }
      setStatus("Done — showing text…");
      const json = (await res.json()) as ReadResult;
      if (!res.ok && !json.text_excerpt) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setResult(json);
      if (!json.ok && json.error) setError(json.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Read failed");
    } finally {
      setBusy(false);
      setStatus(null);
      setStartedAt(null);
    }
  }, [url, file]);

  const addField = useCallback(async () => {
    const label = newLabel.trim();
    if (!label) {
      setError("Enter a field label");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus("Saving field…");
    try {
      const res = await fetch("/api/concall-screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_field",
          label,
          group: newGroup,
          notes: newNotes.trim(),
          required: newRequired,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as ApiPayload & { fields?: Field[] };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setFields(json.fields || []);
      setNewLabel("");
      setNewNotes("");
      setNewRequired(false);
      setStatus("Field added.");
      setUpdatedAt(new Date().toISOString().slice(0, 10));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Add failed");
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, [newLabel, newGroup, newNotes, newRequired]);

  const toggleEnabled = useCallback(async (id: string, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/concall-screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_enabled", id, enabled }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as ApiPayload & { fields?: Field[] };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setFields(json.fields || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section className="panel scan-panel buyback-research-panel buyback-research-panel--split">
      <p className="panel-lead">
        <strong>Research · Concall.</strong> Upload a transcript / earnings PDF
        (or paste URL), preview it, and read text. Target fields below — we add
        extract next.{" "}
        {updatedAt ? (
          <span className="muted">Schema updated {updatedAt}.</span>
        ) : null}
      </p>

      <div className="buyback-input-row">
        <input
          type="url"
          className="buyback-url-input"
          placeholder="Paste transcript / PPT PDF URL…"
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void readPdf();
            }
          }}
        />
        <button
          type="button"
          className={`chip chip-scan tag-chip ${busy ? "busy on" : ""}`}
          disabled={busy}
          onClick={() => void readPdf()}
        >
          {busy ? "Working…" : "Read PDF"}
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
          <span className="buyback-file-hint">Concall transcript / PPT PDF</span>
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
            Text
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
              <p className="buyback-progress-hint">
                pdf-parse only for now — OCR for scanned decks later.
              </p>
            </div>
          ) : !result ? (
            <div className="buyback-pdf-empty">
              Click <strong>Read PDF</strong> to pull text ({enabledCount}{" "}
              fields enabled for later extract)
            </div>
          ) : (
            <>
              <div className="buyback-decision review">
                {result.ok
                  ? `${result.text_chars?.toLocaleString("en-IN") ?? 0} chars · ${result.engine}`
                  : result.error || "No text"}
              </div>
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowText((v) => !v)}
              >
                {showText ? "Hide text" : "Show text"}
              </button>
              {showText && result.text_excerpt ? (
                <pre className="buyback-text-excerpt">{result.text_excerpt}</pre>
              ) : null}
            </>
          )}
        </div>
      </div>

      <p className="buyback-status" role="status">
        {enabledCount} enabled · {fields.length} total
        {passRule ? ` · Pass: ${passRule}` : null}
      </p>

      {loading ? <p className="buyback-history-empty">Loading fields…</p> : null}

      <div className="buyback-result-card concall-research-fields">
        <div className="buyback-result-head">
          <strong>Target fields</strong>
          <span className="buyback-meta">data/concall-research-fields.json</span>
        </div>

        {grouped.map(({ group, fields: list }) => (
          <div key={group} className="concall-field-group">
            <h4 className="concall-field-group-title">{group}</h4>
            <ul className="concall-field-list">
              {list.map((f) => (
                <li key={f.id} className={f.enabled ? "" : "is-disabled"}>
                  <label className="concall-field-row">
                    <input
                      type="checkbox"
                      checked={f.enabled}
                      disabled={busy}
                      onChange={(e) => void toggleEnabled(f.id, e.target.checked)}
                    />
                    <span className="concall-field-label">
                      {f.label}
                      {f.required ? (
                        <span className="concall-field-req" title="Required">
                          *
                        </span>
                      ) : null}
                    </span>
                    <code className="concall-field-id">{f.id}</code>
                    {f.notes ? (
                      <span className="concall-field-notes">{f.notes}</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div className="concall-add-field">
          <strong>Add field</strong>
          <div className="buyback-input-row">
            <input
              type="text"
              className="buyback-url-input"
              placeholder="Label (e.g. Working capital days)"
              value={newLabel}
              disabled={busy}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addField();
                }
              }}
            />
            <select
              className="concall-group-select"
              value={newGroup}
              disabled={busy}
              onChange={(e) => setNewGroup(e.target.value)}
              aria-label="Field group"
            >
              {GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={`chip chip-scan tag-chip ${busy ? "busy on" : ""}`}
              disabled={busy}
              onClick={() => void addField()}
            >
              {busy ? "Saving…" : "Add"}
            </button>
          </div>
          <input
            type="text"
            className="buyback-url-input concall-notes-input"
            placeholder="Notes (optional)"
            value={newNotes}
            disabled={busy}
            onChange={(e) => setNewNotes(e.target.value)}
          />
          <label className="concall-required-check">
            <input
              type="checkbox"
              checked={newRequired}
              disabled={busy}
              onChange={(e) => setNewRequired(e.target.checked)}
            />
            Required for future PASS
          </label>
        </div>
      </div>

      <h3 className="buyback-history-title">Pass list</h3>
      {history.length === 0 ? (
        <p className="buyback-history-empty">
          Empty for now — once field extract + PASS rule land, rows appear here.
        </p>
      ) : (
        <div className="buyback-history-table-wrap">
          <table className="buyback-history-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Company</th>
                <th>Period</th>
                <th>Sentiment</th>
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
                  <td>{r.screened_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
