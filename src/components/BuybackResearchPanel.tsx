"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Extract = {
  ticker: string | null;
  company: string | null;
  subject: string | null;
  method: "tender" | "open_market" | "unknown";
  method_evidence: string | null;
  offer_price: number | null;
  max_buyback_price: number | null;
  issue_shares: number | null;
  issue_amount_cr: number | null;
  face_value: number | null;
  listing: string | null;
  record_date: string | null;
  tender_open: string | null;
  tender_close: string | null;
  filing_kind: string;
  confidence: number;
};

type ScreenResult = {
  ok?: boolean;
  decision?:
    | "pass_tender"
    | "skip_open_market"
    | "skip_low_upside"
    | "need_review";
  why?: string;
  extract?: Extract;
  cmp?: number | null;
  upside_pct?: number | null;
  engine?: string;
  text_chars?: number;
  text_excerpt?: string;
  source_url?: string | null;
  error?: string;
  screened_at?: string;
};

function decisionLabel(d: string | undefined): string {
  switch (d) {
    case "pass_tender":
      return "PASS — Tender, upside > 8%";
    case "skip_open_market":
      return "SKIP — Open market (not tender)";
    case "skip_low_upside":
      return "FAIL — Tender, but upside ≤ 8%";
    default:
      return "REVIEW — Need clearer filing / price";
  }
}

