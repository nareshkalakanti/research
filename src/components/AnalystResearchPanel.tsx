"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CompanyWatchCell } from "@/components/CompanyWatchCell";
import {
  isInvestorAnalystMeetAnnouncement,
  parseInstitutionalInvestors,
} from "@/lib/investor-meet-announcement";
import {
  highlightMarketIqFundSegments,
  matchMarketIqFundsInText,
  type MarketIqFundMention,
} from "@/lib/marketiq-fund-aliases";

type LabExtract = {
  engine: string;
  text_chars: number;
  text_excerpt: string;
};

type AnalyseExtract = {
  ticker?: string | null;
  company?: string | null;
  headline?: string | null;
  summary?: string | null;
  category?: string | null;
  sentiment?: string | null;
  confidence?: number | null;
  impact?: number | null;
  sentiment_why?: string | null;
  announcement_date?: string | null;
  funds_mentioned?: MarketIqFundMention[];
};

type LabResult = LabExtract & {
  extract: AnalyseExtract;
  institutional_investors: string[];
  funds_mentioned: MarketIqFundMention[];
};

type HistoryRow = {
  id: number;
  ticker: string | null;
  company: string | null;
  headline: string;
  summary: string;
  category: string;
  sentiment: string;
  impact: number;
  announcement_date: string | null;
  source_url: string | null;
  screened_at: string;
  text_chars?: number | null;
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      const b64 = raw.includes(",") ? raw.split(",")[1]! : raw;
      resolve(b64);
    };
    reader.onerror = () => reject(new Error("Could not read PDF"));
    reader.readAsDataURL(file);
  });
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function sentimentClass(s: string | null | undefined): string {
  const v = (s || "").trim().toLowerCase();
  if (v === "bullish" || v === "positive") return "miq-sent-pill miq-sent-bullish";
  if (v === "bearish" || v === "negative") return "miq-sent-pill miq-sent-bearish";
  if (v === "neutral") return "miq-sent-pill miq-sent-neutral";
  return "miq-sent-pill miq-sent-pending";
}

function FundAliasChips({ funds }: { funds: MarketIqFundMention[] }) {
  if (!funds.length) return null;
  return (
    <div className="miq-fund-chips result-tags" aria-label="Funds mentioned">
      {funds.map((f) => (
        <span
          key={f.chip_key}
          className={`result-tag tag-${f.chip_key}`}
          title={f.name}
        >
          {f.alias}
        </span>
      ))}
    </div>
  );
}

