"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tradingviewUrl } from "@/lib/links";
import { TickerSuggest } from "@/components/TickerSuggest";
import { ExecSummaryHtml } from "@/components/ExecSummaryHtml";
import { formatExecutiveSummaryText } from "@/lib/concall-quant-format";
import {
  HighlightsBulletList,
  MetricSelectorBox,
} from "@/components/EarningsHighlightsCard";

type Extract = Record<string, unknown>;

type MaterialText = {
  role?: "transcript" | "ppt";
  ok?: boolean;
  text?: string;
  text_chars?: number;
  engine?: string;
  source_url?: string | null;
  error?: string;
};

type ScreenResult = {
  ok?: boolean;
  decision?: "pass" | "review" | "fail";
  why?: string;
  extract?: Extract;
  extract_json?: Extract;
  engine?: string;
  text_chars?: number;
  text_excerpt?: string;
  materials?: {
    transcript?: MaterialText;
    ppt?: MaterialText;
  };
  combined_text?: string;
  source_url?: string | null;
  error?: string;
  mode?: string;
  save_gaps?: Array<{ field: string; reason: string }>;
};

type HistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  call_date: string | null;
  period: string | null;
  sector: string | null;
  industry: string | null;
  revenue_cr: number | null;
  revenue_yoy_pct: number | null;
  ebitda_margin_pct: number | null;
  guidance_label: string | null;
  sentiment: string | null;
  sentiment_score: number | null;
  result_quality: string | null;
  mgmt_sentiment: string | null;
  highlights: Array<{ text: string; polarity: string }>;
  docs?: {
    summary: string | null;
    transcript: string | null;
    ppt: string | null;
    has_combined?: boolean;
    combined_chars?: number;
    has_executive?: boolean;
    has_highlights_json?: boolean;
  } | null;
  decision: string;
  ltp: number | null;
  baseline_close: number | null;
  drift_pct: number | null;
  screened_at: string;
};

type Meta = {
  company_name?: string | null;
  nse_symbol?: string | null;
  bse_code?: string | null;
  call_date?: string | null;
  quarter?: string | null;
  fiscal_year?: string | null;
  document_type?: string | null;
  document_note?: string | null;
};

type Tone = {
  overall_tone?: string | null;
  net_sentiment_score?: number | null;
  justification?: string | null;
};

type Card = {
  result_quality?: string | null;
  mgmt_sentiment?: string | null;
  sector?: string | null;
  industry?: string | null;
  highlights?: Array<{ text: string; polarity: string }>;
  strengths?: string[];
  weaknesses?: string[];
  kpi_cards?: Array<{ label: string; value: string; subtext?: string }>;
  sentiment_score?: number | null;
  sentiment_tone?: string | null;
  sentiment_label?: string | null;
  quote?: string | null;
  conviction?: string | null;
  brief?: boolean;
};

const PROGRESS_STEPS = [
  { id: "fetch", label: "Download / read PDF" },
  { id: "text", label: "Extract text (pdf-parse)" },
  { id: "llm", label: "Analyze (LLM card)" },
  { id: "save", label: "Prices + save PASS list" },
] as const;

/** Single flow: text → analyze → save */
const PIPELINE_STEPS = [
  { id: "text", label: "Extract text" },
  { id: "llm", label: "Analyze (summary + highlights)" },
  { id: "save", label: "Prices + save PASS list" },
] as const;

