"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tradingviewUrl } from "@/lib/links";

type OrderWinRow = {
  awarding_entity: string;
  order_size: string;
  execution: string;
  contractor: string | null;
  size_cr_label?: string | null;
};

type Extract = {
  ticker: string | null;
  company: string | null;
  subject: string | null;
  order_date: string | null;
  orders: OrderWinRow[];
  awarding_entity: string;
  order_size: string;
  execution: string;
  order_size_cr: number | null;
  sales_cr: number | null;
  sales_year: string | null;
  order_to_sales_pct: number | null;
  ltp: number | null;
  baseline_close: number | null;
  drift_pct: number | null;
  confidence: number;
};

type CoreRow = {
  "Awarding entity": string;
  "Order size": string;
  Execution: string;
};

type ScreenResult = {
  ok?: boolean;
  decision?: "pass" | "fail";
  extract?: Extract;
  core?: CoreRow[];
  extract_json?: Record<string, string | number | null>;
  engine?: string;
  text_chars?: number;
  text_excerpt?: string;
  source_url?: string | null;
  error?: string;
  why?: string;
};

type HistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  order_date: string | null;
  awarding_entity: string;
  order_size: string;
  execution: string;
  order_size_cr: number | null;
  sales_cr: number | null;
  order_to_sales_pct: number | null;
  ltp: number | null;
  baseline_close: number | null;
  drift_pct: number | null;
  screened_at: string;
};

const AFCONS_SAMPLE =
  "https://afcons.com/wp-content/uploads/2026/01/Afcons-Corrgindedum-Revised-Letter-For-DRDO-Order-dated-08.01.2025-1.pdf";