function HighlightedExtractText({
  text,
  mentions,
}: {
  text: string;
  mentions: MarketIqFundMention[];
}) {
  const segs = useMemo(
    () => highlightMarketIqFundSegments(text, mentions),
    [text, mentions],
  );
  return (
    <pre className="miq-lab-text">
      {segs.map((s, i) =>
        s.hit ? (
          <mark key={i} className="miq-fund-mark" title={s.chip_key}>
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </pre>
  );
}

export function AnalystResearchPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [ticker, setTicker] = useState("");
  const [company, setCompany] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [useOcr, setUseOcr] = useState(false);
  const [busy, setBusy] = useState<"extract" | "analyse" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [extract, setExtract] = useState<LabExtract | null>(null);
  const [result, setResult] = useState<LabResult | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/marketiq?history=1&limit=200");
      const json = (await res.json()) as { history?: HistoryRow[] };
      const rows = json.history ?? [];
      setHistory(
        rows.filter((r) =>
          isInvestorAnalystMeetAnnouncement(
            r.category,
            r.headline,
            r.summary,
          ),
        ),
      );
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

  const pdfSrc = useMemo(() => {
    if (fileUrl) return fileUrl;
    const u = url.trim();
    if (!u) return null;
    return `/api/buyback-screen?pdf=${encodeURIComponent(u)}`;
  }, [fileUrl, url]);

  const openPdfHref = useMemo(() => {
    if (fileUrl) return fileUrl;
    return url.trim() || null;
  }, [fileUrl, url]);

  const runExtract = useCallback(async () => {
    setBusy("extract");
    setError(null);
    setResult(null);
    setStatus(
      file
        ? "Reading uploaded PDF…"
        : "Downloading PDF and extracting text…",
    );
    try {
      let bufferBase64: string | undefined;
      if (file) bufferBase64 = await fileToBase64(file);
      if (!bufferBase64 && !url.trim()) {
        setError("Choose a PDF or paste an NSE/BSE PDF URL");
        return;
      }
      const res = await fetch("/api/marketiq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "extract",
          url: url.trim() || null,
          bufferBase64: bufferBase64 || null,
          skipOcr: !useOcr,
        }),
        signal: AbortSignal.timeout(240_000),
      });
      const json = (await res.json()) as LabExtract & {
        ok?: boolean;
        error?: string;
        text?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.error || "Extract failed");
        setExtract(null);
        return;
      }
      const fullText = (json.text || json.text_excerpt || "").trim();
      setExtract({
        engine: json.engine,
        text_chars: json.text_chars || fullText.length,
        text_excerpt: fullText,
      });
      setStatus(
        `Extracted · ${json.engine} · ${(json.text_chars || fullText.length).toLocaleString()} chars`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extract failed");
      setStatus(null);
    } finally {
      setBusy(null);
    }
  }, [file, url, useOcr]);

  const runAnalyse = useCallback(async () => {
    setBusy("analyse");
    setError(null);
    setStatus(
      file
        ? "Analysing uploaded PDF (sentiment / impact)…"
        : "Downloading + analysing PDF…",
    );
    try {
      let bufferBase64: string | undefined;
      if (file) bufferBase64 = await fileToBase64(file);
      if (!bufferBase64 && !url.trim()) {
        setError("Choose a PDF or paste an NSE/BSE PDF URL");
        return;
      }
      const res = await fetch("/api/marketiq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyse",
          url: url.trim() || null,
          bufferBase64: bufferBase64 || null,
          ticker: ticker.trim() || null,
          company: company.trim() || null,
          skipOcr: !useOcr,
        }),
        signal: AbortSignal.timeout(300_000),
      });
      const json = (await res.json()) as LabResult & {
        ok?: boolean;
        error?: string;
        history?: HistoryRow[];
      };
      if (!res.ok || !json.ok || !json.extract) {
        setError(json.error || "Analyse failed");
        return;
      }
      const full =
        ((json as { text?: string }).text || json.text_excerpt || "").trim();
      const investors = parseInstitutionalInvestors(full);
      const fromApi = Array.isArray(json.extract.funds_mentioned)
        ? json.extract.funds_mentioned
        : [];
      const funds_mentioned =
        fromApi.length > 0
          ? fromApi
          : matchMarketIqFundsInText(full, investors);
      setResult({
        engine: json.engine,
        text_chars: json.text_chars,
        text_excerpt: full || json.text_excerpt,
        extract: json.extract,
        institutional_investors: investors,
        funds_mentioned,
      });
      if (full) {
        setExtract({
          engine: json.engine.replace(/\+llm$/, ""),
          text_chars: json.text_chars || full.length,
          text_excerpt: full,
        });
      }
      setStatus(
        [
          `Analysed · ${json.engine}`,
          funds_mentioned.length
            ? `${funds_mentioned.length} fund chip${funds_mentioned.length === 1 ? "" : "s"}`
            : null,
          investors.length
            ? `${investors.length} institutional investors`
            : `impact ${json.extract.impact ?? "—"}`,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      void loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analyse failed");
      setStatus(null);
    } finally {
      setBusy(null);
    }
  }, [file, url, ticker, company, useOcr, loadHistory]);

  const ex = result?.extract;
  const meetHint =
    ex &&
    isInvestorAnalystMeetAnnouncement(
      ex.category,
      ex.headline,
      ex.summary,
    );

  const fundsMentioned = useMemo(() => {
    if (result?.funds_mentioned?.length) return result.funds_mentioned;
    if (extract?.text_excerpt) {
      return matchMarketIqFundsInText(extract.text_excerpt);
    }
    return [] as MarketIqFundMention[];
  }, [result, extract]);

  const copyExtractText = useCallback(async () => {
    const text = extract?.text_excerpt?.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyNote("Copied");
      window.setTimeout(() => setCopyNote(null), 1600);
    } catch {
      setCopyNote("Copy failed");
      window.setTimeout(() => setCopyNote(null), 1600);
    }
  }, [extract]);

  const copyInvestors = useCallback(async () => {
    const list = result?.institutional_investors ?? [];
    if (!list.length) return;
    const text = list.map((n, i) => `${i + 1}. ${n}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopyNote("Investors copied");
      window.setTimeout(() => setCopyNote(null), 1600);
    } catch {
      setCopyNote("Copy failed");
      window.setTimeout(() => setCopyNote(null), 1600);
    }
  }, [result]);

  const investors = result?.institutional_investors ?? [];

  return (
    <section className="panel scan-panel buyback-research-panel buyback-research-panel--split">
      <p className="panel-lead">
        <strong>Research · Analyst.</strong> Upload or paste a Reg-30 investor
        / analyst meet PDF. Extract = full text. Analyse = summary +{" "}
        <strong>all institutional investors</strong> from the annexure.
      </p>

      <div className="buyback-input-row">
        <input
          type="url"
          className="buyback-url-input"
          placeholder="Paste NSE/BSE PDF URL…"
          value={url}
          disabled={busy != null}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void runExtract();
            }
          }}
        />
        <button
          type="button"
          className={`chip chip-scan tag-chip ${busy === "extract" ? "busy on" : ""}`}
          disabled={busy != null || (!file && !url.trim())}
          onClick={() => void runExtract()}
        >
          {busy === "extract" ? "Extracting…" : "1 · Extract"}
        </button>
        <button
          type="button"
          className={`chip chip-scan tag-chip ${busy === "analyse" ? "busy on" : ""}`}
          disabled={busy != null || (!file && !url.trim())}
          onClick={() => void runAnalyse()}
        >
          {busy === "analyse" ? "Analysing…" : "2 · Analyse"}
        </button>
      </div>

      <div className="buyback-source-bar">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="buyback-file-hidden"
          disabled={busy != null}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            if (f) {
              setError(null);
              setResult(null);
              setExtract(null);
            }
          }}
        />
        <button
          type="button"
          className="buyback-upload-btn"
          disabled={busy != null}
          onClick={() => fileInputRef.current?.click()}
        >
          Upload PDF
        </button>
        {file ? (
          <span className="buyback-file-name" title={file.name}>
            Selected: {file.name}
          </span>
        ) : (
          <span className="buyback-file-hint">
            Or paste a URL above, then Extract / Analyse
          </span>
        )}
        {file ? (
          <button
            type="button"
            className="link-btn"
            disabled={busy != null}
            onClick={() => {
              setFile(null);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          >
            Clear upload
          </button>
        ) : null}
        <label
          className={`chip tag-chip miq-ocr${useOcr ? " on" : ""}`}
          title="Off = pdf-parse only. On = vision OCR for scanned PDFs"
        >
          <input
            type="checkbox"
            checked={useOcr}
            disabled={busy != null}
            onChange={(e) => setUseOcr(e.target.checked)}
          />
          OCR
        </label>
        <input
          className="buyback-url-input"
          style={{ maxWidth: 120 }}
          placeholder="Ticker"
          value={ticker}
          disabled={busy != null}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
        />
        <input
          className="buyback-url-input"
          style={{ maxWidth: 220 }}
          placeholder="Company (optional)"
          value={company}
          disabled={busy != null}
          onChange={(e) => setCompany(e.target.value)}
        />
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
              title="Analyst meet PDF"
              className="buyback-pdf-frame"
              src={pdfSrc}
            />
          ) : (
            <div className="buyback-pdf-empty">
              Paste a PDF URL or upload a file to preview
            </div>
          )}
          {openPdfHref && !fileUrl ? (
            <a
              className="link-btn buyback-pdf-open"
              href={openPdfHref}
              target="_blank"
              rel="noreferrer"
            >
              Open on NSE/BSE
            </a>
          ) : null}
        </div>

        <div className="buyback-split-table">
          <div className="buyback-split-label">Extract</div>
          {extract ? (
            <div className="miq-lab-out">
              <div className="miq-lab-out-meta">
                <span>
                  {extract.engine} · {extract.text_chars.toLocaleString()} chars
                  {fundsMentioned.length
                    ? ` · ${fundsMentioned.length} fund${fundsMentioned.length === 1 ? "" : "s"}`
                    : ""}
                </span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => void copyExtractText()}
                >
                  {copyNote || "Copy text"}
                </button>
              </div>
              <FundAliasChips funds={fundsMentioned} />
              <HighlightedExtractText
                text={extract.text_excerpt}
                mentions={fundsMentioned}
              />
            </div>
          ) : (
            <p className="hint tight">
              Run <strong>Extract</strong> for full PDF text, or{" "}
              <strong>Analyse</strong> for sentiment / impact.
            </p>
          )}

          {ex ? (
            <div className="miq-lab-result" style={{ marginTop: 12 }}>
              <div className="miq-lab-out-meta">
                Analysed
                {meetHint ? " · Analyst Meet match" : ""}
                {ex.announcement_date
                  ? ` · ${fmtDate(ex.announcement_date)}`
                  : ""}
              </div>
              <table className="miq-table miq-lab-preview-table">
                <tbody>
                  <tr>
                    <td>
                      <CompanyWatchCell
                        ticker={ex.ticker || ticker}
                        company={ex.company || company || ex.ticker || ticker}
                      />
                      <div className="miq-sym">
                        {(ex.ticker || ticker || "—").toUpperCase()}
                      </div>
                    </td>
                    <td>
                      <div className="miq-headline">
                        {ex.headline || "—"}
                      </div>
                      <FundAliasChips funds={fundsMentioned} />
                      <div className="miq-summary">{ex.summary}</div>
                      {ex.sentiment_why ? (
                        <div className="miq-why">{ex.sentiment_why}</div>
                      ) : null}
                    </td>
                    <td>
                      <span className="miq-cat-pill">
                        {ex.category || "Unclassified"}
                      </span>
                    </td>
                    <td>
                      <span className={sentimentClass(ex.sentiment)}>
                        {(ex.sentiment || "pending").replace(/^./, (c) =>
                          c.toUpperCase(),
                        )}
                        {ex.confidence != null
                          ? ` ${Math.round(
                              ex.confidence > 1
                                ? ex.confidence
                                : ex.confidence * 100,
                            )}%`
                          : ""}
                      </span>
                    </td>
                    <td>
                      <span className="miq-impact">
                        {ex.impact != null ? ex.impact : "—"}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
              {investors.length > 0 ? (
                <div className="analyst-investors">
                  <div className="miq-lab-out-meta">
                    <span>
                      Institutional investors · {investors.length}
                    </span>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => void copyInvestors()}
                    >
                      {copyNote === "Investors copied"
                        ? "Copied"
                        : "Copy list"}
                    </button>
                  </div>
                  <ol className="analyst-investors-list">
                    {investors.map((name) => {
                      const fundHits = matchMarketIqFundsInText(name);
                      return (
                        <li key={name}>
                          {name}
                          {fundHits.length ? (
                            <span className="miq-fund-chips result-tags" style={{ display: "inline-flex", marginLeft: 8, marginTop: 0 }}>
                              {fundHits.map((f) => (
                                <span
                                  key={f.chip_key}
                                  className={`result-tag tag-${f.chip_key}`}
                                  title={f.name}
                                >
                                  {f.alias}
                                </span>
                              ))}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ) : (
                <p className="hint tight" style={{ marginTop: 8 }}>
                  No institutional-investor annexure found in this PDF.
                </p>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="buyback-history" style={{ marginTop: 16 }}>
        <div className="buyback-split-label">
          Recent Analyst Meet screens ({history.length})
        </div>
        {history.length === 0 ? (
          <p className="hint tight">
            No Analyst Meet rows in recent MarketIQ history yet. Analyse a PDF
            above or use MarketIQ → Analyst Meet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="miq-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Details</th>
                  <th>Category</th>
                  <th>Sentiment</th>
                  <th>Impact</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 25).map((r) => (
                  <tr key={r.id}>
                    <td>
                      <CompanyWatchCell
                        ticker={r.ticker}
                        company={r.company || r.ticker}
                      />
                      <div className="miq-sym">
                        {(r.ticker || "—").toUpperCase()}
                      </div>
                      <div className="miq-date">
                        {fmtDate(r.announcement_date || r.screened_at)}
                      </div>
                    </td>
                    <td>
                      <div className="miq-headline">{r.headline}</div>
                      <div className="miq-summary">{r.summary}</div>
                      {r.source_url ? (
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => {
                            setUrl(r.source_url || "");
                            setTicker((r.ticker || "").toUpperCase());
                            setCompany(r.company || "");
                            setFile(null);
                            setExtract(null);
                            setResult(null);
                          }}
                        >
                          Load URL
                        </button>
                      ) : null}
                    </td>
                    <td>
                      <span className="miq-cat-pill">{r.category}</span>
                    </td>
                    <td>
                      <span className={sentimentClass(r.sentiment)}>
                        {r.sentiment}
                      </span>
                    </td>
                    <td>
                      <span className="miq-impact">{r.impact}</span>
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