/** Re-analyze from saved Docs·Text only */
const ANALYZE_STEPS = [
  { id: "llm", label: "Analyze (summary + highlights)" },
  { id: "save", label: "Prices + save PASS list" },
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

function fmtCr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function fmtLtp(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtScore(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return String(Math.round(n * 100) / 100);
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

function ToneTag({ tone }: { tone: string | null | undefined }) {
  if (!tone) return <span className="mom-tag mom-tag--empty">—</span>;
  const t = tone.toLowerCase();
  const cls =
    t === "bullish" || t === "optimistic" || t === "excellent" || t === "strong"
      ? "mom-tag mom-tag--pos"
      : t === "cautious" || t === "defensive" || t === "bearish"
        ? "mom-tag mom-tag--neg"
        : "mom-tag mom-tag--flat";
  return <span className={cls}>{tone}</span>;
}

function QualityTag({ q }: { q: string | null | undefined }) {
  return (
    <MetricSelectorBox
      label="Result quality"
      value={q}
      kind="quality"
      showLabel={false}
    />
  );
}

function SentimentTag({ s }: { s: string | null | undefined }) {
  return (
    <MetricSelectorBox
      label="Tone"
      value={s}
      kind="sentiment"
      showLabel={false}
    />
  );
}

function HighlightList({
  items,
}: {
  items: Array<{ text: string; polarity: string }> | undefined;
}) {
  return <HighlightsBulletList items={items} />;
}

function normalizePolarity(
  raw: string | null | undefined,
  text: string,
): "positive" | "negative" | "neutral" {
  const p = String(raw || "").toLowerCase();
  if (p === "positive" || p === "negative" || p === "neutral") return p;
  if (
    /miss|cut|reset|delay|destock|divest|decline|loss|weak|compress|headwind|cautious/i.test(
      text,
    )
  ) {
    return "negative";
  }
  if (
    /grew|growth|won|win|target|acquisition completed|closed|reaffirm|investment|commission|capacity|beat|raise|strong \+|PAT \+|Revenue \+/i.test(
      text,
    )
  ) {
    return "positive";
  }
  return "neutral";
}

function KpiCards({
  items,
}: {
  items: Array<{ label: string; value: string; subtext?: string }> | undefined;
}) {
  if (!items?.length) return null;
  return (
    <div className="concall-kpi-grid">
      {items.slice(0, 4).map((k, i) => (
        <div key={`${k.label}-${i}`} className="concall-kpi-card">
          <div className="concall-kpi-label">{k.label}</div>
          <div className="concall-kpi-value">{k.value}</div>
          {k.subtext ? (
            <div className="concall-kpi-sub">{k.subtext}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ResultBrief({ card }: { card: Card }) {
  const strengths = Array.isArray(card.strengths) ? card.strengths : [];
  const weaknesses = Array.isArray(card.weaknesses) ? card.weaknesses : [];
  const hasRqDetail = strengths.length > 0 || weaknesses.length > 0;
  const highlights = Array.isArray(card.highlights) ? card.highlights : [];
  const quote = card.quote?.replace(/^["“]|["”]$/g, "").trim() || null;

  if (
    !hasRqDetail &&
    !highlights.length &&
    !card.kpi_cards?.length &&
    !(quote || card.conviction || card.sentiment_tone)
  ) {
    return null;
  }

  return (
    <div className="concall-brief">
      <KpiCards items={card.kpi_cards} />

      {highlights.length > 0 ? (
        <section className="concall-brief-block">
          <h4 className="concall-brief-title">Key Highlights</h4>
          <HighlightList items={highlights} />
        </section>
      ) : null}

      {hasRqDetail ? (
        <section className="concall-brief-block">
          <h4 className="concall-brief-title">Strengths / Weaknesses</h4>
          <ul className="concall-brief-list">
            {strengths.map((s, i) => (
              <li key={`s-${i}`} className="concall-brief-item concall-brief-item--ok">
                <span aria-hidden>✓</span>
                <span>{s}</span>
              </li>
            ))}
            {weaknesses.map((w, i) => (
              <li key={`w-${i}`} className="concall-brief-item concall-brief-item--warn">
                <span aria-hidden>⚠</span>
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {(quote || card.conviction || card.sentiment_tone) && (
        <section className="concall-brief-block">
          <h4 className="concall-brief-title">Sentiment detail</h4>
          {card.sentiment_tone ? (
            <p className="concall-brief-meta">
              <span className="concall-brief-k">Tone:</span> {card.sentiment_tone}
            </p>
          ) : null}
          {quote ? (
            <p className="concall-brief-meta">
              <span className="concall-brief-k">Quote:</span> “{quote}”
            </p>
          ) : null}
          {card.conviction ? (
            <p className="concall-brief-meta">
              <span className="concall-brief-k">Conviction:</span>{" "}
              {card.conviction}
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}

function fmtCallDate(iso: string | null | undefined): string {
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
  return `${m[3]} ${months[mi]} ${m[1]}`;
}

/** Docs column icons — StockScans-style line icons (no icon lib). */
function DocIcon({
  kind,
}: {
  kind: "summary" | "transcript" | "ppt" | "text" | "analyze";
}) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
    className: "concall-docs-ico",
  };
  if (kind === "summary") {
    // Wand + sparkles
    return (
      <svg {...common}>
        <path d="m15 4-9 9 3 3 9-9-3-3z" />
        <path d="m12 7 3 3" />
        <path d="M5 19h14" />
        <path d="M5 5.5 6.5 4" />
        <path d="m18.5 4 1.5 1.5" />
        <path d="M3.5 10H5" />
        <path d="M19 10h1.5" />
      </svg>
    );
  }
  if (kind === "transcript") {
    return (
      <svg {...common}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M16 13H8" />
        <path d="M16 17H8" />
        <path d="M10 9H8" />
      </svg>
    );
  }
  if (kind === "ppt") {
    return (
      <svg {...common}>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8" />
        <path d="M12 17v4" />
        <path d="M7 8h5v5H7z" />
        <path d="M14 9h3" />
        <path d="M14 12h3" />
      </svg>
    );
  }
  if (kind === "text") {
    return (
      <svg {...common}>
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h10" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

function DocsColumn({
  docs,
  fallbackUrl,
  rowId,
  onLoadText,
  onRunText,
  onOpenSummary,
  busyId,
}: {
  docs?: HistoryRow["docs"];
  fallbackUrl: string | null;
  rowId: number;
  onLoadText?: (id: number) => void;
  onRunText?: (id: number) => void;
  onOpenSummary?: (id: number) => void;
  busyId?: number | null;
}) {
  const d = docs || {
    summary: null,
    transcript: fallbackUrl,
    ppt: null,
    has_combined: false,
    combined_chars: 0,
  };
  const txUrl = d.transcript || (!d.ppt ? fallbackUrl : null);
  const pptUrl = d.ppt;
  const hasText = Boolean(d.has_combined);
  const hasSummary = Boolean(
    d.has_executive || (d.summary && d.summary.length > 40),
  );
  const chars = d.combined_chars || 0;
  const rowBusy = busyId === rowId;
  if (!txUrl && !pptUrl && !hasText && !hasSummary) {
    return (
      <div className="concall-docs" data-row={rowId}>
        <span className="concall-docs-empty">—</span>
      </div>
    );
  }
  return (
    <ul className="concall-docs concall-docs--list" data-row={rowId}>
      {hasSummary ? (
        <li className="concall-docs-item">
          <button
            type="button"
            className="concall-docs-link concall-docs-link--btn concall-docs-link--summary"
            title="Open executive summary"
            disabled={rowBusy}
            onClick={() => onOpenSummary?.(rowId)}
          >
            <DocIcon kind="summary" />
            Summary
          </button>
        </li>
      ) : null}
      {txUrl ? (
        <li className="concall-docs-item">
          <a
            className="concall-docs-link"
            href={pdfHref(txUrl)}
            target="_blank"
            rel="noreferrer"
          >
            <DocIcon kind="transcript" />
            Transcript
          </a>
        </li>
      ) : null}
      {pptUrl ? (
        <li className="concall-docs-item">
          <a
            className="concall-docs-link"
            href={pdfHref(pptUrl)}
            target="_blank"
            rel="noreferrer"
          >
            <DocIcon kind="ppt" />
            PPT
          </a>
        </li>
      ) : null}
      {hasText ? (
        <>
          <li className="concall-docs-item">
            <button
              type="button"
              className="concall-docs-link concall-docs-link--btn"
              title={`Open full text (${chars.toLocaleString()} chars)`}
              disabled={rowBusy}
              onClick={() => onLoadText?.(rowId)}
            >
              <DocIcon kind="text" />
              Text
              {chars > 0 ? (
                <span className="concall-docs-chars">
                  {chars >= 1000
                    ? `${Math.round(chars / 1000)}k`
                    : String(chars)}
                </span>
              ) : null}
            </button>
          </li>
          <li className="concall-docs-item">
            <button
              type="button"
              className="concall-docs-link concall-docs-link--btn concall-docs-link--analyze"
              title="Analyze: quant summary + highlights → PASS columns"
              disabled={rowBusy || !onRunText}
              onClick={() => onRunText?.(rowId)}
            >
              <DocIcon kind="analyze" />
              {rowBusy ? "Running…" : "Analyze"}
            </button>
          </li>
        </>
      ) : null}
    </ul>
  );
}

/** Open PDF via API proxy (local uploads + exchange hosts). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Highlight search hits; active hit gets id for scroll-into-view. */
function renderTextWithSearch(
  text: string,
  query: string,
  activeOffset: number | null,
): { __html: string } {
  const q = query.trim();
  if (!q) return { __html: escapeHtml(text) };
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let out = "";
  let from = 0;
  while (from < text.length) {
    const i = lower.indexOf(needle, from);
    if (i < 0) {
      out += escapeHtml(text.slice(from));
      break;
    }
    out += escapeHtml(text.slice(from, i));
    const chunk = escapeHtml(text.slice(i, i + q.length));
    const cls =
      activeOffset === i
        ? "concall-text-hit concall-text-hit--active"
        : "concall-text-hit";
    out += `<mark id="concall-hit-${i}" class="${cls}">${chunk}</mark>`;
    from = i + Math.max(1, q.length);
  }
  return { __html: out };
}

function pdfHref(sourceUrl: string, download = false): string {
  const q = download ? "&download=1" : "";
  return `/api/concall-screen?pdf=${encodeURIComponent(sourceUrl)}${q}`;
}

export function ConcallResearchPanel() {
  const txFileRef = useRef<HTMLInputElement>(null);
  const pptFileRef = useRef<HTMLInputElement>(null);
  const [urlTranscript, setUrlTranscript] = useState("");
  const [urlPpt, setUrlPpt] = useState("");
  const [tickerInput, setTickerInput] = useState("");
  const [ocrProgress, setOcrProgress] = useState<{
    message: string;
    pct: number;
    page?: number;
    pages?: number;
    role?: string;
  } | null>(null);
  const [fileTranscript, setFileTranscript] = useState<File | null>(null);
  const [filePpt, setFilePpt] = useState<File | null>(null);
  const [txPreviewUrl, setTxPreviewUrl] = useState<string | null>(null);
  const [pptPreviewUrl, setPptPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [textBusy, setTextBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoverHits, setDiscoverHits] = useState<
    Array<{
      id: string;
      kind: string;
      title: string;
      period: string | null;
      url: string;
      provider: string;
      score: number;
      extractable: boolean;
    }>
  >([]);
  const [status, setStatus] = useState<string | null>(null);
  const [progressStep, setProgressStep] = useState(0);
  const [progressMode, setProgressMode] = useState<
    "full" | "analyze" | "pipeline"
  >("pipeline");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [materials, setMaterials] = useState<ScreenResult["materials"] | null>(
    null,
  );
  const [combinedText, setCombinedText] = useState<string>("");
  const [textViewerOpen, setTextViewerOpen] = useState(false);
  const [textSearch, setTextSearch] = useState("");
  const [textSearchIdx, setTextSearchIdx] = useState(0);
  const [summaryViewer, setSummaryViewer] = useState<{
    title: string;
    text: string;
    exec?: Record<string, unknown> | null;
    sentiment?: string | null;
    score?: number | null;
    nseSymbol?: string | null;
  } | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [showUnified, setShowUnified] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [textRowBusy, setTextRowBusy] = useState<number | null>(null);

  const findLatest = useCallback(async () => {
    const ticker = tickerInput.trim().toUpperCase();
    if (!ticker) {
      setError("Enter an NSE ticker (e.g. KAMDHENU)");
      return;
    }
    setDiscovering(true);
    setError(null);
    setDiscoverHits([]);
    setStatus(`Finding latest Transcript + PPT for ${ticker}…`);
    try {
      const res = await fetch(
        `/api/concall-screen?discover=1&ticker=${encodeURIComponent(ticker)}`,
        { signal: AbortSignal.timeout(90_000) },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        note?: string;
        latest_transcript?: {
          url?: string;
          title?: string;
          period?: string | null;
        } | null;
        latest_ppt?: {
          url?: string;
          title?: string;
          period?: string | null;
        } | null;
        sources?: Array<{
          id: string;
          kind: string;
          title: string;
          period: string | null;
          url: string;
          provider: string;
          score: number;
          extractable: boolean;
        }>;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "Discover failed");
      }
      const hits = Array.isArray(json.sources) ? json.sources : [];
      setDiscoverHits(hits);
      setResult(null);
      const txUrl = json.latest_transcript?.url?.trim() || "";
      const pptUrl = json.latest_ppt?.url?.trim() || "";
      if (txUrl) {
        setUrlTranscript(txUrl);
        setFileTranscript(null);
        if (txFileRef.current) txFileRef.current.value = "";
      }
      if (pptUrl) {
        setUrlPpt(pptUrl);
        setFilePpt(null);
        if (pptFileRef.current) pptFileRef.current.value = "";
      }
      if (!txUrl && !pptUrl) {
        setStatus(
          hits.length
            ? `Found ${hits.length} source(s) for ${ticker} — pick Transcript / PPT below`
            : null,
        );
        setError(
          hits.length
            ? null
            : json.note ||
                `No Transcript/PPT PDF found for ${ticker}. Paste BSE URLs manually.`,
        );
      } else {
        const bits = [
          txUrl ? "Transcript" : null,
          pptUrl ? "PPT" : null,
        ].filter(Boolean);
        setStatus(
          `Found ${bits.join(" + ")} for ${ticker}` +
            (json.latest_transcript?.period
              ? ` · ${json.latest_transcript.period}`
              : json.latest_ppt?.period
                ? ` · ${json.latest_ppt.period}`
                : "") +
            (hits.length > 2 ? ` · ${hits.length} sources listed` : ""),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Discover failed");
      setStatus(null);
      setDiscoverHits([]);
    } finally {
      setDiscovering(false);
    }
  }, [tickerInput]);

  const applyDiscoverHit = useCallback(
    (hit: { url: string; title?: string }, role: "transcript" | "ppt") => {
      const u = hit.url?.trim();
      if (!u) return;
      setError(null);
      if (role === "transcript") {
        setUrlTranscript(u);
        setFileTranscript(null);
        if (txFileRef.current) txFileRef.current.value = "";
      } else {
        setUrlPpt(u);
        setFilePpt(null);
        if (pptFileRef.current) pptFileRef.current.value = "";
      }
      setStatus(`Set ${role === "transcript" ? "Transcript" : "PPT"} · ${hit.title || u}`);
    },
    [],
  );

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/concall-screen?limit=40", {
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        history?: HistoryRow[];
      };
      if (res.ok && json.history) {
        setHistory(json.history);
        setSelectedIds(new Set());
      }
    } catch {
      /* ignore */
    }
  }, []);

  const refreshRows = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    setStatus("Refreshing list — company, call date, highlights, LTP…");
    try {
      const res = await fetch("/api/concall-screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh", limit: 40 }),
        signal: AbortSignal.timeout(120_000),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        updated?: number;
        pdf_reparsed?: number;
        history?: HistoryRow[];
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "Refresh failed");
      }
      if (json.history) {
        setHistory(json.history);
        setSelectedIds(new Set());
      }
      setStatus(
        `Refreshed ${json.updated ?? 0} row(s)` +
          (json.pdf_reparsed
            ? ` · re-read ${json.pdf_reparsed} PDF(s)`
            : " · no LLM"),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
      setStatus(null);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const deleteSelected = useCallback(async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const label =
      ids.length === 1
        ? "this row"
        : `${ids.length} selected rows`;
    if (!window.confirm(`Delete ${label} from the PASS list?`)) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/concall-screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", ids, limit: 40 }),
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        deleted?: number;
        history?: HistoryRow[];
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "Delete failed");
      }
      if (json.history) setHistory(json.history);
      setSelectedIds(new Set());
      setStatus(`Deleted ${json.deleted ?? ids.length} row(s)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }, [selectedIds]);

  const allSelected =
    history.length > 0 && history.every((h) => selectedIds.has(h.id));
  const someSelected = selectedIds.size > 0;

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(history.map((h) => h.id)));
  }, [allSelected, history]);

  const toggleSelectOne = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!fileTranscript) {
      setTxPreviewUrl(null);
      return;
    }
    const u = URL.createObjectURL(fileTranscript);
    setTxPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [fileTranscript]);

  useEffect(() => {
    if (!filePpt) {
      setPptPreviewUrl(null);
      return;
    }
    const u = URL.createObjectURL(filePpt);
    setPptPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [filePpt]);

  useEffect(() => {
    if ((!busy && !textBusy) || startedAt == null) return;
    const tick = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => window.clearInterval(tick);
  }, [busy, textBusy, startedAt]);

  useEffect(() => {
    if (!busy) return;
    // Soft hints only for legacy full PDF path
    if (progressMode !== "full") return;
    const timers = [
      window.setTimeout(() => setProgressStep(1), 400),
      window.setTimeout(() => setProgressStep(2), 12_000),
      window.setTimeout(() => setProgressStep(3), 90_000),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [busy, progressMode]);

  const proxyPdf = useCallback((url: string | null | undefined) => {
    const u = url?.trim();
    if (!u) return null;
    return `/api/concall-screen?pdf=${encodeURIComponent(u)}`;
  }, []);

  const txPdfSrc = useMemo(() => {
    if (txPreviewUrl) return txPreviewUrl;
    if (materials?.transcript?.source_url)
      return proxyPdf(materials.transcript.source_url);
    return proxyPdf(urlTranscript);
  }, [txPreviewUrl, materials, urlTranscript, proxyPdf]);

  const pptPdfSrc = useMemo(() => {
    if (pptPreviewUrl) return pptPreviewUrl;
    if (materials?.ppt?.source_url) return proxyPdf(materials.ppt.source_url);
    return proxyPdf(urlPpt);
  }, [pptPreviewUrl, materials, urlPpt, proxyPdf]);

  const buildForm = useCallback(() => {
    const form = new FormData();
    const txUrl = urlTranscript.trim();
    const pptUrl = urlPpt.trim();
    if (txUrl) form.set("url_transcript", txUrl);
    if (pptUrl) form.set("url_ppt", pptUrl);
    if (fileTranscript) {
      form.append("file_transcript", fileTranscript, fileTranscript.name);
    }
    if (filePpt) {
      form.append("file_ppt", filePpt, filePpt.name);
    }
    return form;
  }, [urlTranscript, urlPpt, fileTranscript, filePpt]);

  const hasAnyInput = Boolean(
    urlTranscript.trim() || urlPpt.trim() || fileTranscript || filePpt,
  );

  /** PDF → combined text. Returns text or throws. Does not toggle busy (caller owns it). */
  const extractTextCore = useCallback(async (): Promise<string> => {
    if (!hasAnyInput) {
      throw new Error("Add a Transcript and/or PPT (URL or upload)");
    }
    setTextBusy(true);
    setOcrProgress({ message: "Starting extract…", pct: 0 });
    setStatus("1/3 · Extracting text…");
    try {
      const form = buildForm();
      form.set("mode", "extract_text");
      form.set("stream", "1");
      const res = await fetch("/api/concall-screen", {
        method: "POST",
        body: form,
        headers: { Accept: "application/x-ndjson" },
        signal: AbortSignal.timeout(900_000),
      });
      if (!res.ok || !res.body) {
        const errJson = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(errJson?.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let final: ScreenResult & { error?: string } | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(t) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (ev.type === "progress") {
            setOcrProgress({
              message: String(ev.message || "Working…"),
              pct: typeof ev.pct === "number" ? ev.pct : 0,
              page: typeof ev.page === "number" ? ev.page : undefined,
              pages: typeof ev.pages === "number" ? ev.pages : undefined,
              role: typeof ev.role === "string" ? ev.role : undefined,
            });
            setStatus(`1/3 · ${String(ev.message || "Extracting text…")}`);
          } else if (ev.type === "result") {
            final = ev as ScreenResult & { error?: string };
          } else if (ev.type === "error") {
            throw new Error(String(ev.error || "Text extract failed"));
          }
        }
      }
      if (!final) throw new Error("No result from text extract stream");
      const text = (final.combined_text || "").trim();
      setMaterials(final.materials || null);
      setCombinedText(text);
      setOcrProgress({ message: "Text ready", pct: 100 });
      if (!final.ok || text.length < 80) {
        throw new Error(
          final.error || "Not enough text extracted (≥80 chars needed)",
        );
      }
      return text;
    } finally {
      setTextBusy(false);
    }
  }, [hasAnyInput, buildForm]);

  const runFromCombined = useCallback(
    async (opts?: {
      id?: number;
      text?: string;
      /** Already inside pipeline — don't reset busy/progress mode */
      continuePipeline?: boolean;
    }) => {
      const text = (opts?.text ?? combinedText).trim();
      const id = opts?.id;
      if ((!id || id <= 0) && text.length < 80) {
        setError("Need combined text — upload PDFs and click Run, or Docs → Text");
        return;
      }
      const nested = Boolean(opts?.continuePipeline);
      if (!nested) {
        setBusy(true);
        setError(null);
        setShowJson(false);
        setResult(null);
        setProgressMode("analyze");
        setProgressStep(0);
        setStartedAt(Date.now());
        setElapsedMs(0);
      }
      setStatus(
        id
          ? `Analyze · summary + highlights (row ${id})…`
          : nested
            ? "2/3 · Analyze (summary + highlights)…"
            : "Analyze · summary + highlights…",
      );
      try {
        if (nested) setProgressStep(1);
        const res = await fetch("/api/concall-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "from_combined",
            id: id ?? undefined,
            // Row Analyze: never send shared textarea (may be another company's text).
            // Server loads docs.combined for that id. Pipeline/top Run still sends text.
            combined_text: id ? undefined : text || undefined,
            limit: 40,
          }),
          signal: AbortSignal.timeout(480_000),
        });
        if (nested) {
          setProgressStep(2);
          setStatus("3/3 · Prices + save PASS list…");
        } else {
          setProgressStep(1);
          setStatus("Prices + save PASS list…");
        }
        const json = (await res.json()) as ScreenResult & {
          error?: string;
          history?: HistoryRow[];
        };
        setProgressStep(
          nested ? PIPELINE_STEPS.length : ANALYZE_STEPS.length,
        );
        if (!res.ok && !json.extract && !json.extract_json) {
          throw new Error(json.error || `HTTP ${res.status}`);
        }
        setResult(json);
        if (json.combined_text) {
          setCombinedText(json.combined_text);
        }
        if (json.materials) setMaterials(json.materials);
        if (!json.ok && json.error) setError(json.error);
        if (json.history) {
          setHistory(json.history);
          setSelectedIds(new Set());
        } else {
          await loadHistory();
        }
        setStatus(
          json.ok
            ? `Done · ${json.engine || "from-combined"} · ${(json.text_chars ?? text.length).toLocaleString()} chars`
            : json.error || "Analyze failed",
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Analyze failed";
        const name = e instanceof Error ? e.name : "";
        if (
          name === "TimeoutError" ||
          name === "AbortError" ||
          /timed out|aborted/i.test(msg)
        ) {
          setError("Timed out — Ollama may be busy; retry Run");
        } else {
          setError(msg);
        }
        setStatus(null);
      } finally {
        if (!nested) {
          setBusy(false);
          setTextRowBusy(null);
          setStartedAt(null);
        }
      }
    },
    [combinedText, loadHistory],
  );

  /** One button: Extract text → Analyze → save */
  const runPipeline = useCallback(async () => {
    const existing = combinedText.trim();
    if (!hasAnyInput && existing.length < 80) {
      setError("Add Transcript/PPT, or load Docs → Text first");
      return;
    }
    setBusy(true);
    setError(null);
    setShowJson(false);
    // Drop prior Analyze panel so a failed/timed-out Run can't show another issuer
    setResult(null);
    setProgressMode("pipeline");
    setProgressStep(0);
    setStartedAt(Date.now());
    setElapsedMs(0);
    setOcrProgress(null);
    try {
      let text = existing;
      if (hasAnyInput) {
        text = await extractTextCore();
      } else {
        setStatus("1/3 · Using loaded combined text…");
      }
      setProgressStep(1);
      await runFromCombined({ text, continuePipeline: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Run failed";
      const name = e instanceof Error ? e.name : "";
      if (
        name === "TimeoutError" ||
        name === "AbortError" ||
        /timed out|aborted/i.test(msg)
      ) {
        setError("Timed out during extract/analyze — retry Run");
        setResult(null);
      } else {
        setError(msg);
      }
      setStatus(null);
    } finally {
      setBusy(false);
      setTextBusy(false);
      setTextRowBusy(null);
      setStartedAt(null);
    }
  }, [hasAnyInput, combinedText, extractTextCore, runFromCombined]);

  const loadSavedCombined = useCallback(async (id: number) => {
    setTextRowBusy(id);
    setError(null);
    setStatus(`Loading text…`);
    try {
      const res = await fetch("/api/concall-screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_combined", id }),
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        combined_text?: string;
        error?: string;
      };
      if (!res.ok || !json.ok || !(json.combined_text || "").trim()) {
        throw new Error(
          json.error ||
            "No combined text saved on this row — click Run once first",
        );
      }
      const text = json.combined_text || "";
      setCombinedText(text);
      setTextSearch("");
      setTextSearchIdx(0);
      setTextViewerOpen(true);
      setShowText(false);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load text failed");
      setStatus(null);
    } finally {
      setTextRowBusy(null);
    }
  }, []);

  const openSummary = useCallback(async (id: number) => {
    setError(null);
    try {
      const res = await fetch("/api/concall-screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_combined", id }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        docs?: { summary?: string | null };
        extract?: {
          docs?: { summary?: string | null };
          quant?: {
            executive_summary?: Record<string, unknown>;
            highlight_sentiment?: Record<string, unknown>;
          };
          card?: {
            mgmt_sentiment?: string | null;
            sentiment_label?: string | null;
            sentiment_score?: number | null;
          };
          metadata?: { nse_symbol?: string | null; company?: string | null };
        };
        error?: string;
      };
      const exec = json.extract?.quant?.executive_summary || null;
      const hl = json.extract?.quant?.highlight_sentiment || null;
      const hlMeta =
        hl && typeof hl === "object"
          ? (hl as { metadata?: Record<string, unknown>; sentiment_summary?: Record<string, unknown> })
          : null;
      const card = json.extract?.card;
      const saved =
        json.extract?.docs?.summary?.trim() ||
        json.docs?.summary?.trim() ||
        "";
      const text =
        saved ||
        (exec ? formatExecutiveSummaryText(exec) : "") ||
        "";
      if (!text && !exec) {
        throw new Error("No summary yet — click Analyze first");
      }
      const company =
        (typeof exec?.metadata === "object" &&
        exec?.metadata &&
        typeof (exec.metadata as { company?: string }).company === "string"
          ? (exec.metadata as { company: string }).company
          : null) ||
        json.extract?.metadata?.company ||
        `row ${id}`;
      const scoreRaw =
        (typeof hlMeta?.metadata?.overall_score === "number"
          ? hlMeta.metadata.overall_score
          : null) ??
        (typeof hlMeta?.sentiment_summary?.portfolio_score === "number"
          ? hlMeta.sentiment_summary.portfolio_score
          : null) ??
        card?.sentiment_score ??
        null;
      setSummaryViewer({
        title: `Summary · ${company}`,
        text: text || "Executive summary",
        exec,
        sentiment:
          (typeof hlMeta?.metadata?.overall_sentiment === "string"
            ? hlMeta.metadata.overall_sentiment
            : null) ||
          card?.sentiment_label ||
          card?.mgmt_sentiment ||
          null,
        score: scoreRaw,
        nseSymbol: json.extract?.metadata?.nse_symbol || null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Open summary failed");
    }
  }, []);

  const textSearchHits = useMemo(() => {
    const q = textSearch.trim();
    if (!q || !combinedText) return [] as number[];
    const hits: number[] = [];
    const lower = combinedText.toLowerCase();
    const needle = q.toLowerCase();
    let from = 0;
    while (from < lower.length) {
      const i = lower.indexOf(needle, from);
      if (i < 0) break;
      hits.push(i);
      from = i + Math.max(1, needle.length);
      if (hits.length > 500) break;
    }
    return hits;
  }, [combinedText, textSearch]);

  useEffect(() => {
    setTextSearchIdx(0);
  }, [textSearch, combinedText]);

  useEffect(() => {
    if (!textViewerOpen || !textSearchHits.length) return;
    const el = document.getElementById(
      `concall-hit-${textSearchHits[textSearchIdx] ?? 0}`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [textViewerOpen, textSearchHits, textSearchIdx]);

  const ex = result?.extract || result?.extract_json || null;
  const meta = (asObj(ex?.metadata) || {}) as Meta;
  const tone = (asObj(ex?.management_tone) || {}) as Tone;
  const card = (asObj(ex?.card) || {}) as Card;
  const fin = asObj(ex?.reported_financials) || {};
  const finKeys = Object.keys(fin);
  const finLines = finKeys
    .map((k) => {
      const row = asObj(fin[k]);
      if (!row) return null;
      const cur = row.current_qtr;
      const yoy = row.pct_change ?? row.yoy_pct;
      const unit = String(row.unit || "").replace(/^INR\s*/i, "");
      const curS =
        typeof cur === "number" && Number.isFinite(cur)
          ? `${cur}${unit ? ` ${unit}` : ""}`
          : null;
      const yoyS =
        typeof yoy === "number" && Number.isFinite(yoy)
          ? `${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}% YoY`
          : null;
      if (!curS && !yoyS) return null;
      const label = k.replace(/_/g, " ");
      return [label, [curS, yoyS].filter(Boolean).join(" · ")].join(": ");
    })
    .filter(Boolean) as string[];
  const unified = asObj(ex?.unified_earnings);
  const investor = asObj(unified?.investor_analysis);
  const hasTxPdf = Boolean(txPdfSrc);
  const hasPptPdf = Boolean(pptPdfSrc);
  const hasAnyPdf = hasTxPdf || hasPptPdf;
  const briefCard = Boolean(
    card.brief ||
      (Array.isArray(card.highlights) && card.highlights.length) ||
      card.strengths?.length ||
      card.kpi_cards?.length,
  );

  return (
    <section className="panel scan-panel buyback-research-panel buyback-research-panel--split">
      <p className="panel-lead">
        <strong>Research · Concall.</strong> Enter a{" "}
        <strong>ticker</strong> → <strong>Find latest</strong>, then{" "}
        <strong>Run</strong> (extract text + analyze → PASS card).
      </p>

      <div className="concall-dual-row" style={{ marginBottom: 10 }}>
        <label className="concall-dual-label">Ticker</label>
        <TickerSuggest
          value={tickerInput}
          onChange={setTickerInput}
          onSubmit={() => void findLatest()}
          disabled={busy || textBusy || discovering}
          placeholder="NSE ticker e.g. KAMDHENU…"
        />
        <button
          type="button"
          className={`chip tag-chip ${discovering ? "busy on" : ""}`}
          disabled={busy || textBusy || discovering || !tickerInput.trim()}
          onClick={() => void findLatest()}
          title="Discover latest Transcript + PPT on BSE/NSE/Screener"
        >
          {discovering ? "Finding…" : "Find latest"}
        </button>
      </div>

      <div className="concall-dual-inputs">
        <div className="concall-dual-row">
          <label className="concall-dual-label">Transcript</label>
          <input
            type="url"
            className="buyback-url-input"
            placeholder="Transcript PDF URL (BSE/NSE call)…"
            value={urlTranscript}
            disabled={busy || textBusy}
            onChange={(e) => {
              setUrlTranscript(e.target.value);
              setResult(null);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runPipeline();
              }
            }}
          />
          <input
            ref={txFileRef}
            type="file"
            accept="application/pdf,.pdf"
            className="buyback-file-hidden"
            disabled={busy || textBusy}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFileTranscript(f);
              if (f) {
                setError(null);
                setResult(null);
              }
            }}
          />
          <button
            type="button"
            className="buyback-upload-btn"
            disabled={busy || textBusy}
            onClick={() => txFileRef.current?.click()}
          >
            Upload
          </button>
          {fileTranscript ? (
            <span className="buyback-file-name" title={fileTranscript.name}>
              {fileTranscript.name}
            </span>
          ) : null}
        </div>
        <div className="concall-dual-row">
          <label className="concall-dual-label">PPT</label>
          <input
            type="url"
            className="buyback-url-input"
            placeholder="Earnings / investor presentation PDF URL…"
            value={urlPpt}
            disabled={busy || textBusy}
            onChange={(e) => {
              setUrlPpt(e.target.value);
              setResult(null);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runPipeline();
              }
            }}
          />
          <input
            ref={pptFileRef}
            type="file"
            accept="application/pdf,.pdf"
            className="buyback-file-hidden"
            disabled={busy || textBusy}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFilePpt(f);
              if (f) {
                setError(null);
                setResult(null);
              }
            }}
          />
          <button
            type="button"
            className="buyback-upload-btn"
            disabled={busy || textBusy}
            onClick={() => pptFileRef.current?.click()}
          >
            Upload
          </button>
          {filePpt ? (
            <span className="buyback-file-name" title={filePpt.name}>
              {filePpt.name}
            </span>
          ) : null}
        </div>
      </div>

      {discoverHits.length > 0 ? (
        <div className="concall-discover-list" role="list">
          <div className="concall-discover-list-head">
            Discovered sources ({discoverHits.length}) — click to fill fields
          </div>
          <ul className="concall-discover-ul">
            {discoverHits.map((h) => {
              const kindLabel =
                /transcript/i.test(`${h.kind} ${h.title}`)
                  ? "TX"
                  : /ppt|presentation|deck/i.test(`${h.kind} ${h.title}`)
                    ? "PPT"
                    : h.kind === "concall"
                      ? "Call"
                      : "PDF";
              return (
                <li key={h.id || h.url} className="concall-discover-item">
                  <span
                    className={`concall-discover-kind concall-discover-kind--${kindLabel.toLowerCase()}`}
                  >
                    {kindLabel}
                  </span>
                  <div className="concall-discover-meta">
                    <div className="concall-discover-title" title={h.title}>
                      {h.title || h.url}
                    </div>
                    <div className="concall-discover-sub">
                      {[h.period, h.provider, h.extractable ? null : "not PDF"]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <div className="concall-discover-actions">
                    <button
                      type="button"
                      className="link-btn"
                      disabled={!h.url || busy || textBusy}
                      onClick={() => applyDiscoverHit(h, "transcript")}
                      title="Use as Transcript URL"
                    >
                      → TX
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={!h.url || busy || textBusy}
                      onClick={() => applyDiscoverHit(h, "ppt")}
                      title="Use as PPT URL"
                    >
                      → PPT
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="buyback-input-row">
        <button
          type="button"
          className={`chip chip-scan tag-chip ${busy || textBusy ? "busy on" : ""}`}
          disabled={
            busy ||
            textBusy ||
            refreshing ||
            (!hasAnyInput && combinedText.trim().length < 80)
          }
          onClick={() => void runPipeline()}
          title="Extract text from PDFs, then LLM analyze → PASS list"
        >
          {busy || textBusy ? "Running…" : "Run"}
        </button>
        {hasAnyInput || combinedText.trim().length >= 80 || discoverHits.length ? (
          <button
            type="button"
            className="link-btn"
            disabled={busy || textBusy}
            onClick={() => {
              setFileTranscript(null);
              setFilePpt(null);
              setUrlTranscript("");
              setUrlPpt("");
              setTickerInput("");
              setMaterials(null);
              setCombinedText("");
              setResult(null);
              setDiscoverHits([]);
              if (txFileRef.current) txFileRef.current.value = "";
              if (pptFileRef.current) pptFileRef.current.value = "";
            }}
          >
            Clear
          </button>
        ) : null}
      </div>

      {status && !busy && !textBusy ? (
        <p className="buyback-status" role="status">
          {status}
        </p>
      ) : null}
      {error ? <p className="buyback-error">{error}</p> : null}

      <div className="buyback-split">
        <div className="buyback-split-pdf concall-dual-pdfs">
          <div className="concall-pdf-pane">
            <div className="buyback-split-label">Transcript PDF</div>
            {txPdfSrc ? (
              <iframe
                title="Transcript PDF"
                className="buyback-pdf-frame"
                src={txPdfSrc}
              />
            ) : (
              <div className="buyback-pdf-empty">Upload / paste transcript</div>
            )}
          </div>
          <div className="concall-pdf-pane">
            <div className="buyback-split-label">PPT PDF</div>
            {pptPdfSrc ? (
              <iframe
                title="PPT PDF"
                className="buyback-pdf-frame"
                src={pptPdfSrc}
              />
            ) : (
              <div className="buyback-pdf-empty">Upload / paste PPT</div>
            )}
          </div>
        </div>

        <div className="buyback-split-out">
          <div className="buyback-split-label">
            Analysis
            {busy || textBusy ? (
              <span className="buyback-progress-elapsed">
                {fmtElapsed(elapsedMs)}
              </span>
            ) : null}
          </div>

          {showText && combinedText.trim() ? (
            <div className="concall-dual-texts">
              <div className="concall-text-block concall-text-block--combined">
                <div className="buyback-split-label">
                  Combined text · {combinedText.length.toLocaleString()} chars
                  <button
                    type="button"
                    className="buyback-text-toggle"
                    style={{ marginLeft: 8 }}
                    onClick={() => {
                      void navigator.clipboard?.writeText(combinedText);
                    }}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className="buyback-text-toggle"
                    style={{ marginLeft: 6 }}
                    onClick={() => {
                      setTextSearch("");
                      setTextSearchIdx(0);
                      setTextViewerOpen(true);
                    }}
                  >
                    Expand
                  </button>
                  <button
                    type="button"
                    className="buyback-text-toggle"
                    style={{ marginLeft: 6 }}
                    onClick={() => setShowText(false)}
                  >
                    Hide
                  </button>
                </div>
                <pre className="buyback-text-pre concall-text-pre concall-text-pre--combined">
                  {combinedText.trim()}
                </pre>
              </div>
              {materials?.transcript && !combinedText.includes("===== TRANSCRIPT =====") ? (
                <div className="concall-text-block">
                  <div className="buyback-split-label">
                    Transcript text
                    {materials.transcript.text_chars != null
                      ? ` · ${materials.transcript.text_chars.toLocaleString()} chars`
                      : ""}
                  </div>
                  <pre className="buyback-text-pre concall-text-pre">
                    {materials.transcript.ok
                      ? materials.transcript.text?.trim() || "(empty)"
                      : materials.transcript.error || "(failed)"}
                  </pre>
                </div>
              ) : null}
              {materials?.ppt && !combinedText.includes("===== PPT") ? (
                <div className="concall-text-block">
                  <div className="buyback-split-label">
                    PPT text
                    {materials.ppt.text_chars != null
                      ? ` · ${materials.ppt.text_chars.toLocaleString()} chars`
                      : ""}
                  </div>
                  <pre className="buyback-text-pre concall-text-pre">
                    {materials.ppt.ok
                      ? materials.ppt.text?.trim() || "(empty)"
                      : materials.ppt.error || "(failed)"}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : materials && showText ? (
            <div className="concall-dual-texts">
              {(materials.transcript?.ok || materials.ppt?.ok) && (
                <div className="concall-text-block concall-text-block--combined">
                  <div className="buyback-split-label">
                    Combined text
                    <button
                      type="button"
                      className="buyback-text-toggle"
                      style={{ marginLeft: 8 }}
                      onClick={() => {
                        const t = [
                          materials.transcript?.ok
                            ? `===== TRANSCRIPT =====\n${materials.transcript.text?.trim() || ""}`
                            : "",
                          materials.ppt?.ok
                            ? `===== PPT / PRESENTATION =====\n${materials.ppt.text?.trim() || ""}`
                            : "",
                        ]
                          .filter(Boolean)
                          .join("\n\n");
                        void navigator.clipboard?.writeText(t);
                      }}
                    >
                      Copy
                    </button>
                  </div>
                  <pre className="buyback-text-pre concall-text-pre concall-text-pre--combined">
                    {[
                      materials.transcript?.ok
                        ? `===== TRANSCRIPT =====\n${materials.transcript.text?.trim() || ""}`
                        : "",
                      materials.ppt?.ok
                        ? `===== PPT / PRESENTATION =====\n${materials.ppt.text?.trim() || ""}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join("\n\n") || "(empty)"}
                  </pre>
                </div>
              )}
            </div>
          ) : null}

          {textBusy ? (
            <div className="buyback-progress" role="status" aria-live="polite">
              <p className="buyback-progress-title">
                {ocrProgress?.message || status || "Extracting text…"}
              </p>
              <div className="concall-ocr-bar" aria-hidden>
                <div
                  className="concall-ocr-bar-fill"
                  style={{
                    width: `${Math.min(100, Math.max(0, ocrProgress?.pct ?? 0))}%`,
                  }}
                />
              </div>
              <p className="buyback-progress-hint">
                {ocrProgress?.role
                  ? `${ocrProgress.role}`
                  : "transcript / PPT"}
                {ocrProgress?.page != null && ocrProgress?.pages != null
                  ? ` · page ${ocrProgress.page} / ${ocrProgress.pages}`
                  : ""}
                {ocrProgress?.pct != null ? ` · ${ocrProgress.pct}%` : ""}
                {" · "}
                {fmtElapsed(elapsedMs)}
              </p>
            </div>
          ) : null}

          {busy ? (
            <div className="buyback-progress" role="status" aria-live="polite">
              <p className="buyback-progress-title">
                {status || "Working…"}
              </p>
              <ul className="buyback-progress-steps">
                {(progressMode === "pipeline"
                  ? PIPELINE_STEPS
                  : progressMode === "analyze"
                    ? ANALYZE_STEPS
                    : PROGRESS_STEPS
                ).map((step, i) => {
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
                {progressMode === "pipeline"
                  ? `Extract → Analyze → save · ${fmtElapsed(elapsedMs)}`
                  : progressMode === "analyze"
                    ? `Analyze only · ${fmtElapsed(elapsedMs)}`
                    : "Full PDF path can take several minutes if PPT OCR runs."}
              </p>
            </div>
          ) : !result ? (
            <div className="buyback-pdf-empty">
              Add PDFs, then click <strong>Run</strong>
            </div>
          ) : (
            <>
              <div className={decisionClass(result.decision)}>
                {result.why || "Concall extract"}
              </div>
              {result.save_gaps && result.save_gaps.length > 0 ? (
                <ul className="buyback-history-empty" style={{ marginTop: 8 }}>
                  {result.save_gaps.map((g) => (
                    <li key={g.field}>
                      <strong>{g.field}</strong> — {g.reason}
                    </li>
                  ))}
                </ul>
              ) : null}

              <table className="buyback-out-table">
                <tbody>
                  <tr>
                    <th scope="row">Document</th>
                    <td>
                      {String(meta.document_type || "—")}
                      {meta.document_note ? (
                        <span className="buyback-pass-co">
                          {" "}
                          · {String(meta.document_note)}
                        </span>
                      ) : null}
                    </td>
                  </tr>
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
                    <th scope="row">Industry / Sector</th>
                    <td>
                      {[card.sector, card.industry].filter(Boolean).join(" · ") ||
                        "—"}
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
                    <th scope="row">Result quality</th>
                    <td>
                      <QualityTag q={card.result_quality} />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Tone</th>
                    <td>
                      <SentimentTag
                        s={
                          card.mgmt_sentiment ||
                          (typeof tone.overall_tone === "string"
                            ? tone.overall_tone
                            : null)
                        }
                      />
                      {tone.net_sentiment_score != null
                        ? ` · score ${fmtScore(tone.net_sentiment_score)}`
                        : ""}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Highlights</th>
                    <td>
                      <HighlightList items={card.highlights} />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Financials</th>
                    <td>
                      {finLines.length ? (
                        <ul className="concall-fin-lines">
                          {finLines.map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      ) : (
                        "—"
                      )}
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

              <ResultBrief card={card} />

              {tone.justification && !card.quote ? (
                <p className="buyback-subject">{tone.justification}</p>
              ) : null}

              {investor ? (
                <div className="concall-unified-summary">
                  {typeof investor.bull_case === "string" ? (
                    <p className="buyback-subject">
                      <strong>Bull:</strong> {investor.bull_case}
                    </p>
                  ) : null}
                  {typeof investor.bear_case === "string" ? (
                    <p className="buyback-subject">
                      <strong>Bear:</strong> {investor.bear_case}
                    </p>
                  ) : null}
                  {typeof investor.next_catalyst === "string" ? (
                    <p className="buyback-subject">
                      <strong>Next:</strong> {investor.next_catalyst}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="buyback-text-toggles">
                <button
                  type="button"
                  className="buyback-text-toggle"
                  onClick={() => setShowJson((v) => !v)}
                >
                  {showJson ? "Hide" : "Show"} JSON
                </button>
                {unified ? (
                  <button
                    type="button"
                    className="buyback-text-toggle"
                    onClick={() => setShowUnified((v) => !v)}
                  >
                    {showUnified ? "Hide" : "Show"} unified
                  </button>
                ) : null}
                <button
                  type="button"
                  className="buyback-text-toggle"
                  onClick={() => setShowText((v) => !v)}
                >
                  {showText ? "Hide" : "Show"} PDF text
                  {materials
                    ? ` (${(
                        (materials.transcript?.text_chars || 0) +
                        (materials.ppt?.text_chars || 0)
                      ).toLocaleString()} chars)`
                    : result.text_chars != null
                      ? ` (${result.text_chars.toLocaleString()} chars)`
                      : ""}
                </button>
              </div>
              {showUnified && unified ? (
                <pre className="buyback-text-pre buyback-json-pre">
                  {JSON.stringify(unified, null, 2)}
                </pre>
              ) : null}
              {showJson ? (
                <pre className="buyback-text-pre buyback-json-pre">
                  {JSON.stringify(
                    result.extract_json || result.extract || {},
                    null,
                    2,
                  )}
                </pre>
              ) : null}
              {showText && !materials ? (
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
          Concall list (PASS)
          <span className="buyback-history-count">{history.length}</span>
          <button
            type="button"
            className="chip tag-chip"
            style={{ marginLeft: 10, fontSize: "0.75rem" }}
            disabled={busy || refreshing || deleting || history.length === 0}
            onClick={() => void refreshRows()}
            title="Fill missing company / call date / highlights / LTP without LLM re-extract"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="chip tag-chip"
            style={{ marginLeft: 6, fontSize: "0.75rem" }}
            disabled={
              busy || refreshing || deleting || !someSelected
            }
            onClick={() => void deleteSelected()}
            title="Delete selected PASS rows"
          >
            {deleting
              ? "Deleting…"
              : someSelected
                ? `Delete (${selectedIds.size})`
                : "Delete"}
          </button>
        </h3>
        <p className="buyback-history-empty" style={{ marginBottom: 8 }}>
          PASS only · Docs: Summary · Text · Analyze (quant HL → Highlights /
          Result quality / Tone).
        </p>
        {history.length === 0 ? (
          <p className="buyback-history-empty">
            No PASS rows yet — Find latest, then Run.
          </p>
        ) : (
          <div className="buyback-pass-table-wrap">
            <table className="buyback-pass-table concall-pass-table">
              <thead>
                <tr>
                  <th className="concall-select-col" scope="col">
                    <input
                      type="checkbox"
                      className="concall-row-check"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) {
                          el.indeterminate = someSelected && !allSelected;
                        }
                      }}
                      onChange={toggleSelectAll}
                      aria-label="Select all rows"
                      disabled={deleting || history.length === 0}
                    />
                  </th>
                  <th>Company</th>
                  <th>Call</th>
                  <th>Period</th>
                  <th>Highlights</th>
                  <th>Result quality</th>
                  <th>Tone</th>
                  <th>Revenue ₹ Cr</th>
                  <th className="num">LTP</th>
                  <th
                    className="num"
                    title="LTP vs last close before call date"
                  >
                    Δ call
                  </th>
                  <th>Docs</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr
                    key={h.id}
                    className={
                      selectedIds.has(h.id)
                        ? "buyback-pass-row concall-row-selected"
                        : "buyback-pass-row"
                    }
                  >
                    <td className="concall-select-col">
                      <input
                        type="checkbox"
                        className="concall-row-check"
                        checked={selectedIds.has(h.id)}
                        onChange={() => toggleSelectOne(h.id)}
                        aria-label={`Select ${h.company || h.ticker || h.id}`}
                        disabled={deleting}
                      />
                    </td>
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
                      {[h.sector, h.industry].filter(Boolean).length ? (
                        <span
                          className="buyback-pass-co buyback-pass-co--sector"
                          title={[h.sector, h.industry].filter(Boolean).join(" · ")}
                        >
                          {[h.sector, h.industry].filter(Boolean).join(" · ")}
                        </span>
                      ) : null}
                    </td>
                    <td>{fmtCallDate(h.call_date)}</td>
                    <td>{h.period || "—"}</td>
                    <td className="concall-hl-cell">
                      <HighlightList items={h.highlights} />
                    </td>
                    <td>
                      <QualityTag q={h.result_quality} />
                    </td>
                    <td>
                      <SentimentTag s={h.mgmt_sentiment || h.sentiment} />
                    </td>
                    <td>
                      {h.revenue_cr != null
                        ? fmtCr(h.revenue_cr)
                        : h.revenue_yoy_pct != null
                          ? fmtPct(h.revenue_yoy_pct)
                          : "—"}
                    </td>
                    <td className="num">{fmtLtp(h.ltp)}</td>
                    <td className="num">
                      <DriftTag pct={h.drift_pct} />
                    </td>
                    <td className="concall-docs-cell">
                      <DocsColumn
                        docs={h.docs}
                        fallbackUrl={h.source_url}
                        rowId={h.id}
                        busyId={textRowBusy}
                        onLoadText={(id) => void loadSavedCombined(id)}
                        onOpenSummary={(id) => void openSummary(id)}
                        onRunText={(id) => {
                          setTextRowBusy(id);
                          void runFromCombined({ id });
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {textViewerOpen && combinedText.trim() ? (
        <div
          className="concall-text-viewer"
          role="dialog"
          aria-modal="true"
          aria-label="Combined text"
        >
          <div className="concall-text-viewer-panel">
            <div className="concall-text-viewer-toolbar">
              <div className="concall-text-viewer-title">
                Text · {combinedText.length.toLocaleString()} chars
              </div>
              <input
                type="search"
                className="concall-text-search"
                placeholder="Search in text…"
                value={textSearch}
                autoFocus
                onChange={(e) => setTextSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && textSearchHits.length) {
                    e.preventDefault();
                    setTextSearchIdx(
                      (i) => (i + (e.shiftKey ? -1 : 1) + textSearchHits.length) %
                        textSearchHits.length,
                    );
                  }
                  if (e.key === "Escape") setTextViewerOpen(false);
                }}
              />
              <span className="concall-text-search-meta">
                {textSearch.trim()
                  ? textSearchHits.length
                    ? `${textSearchIdx + 1} / ${textSearchHits.length}`
                    : "0 matches"
                  : ""}
              </span>
              <button
                type="button"
                className="buyback-text-toggle"
                disabled={!textSearchHits.length}
                onClick={() =>
                  setTextSearchIdx(
                    (i) =>
                      (i - 1 + textSearchHits.length) % textSearchHits.length,
                  )
                }
              >
                Prev
              </button>
              <button
                type="button"
                className="buyback-text-toggle"
                disabled={!textSearchHits.length}
                onClick={() =>
                  setTextSearchIdx((i) => (i + 1) % textSearchHits.length)
                }
              >
                Next
              </button>
              <button
                type="button"
                className="buyback-text-toggle"
                onClick={() => {
                  void navigator.clipboard?.writeText(combinedText);
                }}
              >
                Copy
              </button>
              <button
                type="button"
                className="buyback-text-toggle"
                onClick={() => setTextViewerOpen(false)}
              >
                Close
              </button>
            </div>
            <pre
              className="concall-text-viewer-body"
              dangerouslySetInnerHTML={renderTextWithSearch(
                combinedText,
                textSearch,
                textSearchHits[textSearchIdx] ?? null,
              )}
            />
          </div>
          <button
            type="button"
            className="concall-text-viewer-backdrop"
            aria-label="Close text viewer"
            onClick={() => setTextViewerOpen(false)}
          />
        </div>
      ) : null}

      {summaryViewer ? (
        <div
          className="concall-text-viewer"
          role="dialog"
          aria-modal="true"
          aria-label="Executive summary"
        >
          <div className="concall-text-viewer-panel concall-summary-panel">
            <div className="concall-text-viewer-toolbar concall-summary-toolbar">
              <div className="concall-text-viewer-title">
                <DocIcon kind="summary" />
                {summaryViewer.title}
              </div>
              <button
                type="button"
                className="buyback-text-toggle"
                onClick={() => {
                  const payload = summaryViewer.exec
                    ? JSON.stringify(summaryViewer.exec, null, 2)
                    : summaryViewer.text;
                  void navigator.clipboard?.writeText(payload);
                }}
              >
                Copy JSON
              </button>
              <button
                type="button"
                className="buyback-text-toggle"
                onClick={() => setSummaryViewer(null)}
              >
                Close
              </button>
            </div>
            <div className="concall-summary-scroll">
              <ExecSummaryHtml
                exec={summaryViewer.exec}
                sentiment={summaryViewer.sentiment}
                score={summaryViewer.score}
                nseSymbol={summaryViewer.nseSymbol}
                fallbackText={summaryViewer.text}
              />
            </div>
          </div>
          <button
            type="button"
            className="concall-text-viewer-backdrop"
            aria-label="Close summary"
            onClick={() => setSummaryViewer(null)}
          />
        </div>
      ) : null}
    </section>
  );
}