function decisionClass(d: string | undefined): string {
  switch (d) {
    case "pass_tender":
      return "buyback-decision pass";
    case "skip_open_market":
      return "buyback-decision skip";
    case "skip_low_upside":
      return "buyback-decision fail";
    default:
      return "buyback-decision review";
  }
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

const DEMO_URL =
  "https://www.bseindia.com/xml-data/corpfiling/AttachLive/739d7f51-56ee-4dce-8e22-717f501f31d9.pdf";

/** Typical LOO entitlements (override from filing if known). */
const ENTITLEMENT_PRESETS = {
  small: { label: "Small shareholder (~5.73%)", pct: 5.733 },
  general: { label: "General (~1.90%)", pct: 1.895 },
} as const;

const PROGRESS_STEPS = [
  { id: "fetch", label: "Download / read PDF" },
  { id: "text", label: "Extract text (pdf-parse)" },
  { id: "fields", label: "Parse issue type, price, size" },
  { id: "cmp", label: "Fetch CMP + upside check" },
] as const;

function fmtShares(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN");
}

type HistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  method: string;
  decision: string;
  offer_price: number | null;
  cmp: number | null;
  upside_pct: number | null;
  subject: string | null;
  screened_at: string;
  record_date: string | null;
  issue_open: string | null;
  issue_close: string | null;
  buyback_type: string | null;
  issue_shares: number | null;
  issue_shares_cr: number | null;
  issue_amount_cr: number | null;
};

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function BuybackResearchPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(DEMO_URL);
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [progressStep, setProgressStep] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [passHistory, setPassHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const [entitlementKey, setEntitlementKey] = useState<"small" | "general">(
    "small",
  );
  const [targetAccepted, setTargetAccepted] = useState(50);

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
    // Advance UI steps while the single POST runs (no streaming yet).
    const timers = [
      window.setTimeout(() => setProgressStep(1), 400),
      window.setTimeout(() => setProgressStep(2), 1800),
      window.setTimeout(() => setProgressStep(3), 3200),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [busy]);

  const loadPassHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/buyback-screen?decision=pass&limit=1", {
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        history?: HistoryRow[];
      };
      if (res.ok && json.history) setPassHistory(json.history);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadPassHistory();
  }, [loadPassHistory]);

  const pdfSrc = useMemo(() => {
    if (fileUrl) return fileUrl;
    const u = url.trim();
    if (!u) return null;
    // BSE/NSE refuse iframe embeds — serve via same-origin proxy
    return `/api/buyback-screen?pdf=${encodeURIComponent(u)}`;
  }, [fileUrl, url]);

  const openPdfHref = useMemo(() => {
    if (fileUrl) return fileUrl;
    const u = url.trim();
    return u || null;
  }, [fileUrl, url]);

  const run = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed && !file) {
      setError("Paste a BSE/NSE PDF URL or choose a file");
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
        : "Step 1/4 · Downloading PDF from BSE/NSE…",
    );
    try {
      let res: Response;
      if (file) {
        const form = new FormData();
        if (trimmed) form.set("url", trimmed);
        form.set("file", file);
        setStatus("Step 2–4 · Extracting text, fields, CMP…");
        res = await fetch("/api/buyback-screen", {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(240_000),
        });
      } else {
        setStatus("Step 2–4 · Extracting text, fields, CMP…");
        res = await fetch("/api/buyback-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
          signal: AbortSignal.timeout(240_000),
        });
      }
      setProgressStep(PROGRESS_STEPS.length);
      setStatus("Done — filling table…");
      const json = (await res.json()) as ScreenResult & { error?: string };
      if (!res.ok && !json.extract && !json.text_excerpt) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setResult(json);
      if (!json.ok && json.error) setError(json.error);
      await loadPassHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extract failed");
    } finally {
      setBusy(false);
      setStatus(null);
      setStartedAt(null);
    }
  }, [url, file, loadPassHistory]);

  const ex = result?.extract;

  const holdPlan = useMemo(() => {
    if (result?.decision !== "pass_tender") return null;
    const offer = result.extract?.offer_price ?? null;
    const cmp = result.cmp ?? null;
    const pct = ENTITLEMENT_PRESETS[entitlementKey].pct;
    const accepted = Math.max(1, Math.round(targetAccepted));
    const hold = Math.ceil(accepted / (pct / 100));
    const leftover = Math.max(0, hold - accepted);
    const cost = cmp != null ? hold * cmp : null;
    const grossPremium =
      offer != null && cmp != null ? accepted * (offer - cmp) : null;
    const totalValue =
      offer != null && cmp != null
        ? accepted * offer + leftover * cmp
        : null;
    return {
      pct,
      accepted,
      hold,
      leftover,
      cost,
      grossPremium,
      totalValue,
      label: ENTITLEMENT_PRESETS[entitlementKey].label,
    };
  }, [result, entitlementKey, targetAccepted]);

  const pickNewPdf = useCallback(() => {
    setResult(null);
    setError(null);
    setShowText(false);
    fileInputRef.current?.click();
  }, []);

  const rows: Array<{ label: string; value: string }> = ex
    ? [
        { label: "Decision", value: decisionLabel(result?.decision) },
        { label: "Ticker", value: ex.ticker || "—" },
        { label: "Company", value: ex.company || "—" },
        {
          label: "Issue Type",
          value:
            ex.method === "tender"
              ? "Tender Offer"
              : ex.method === "open_market"
                ? "Open Market"
                : "Unknown",
        },
        {
          label: "Issue Size (Shares)",
          value: fmtShares(ex.issue_shares),
        },
        {
          label: "Issue Size (Amount)",
          value:
            ex.issue_amount_cr != null
              ? `₹${ex.issue_amount_cr.toLocaleString("en-IN")} Crores`
              : "—",
        },
        {
          label: "Buyback Price",
          value:
            ex.offer_price != null
              ? `${fmtPrice(ex.offer_price)} per share`
              : "—",
        },
        {
          label: "Face Value",
          value:
            ex.face_value != null
              ? `${fmtPrice(ex.face_value)} per share`
              : "—",
        },
        { label: "Listing at", value: ex.listing || "—" },
        { label: "CMP", value: fmtPrice(result?.cmp) },
        { label: "Upside", value: fmtPct(result?.upside_pct) },
        { label: "Record date", value: ex.record_date || "—" },
        { label: "Tender open", value: ex.tender_open || "—" },
        { label: "Tender close", value: ex.tender_close || "—" },
        { label: "Filing kind", value: ex.filing_kind || "—" },
        { label: "Subject", value: ex.subject || "—" },
        { label: "Evidence", value: ex.method_evidence || "—" },
        {
          label: "Max / avg price",
          value: fmtPrice(ex.max_buyback_price),
        },
        {
          label: "Engine",
          value: `${result?.engine || "—"} · ${(result?.text_chars ?? 0).toLocaleString()} chars`,
        },
      ]
    : [];

  return (
    <section className="panel scan-panel buyback-research-panel buyback-research-panel--split">
      <p className="panel-lead">
        <strong>Research · Buyback.</strong> PDF on the left, extract table on
        the right. Tender only; upside{" "}
        <strong>(offer − CMP) / CMP &gt; 8%</strong>.
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
          onClick={pickNewPdf}
        >
          Upload new PDF
        </button>
        {file ? (
          <span className="buyback-file-name" title={file.name}>
            Selected: {file.name}
          </span>
        ) : (
          <span className="buyback-file-hint">
            Or paste a URL above, then Extract
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
        <button
          type="button"
          className="link-btn"
          disabled={busy}
          onClick={() => {
            setUrl(DEMO_URL);
            setFile(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        >
          Sample (PVRINOX)
        </button>
      </div>

      {status ? (
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
              title="Buyback filing PDF"
              className="buyback-pdf-frame"
              src={pdfSrc}
            />
          ) : (
            <div className="buyback-pdf-empty">Paste a PDF URL to preview</div>
          )}
          {openPdfHref && !fileUrl ? (
            <a
              className="link-btn buyback-pdf-open"
              href={openPdfHref}
              target="_blank"
              rel="noreferrer"
            >
              Open on BSE/NSE
            </a>
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
                Large Letters of Offer can take 10–60s (download + text parse +
                CMP).
              </p>
            </div>
          ) : !result ? (
            <div className="buyback-pdf-empty">
              Click <strong>Extract</strong> to fill the table
            </div>
          ) : (
            <>
              <div className={decisionClass(result.decision)}>
                {decisionLabel(result.decision)}
              </div>
              {result.why ? <p className="buyback-why">{result.why}</p> : null}

              {holdPlan ? (
                <div className="buyback-hold-calc">
                  <h4 className="buyback-hold-title">
                    How many to hold (illustrative)
                  </h4>
                  <p className="buyback-hold-note">
                    Not advice — uses LOO-style entitlement % to estimate shares
                    to hold on record date for a target acceptance.
                  </p>
                  <div className="buyback-hold-controls">
                    <label>
                      Category
                      <select
                        value={entitlementKey}
                        onChange={(e) =>
                          setEntitlementKey(
                            e.target.value === "general" ? "general" : "small",
                          )
                        }
                      >
                        <option value="small">
                          {ENTITLEMENT_PRESETS.small.label}
                        </option>
                        <option value="general">
                          {ENTITLEMENT_PRESETS.general.label}
                        </option>
                      </select>
                    </label>
                    <label>
                      Target accepted @ offer
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={targetAccepted}
                        onChange={(e) =>
                          setTargetAccepted(
                            Math.max(1, Number(e.target.value) || 1),
                          )
                        }
                      />
                    </label>
                  </div>
                  <table className="buyback-out-table">
                    <tbody>
                      <tr>
                        <th scope="row">Hold on record date</th>
                        <td>
                          <strong>{fmtShares(holdPlan.hold)}</strong> shares
                        </td>
                      </tr>
                      <tr>
                        <th scope="row">Expected accepted</th>
                        <td>
                          {fmtShares(holdPlan.accepted)} @{" "}
                          {fmtPrice(result.extract?.offer_price)}
                        </td>
                      </tr>
                      <tr>
                        <th scope="row">Leftover @ CMP</th>
                        <td>
                          {fmtShares(holdPlan.leftover)} @{" "}
                          {fmtPrice(result.cmp)}
                        </td>
                      </tr>
                      <tr>
                        <th scope="row">Approx capital (at CMP)</th>
                        <td>{fmtPrice(holdPlan.cost)}</td>
                      </tr>
                      <tr>
                        <th scope="row">Gross premium vs CMP</th>
                        <td>{fmtPrice(holdPlan.grossPremium)}</td>
                      </tr>
                      <tr>
                        <th scope="row">Blended value</th>
                        <td>{fmtPrice(holdPlan.totalValue)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : null}

              <table className="buyback-out-table">
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label}>
                      <th scope="row">{r.label}</th>
                      <td>{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

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
          Pass history
          <span className="buyback-history-count">
            {passHistory.length}/1
          </span>
        </h3>
        {passHistory.length === 0 ? (
          <p className="buyback-history-empty">
            No PASS screens yet (tender + upside &gt; 8%).
          </p>
        ) : (
          <div className="buyback-pass-table-wrap">
            <table className="buyback-pass-table">
              <thead>
                <tr>
                  <th>Company Name</th>
                  <th>Record Date</th>
                  <th>Issue Open</th>
                  <th>Issue Close</th>
                  <th>Buyback Type</th>
                  <th>BuyBack Price (Rs. Per Share)</th>
                  <th>Current Market Price (Rs. Per Share)</th>
                  <th>Issue Size - Shares (Rs. Cr.)</th>
                  <th>Issue Size - Amount (Rs. Cr.)</th>
                  <th>Compare</th>
                </tr>
              </thead>
              <tbody>
                {passHistory.map((h) => (
                  <tr key={h.id} className="buyback-pass-row">
                    <td>
                      <button
                        type="button"
                        className="buyback-pass-company"
                        onClick={() => {
                          if (h.source_url) {
                            setUrl(h.source_url);
                            setFile(null);
                          }
                        }}
                        title={h.subject || h.source_url || ""}
                      >
                        {h.company || h.ticker || "—"}
                      </button>
                      {h.ticker ? (
                        <span className="buyback-pass-co">{h.ticker}</span>
                      ) : null}
                    </td>
                    <td>{h.record_date || "—"}</td>
                    <td>{h.issue_open || "—"}</td>
                    <td>{h.issue_close || "—"}</td>
                    <td>{h.buyback_type || "Tender Offer"}</td>
                    <td>{fmtNum(h.offer_price)}</td>
                    <td>{fmtNum(h.cmp)}</td>
                    <td>{fmtNum(h.issue_shares_cr)}</td>
                    <td>{fmtNum(h.issue_amount_cr)}</td>
                    <td>
                      {h.source_url ? (
                        <a
                          className="link-btn"
                          href={h.source_url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
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