const PROGRESS_STEPS = [
  { id: "fetch", label: "Download / read PDF" },
  { id: "text", label: "Extract text (pdf-parse / OCR)" },
  { id: "fields", label: "Parse awarding entity, size, execution" },
  { id: "ticker", label: "Resolve ticker (PDF + company DB) + sales" },
] as const;

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function fmtLtp(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtDrift(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function DriftTag({ pct }: { pct: number | null | undefined }) {
  if (pct == null || !Number.isFinite(pct)) {
    return <span className="mom-tag mom-tag--empty">—</span>;
  }
  return (
    <span
      className={`mom-tag ${
        pct > 0 ? "mom-tag--pos" : pct < 0 ? "mom-tag--neg" : "mom-tag--flat"
      }`}
    >
      {fmtDrift(pct)}
    </span>
  );
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtAnnouncement(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const mi = Number(m[2]) - 1;
  if (mi < 0 || mi > 11) return iso;
  return `Announcement - ${m[3]} ${months[mi]} ${m[1]}`;
}

function decisionClass(d: string | null | undefined): string {
  if (d === "pass") return "buyback-decision pass";
  if (d === "fail") return "buyback-decision fail";
  return "buyback-decision review";
}

export function OrderbookResearchPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(AFCONS_SAMPLE);
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
      const res = await fetch("/api/orderbook-screen?limit=40", {
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
      window.setTimeout(() => setProgressStep(2), 1600),
      window.setTimeout(() => setProgressStep(3), 2800),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [busy]);

  const pdfSrc = useMemo(() => {
    if (fileUrl) return fileUrl;
    const u = url.trim();
    if (!u) return null;
    return `/api/orderbook-screen?pdf=${encodeURIComponent(u)}`;
  }, [fileUrl, url]);

  const downloadPdfHref = useMemo(() => {
    if (fileUrl) return fileUrl;
    const u = url.trim();
    if (!u) return null;
    return `/api/orderbook-screen?pdf=${encodeURIComponent(u)}&download=1`;
  }, [fileUrl, url]);

  const openPdfHref = useMemo(() => {
    if (fileUrl) return fileUrl;
    const u = url.trim();
    return u || null;
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
        setStatus("Step 2–4 · Text, fields, ticker DB + sales…");
        res = await fetch("/api/orderbook-screen", {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(240_000),
        });
      } else {
        setStatus("Step 2–4 · Text, fields, ticker DB + sales…");
        res = await fetch("/api/orderbook-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
          signal: AbortSignal.timeout(240_000),
        });
      }
      setProgressStep(PROGRESS_STEPS.length);
      setStatus("Done — filling table…");
      const json = (await res.json()) as ScreenResult & { error?: string };
      if (!res.ok && !json.extract && !json.core) {
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

  const ex = result?.extract;
  const core = result?.core?.length
    ? result.core
    : ex
      ? [
          {
            "Awarding entity": ex.awarding_entity,
            "Order size": ex.order_size,
            Execution: ex.execution,
          },
        ]
      : [];

  return (
    <section className="panel scan-panel buyback-research-panel buyback-research-panel--split">
      <p className="panel-lead">
        <strong>Research · Order book.</strong> Required:{" "}
        <strong>Awarding entity</strong>, <strong>Order size</strong>,{" "}
        <strong>Execution</strong>, <strong>order date</strong>. List saves{" "}
        <strong>PASS only</strong> (Order/Sales ≥ 50%, Zen-style). Failures are
        not stored.
      </p>

      <div className="buyback-input-row">
        <input
          type="url"
          className="buyback-url-input"
          placeholder="Paste BSE/NSE PDF URL…"
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
          Upload new PDF
        </button>
        {file ? (
          <span className="buyback-file-name" title={file.name}>
            Selected: {file.name}
          </span>
        ) : (
          <span className="buyback-file-hint">Order-win / LOI PDF</span>
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
        <button
          type="button"
          className="link-btn"
          disabled={busy}
          onClick={() => {
            setUrl(AFCONS_SAMPLE);
            setFile(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        >
          Sample (AFCONS)
        </button>
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
              title="Order PDF"
              className="buyback-pdf-frame"
              src={pdfSrc}
            />
          ) : (
            <div className="buyback-pdf-empty">
              Upload a PDF or paste a URL to preview
            </div>
          )}
          {downloadPdfHref || openPdfHref ? (
            <div className="buyback-pdf-actions">
              {downloadPdfHref ? (
                <a
                  className="link-btn buyback-pdf-open"
                  href={downloadPdfHref}
                  download={file ? file.name : undefined}
                  target={file ? undefined : "_blank"}
                  rel="noreferrer"
                >
                  Download PDF
                </a>
              ) : null}
              {openPdfHref && !fileUrl ? (
                <a
                  className="link-btn buyback-pdf-open"
                  href={openPdfHref}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open source
                </a>
              ) : null}
            </div>
          ) : null}
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
                Scanned PDFs may take longer (OCR). Ticker from Symbol, BSE
                scrip, or company name in DB.
              </p>
            </div>
          ) : !result ? (
            <div className="buyback-pdf-empty">
              Click <strong>Extract</strong> for Awarding entity / Order size /
              Execution
            </div>
          ) : (
            <>
              <div className={decisionClass(result.decision)}>
                {result.why || "Order extract"}
              </div>

              <table className="buyback-out-table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Awarding entity</th>
                    <th scope="col">Order size</th>
                    <th scope="col">Execution</th>
                  </tr>
                </thead>
                <tbody>
                  {core.map((c, i) => (
                    <tr key={`${c["Awarding entity"]}-${i}`}>
                      <td>{i + 1}</td>
                      <td>{c["Awarding entity"]}</td>
                      <td>{c["Order size"]}</td>
                      <td>{c.Execution}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {ex ? (
                <table className="buyback-out-table" style={{ marginTop: 12 }}>
                  <tbody>
                    <tr>
                      <th scope="row">Announcement</th>
                      <td>{fmtAnnouncement(ex.order_date)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Ticker</th>
                      <td>{ex.ticker || "—"}</td>
                    </tr>
                    <tr>
                      <th scope="row">Company</th>
                      <td>{ex.company || "—"}</td>
                    </tr>
                    {(ex.orders || [])
                      .filter((o) => o.contractor)
                      .map((o, i) => (
                        <tr key={`c-${i}`}>
                          <th scope="row">Contractor #{i + 1}</th>
                          <td>{o.contractor}</td>
                        </tr>
                      ))}
                    <tr>
                      <th scope="row">Size as ₹ Cr (total)</th>
                      <td>
                        {ex.orders?.[0]?.size_cr_label ||
                          (ex.order_size_cr != null
                            ? `${fmtCr(ex.order_size_cr)}${
                                (ex.orders?.length ?? 0) > 1
                                  ? ` · ${ex.orders.length} contracts`
                                  : ""
                              }`
                            : "Not disclosed")}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Annual sales</th>
                      <td>
                        {ex.sales_cr != null
                          ? `${fmtCr(ex.sales_cr)}${ex.sales_year ? ` (${ex.sales_year})` : ""}`
                          : "Not disclosed (needs Screener lookup)"}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Order / Sales</th>
                      <td>
                        {ex.order_to_sales_pct != null
                          ? fmtPct(ex.order_to_sales_pct)
                          : ex.order_size_cr != null
                            ? "Need sales"
                            : "Not disclosed"}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">LTP</th>
                      <td>{fmtLtp(ex.ltp)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Δ order</th>
                      <td>
                        <DriftTag pct={ex.drift_pct} />
                        {ex.baseline_close != null
                          ? ` · vs ${fmtLtp(ex.baseline_close)} pre-announce`
                          : ""}
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
                    result.extract_json ||
                      (ex
                        ? {
                            "Awarding entity": ex.awarding_entity,
                            "Order size": ex.order_size,
                            Execution: ex.execution,
                            "Size as ₹ Cr (total)":
                              ex.order_size_cr ?? "Not disclosed",
                            "Annual sales ₹ Cr":
                              ex.sales_cr ?? "Not disclosed",
                            "Order / Sales":
                              ex.order_to_sales_pct != null
                                ? `${ex.order_to_sales_pct.toFixed(2)}%`
                                : "Not disclosed",
                          }
                        : core[0] || {}),
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
          Order book list (PASS)
          <span className="buyback-history-count">{history.length}</span>
        </h3>
        <p className="buyback-history-empty" style={{ marginBottom: 8 }}>
          PASS only · Order/Sales ≥ 50% · Awarding · Size · Execution ·
          Announcement date
        </p>
        {history.length === 0 ? (
          <p className="buyback-history-empty">
            No PASS screens yet (need Order/Sales ≥ 50%).
          </p>
        ) : (
          <div className="buyback-pass-table-wrap">
            <table className="buyback-pass-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Announcement</th>
                  <th>Awarding entity</th>
                  <th>Order size</th>
                  <th>Execution</th>
                  <th>Order ₹ Cr</th>
                  <th>Sales ₹ Cr</th>
                  <th>Order / Sales</th>
                  <th className="num">LTP</th>
                  <th
                    className="num"
                    title="LTP vs last close before order announcement"
                  >
                    Δ order
                  </th>
                  <th>PDF</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="buyback-pass-row">
                    <td>
                      {h.ticker ? (
                        <a
                          className="buyback-pass-company"
                          href={tradingviewUrl(h.ticker, "NSE")}
                          target="_blank"
                          rel="noreferrer"
                          title={`${h.company || h.ticker} — TradingView`}
                        >
                          {h.company || h.ticker}
                        </a>
                      ) : (
                        <span className="buyback-pass-company">
                          {h.company || "—"}
                        </span>
                      )}
                      {h.ticker ? (
                        <span className="buyback-pass-co">{h.ticker}</span>
                      ) : null}
                    </td>
                    <td>{fmtAnnouncement(h.order_date)}</td>
                    <td>{h.awarding_entity}</td>
                    <td>{h.order_size}</td>
                    <td>{h.execution}</td>
                    <td>{fmtCr(h.order_size_cr)}</td>
                    <td>{fmtCr(h.sales_cr)}</td>
                    <td>
                      <span className={decisionClass("pass")}>
                        {fmtPct(h.order_to_sales_pct)}
                      </span>
                    </td>
                    <td
                      className="num"
                      title={
                        h.baseline_close != null
                          ? `Close before order announcement ${fmtLtp(h.baseline_close)}`
                          : undefined
                      }
                    >
                      {fmtLtp(h.ltp)}
                    </td>
                    <td
                      className="num"
                      title={
                        h.baseline_close != null
                          ? `Close before order announcement ${fmtLtp(h.baseline_close)}`
                          : undefined
                      }
                    >
                      <DriftTag pct={h.drift_pct} />
                    </td>
                    <td>
                      {h.source_url ? (
                        <a
                          className="link-btn"
                          href={h.source_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          PDF
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
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
