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
  pending_fields?: boolean;
  save_gaps?: Array<{ field: string; reason: string }>;
  repaired?: string[];
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
  { id: "text", label: "Extract text (OCR model)" },
  { id: "fields", label: "Analyse fields with Mistral" },
  { id: "repair", label: "Find missing fields + repair" },
  { id: "ticker", label: "Resolve ticker + sales + Δ order" },
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

type BatchLogKind =
  | "pass"
  | "no_pdf"
  | "fail_fields"
  | "fail_ratio"
  | "error"
  | "running";

type AnnouncedHit = {
  ticker: string;
  company: string | null;
  title: string;
  url: string | null;
  announced_at: string | null;
  period: string | null;
  provider: string;
};

type BatchLogRow = {
  ticker: string;
  name: string | null;
  kind: BatchLogKind;
  detail: string;
  title?: string | null;
  url?: string | null;
  order_to_sales_pct?: number | null;
};

const HOLD_PAUSE_AFTER_DISCOVER_MS = 1800;
const HOLD_PAUSE_AFTER_SCREEN_MS = 2800;
const HOLD_PAUSE_BETWEEN_MS = 2200;

function sleep(ms: number, shouldAbort: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (shouldAbort() || Date.now() - started >= ms) {
        resolve();
        return;
      }
      window.setTimeout(tick, 200);
    };
    window.setTimeout(tick, Math.min(200, ms));
  });
}

function classifyBatchFail(json: ScreenResult & { error?: string }): {
  kind: BatchLogKind;
  detail: string;
} {
  const why = json.why || json.error || "FAIL";
  if (/no reg-30|no .*order pdf/i.test(why)) {
    return { kind: "no_pdf", detail: why };
  }
  if (
    /order\/sales|need ≥|need ₹ size|need sales|not saved/i.test(why) ||
    (json.extract?.order_to_sales_pct != null &&
      json.extract.order_to_sales_pct < 50)
  ) {
    const pct = json.extract?.order_to_sales_pct;
    return {
      kind: "fail_ratio",
      detail:
        pct != null
          ? `Order/Sales ${pct.toFixed(1)}% (<50%) — ${why}`
          : why,
    };
  }
  if (
    /no awarding|no order|little text|could not|ocr|download/i.test(why) ||
    !json.ok
  ) {
    return { kind: "fail_fields", detail: why };
  }
  return { kind: "fail_fields", detail: why };
}

export function OrderbookResearchPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const batchAbortRef = useRef(false);
  const [url, setUrl] = useState("");
  const [tickerInput, setTickerInput] = useState("");
  const [announcedAt, setAnnouncedAt] = useState<string | null>(null);
  const [announcedBusy, setAnnouncedBusy] = useState(false);
  const [announcedHits, setAnnouncedHits] = useState<AnnouncedHit[]>([]);
  const [announcedNote, setAnnouncedNote] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [useLlm, setUseLlm] = useState(true);
  const [holdOn, setHoldOn] = useState(false);
  const [holdings, setHoldings] = useState<
    Array<{ ticker: string; name: string | null; market: string }>
  >([]);
  const [batchProgress, setBatchProgress] = useState<{
    i: number;
    total: number;
    ticker: string;
    step: string;
    pass: number;
    fail: number;
    skip: number;
    label?: string;
  } | null>(null);
  const [batchLog, setBatchLog] = useState<BatchLogRow[]>([]);
  const [batchLogKind, setBatchLogKind] = useState<"holdings" | "announced">(
    "holdings",
  );
  const [status, setStatus] = useState<string | null>(null);
  const [progressStep, setProgressStep] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const [showJson, setShowJson] = useState(true);

  const loadHoldingsList = useCallback(async () => {
    try {
      const res = await fetch("/api/orderbook-screen?holdings=1", {
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        holdings?: Array<{ ticker: string; name: string | null; market: string }>;
      };
      if (res.ok && json.holdings) setHoldings(json.holdings);
    } catch {
      /* ignore */
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/orderbook-screen?limit=200", {
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

  const loadAnnouncedToday = useCallback(async () => {
    setAnnouncedBusy(true);
    setError(null);
    setStatus("Scanning NSE/BSE for Reg-30 order PDFs (last 7 days)…");
    try {
      const res = await fetch("/api/orderbook-screen?announced=1&days=7", {
        signal: AbortSignal.timeout(180_000),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        count?: number;
        tickers?: string[];
        sources?: AnnouncedHit[];
        note?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "Announced scan failed");
      }
      setAnnouncedHits(json.sources || []);
      setAnnouncedNote(json.note || null);
      const n = json.count ?? json.sources?.length ?? 0;
      const t = json.tickers?.length ?? 0;
      setStatus(
        n
          ? `Last 7d · ${n} order filing(s) · ${t} compan${t === 1 ? "y" : "ies"}`
          : json.note || "No Reg-30 order PDFs in the last 7 days",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Announced scan failed");
      setStatus(null);
    } finally {
      setAnnouncedBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    void loadHoldingsList();
  }, [loadHistory, loadHoldingsList]);

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
    if ((!busy && !batchBusy) || startedAt == null) return;
    const tick = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => window.clearInterval(tick);
  }, [busy, batchBusy, startedAt]);

  useEffect(() => {
    if (!busy) return;
    // OCR + Mistral dominate wall time — keep progress on those steps longer
    // so "Resolve ticker + sales" is not blamed for the wait.
    const timers = [
      window.setTimeout(() => setProgressStep(1), 400),
      window.setTimeout(() => setProgressStep(2), 2_500),
      window.setTimeout(() => setProgressStep(3), 12_000),
      window.setTimeout(() => setProgressStep(4), 22_000),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [busy]);

  const holdSet = useMemo(
    () => new Set(holdings.map((h) => h.ticker.toUpperCase())),
    [holdings],
  );

  const visibleHistory = useMemo(() => {
    if (!holdOn) return history;
    return history.filter(
      (h) => h.ticker && holdSet.has(h.ticker.toUpperCase()),
    );
  }, [history, holdOn, holdSet]);

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

  const stopBatch = useCallback(() => {
    batchAbortRef.current = true;
  }, []);

  const runHoldings = useCallback(async () => {
    if (!holdings.length) {
      setError("No holdings in holdings.db");
      return;
    }
    batchAbortRef.current = false;
    setHoldOn(true);
    setBatchBusy(true);
    setBusy(false);
    setError(null);
    setResult(null);
    setBatchLog([]);
    setBatchLogKind("holdings");
    setStartedAt(Date.now());
    setElapsedMs(0);
    let pass = 0;
    let fail = 0;
    let skip = 0;
    const total = holdings.length;
    const aborted = () => batchAbortRef.current;

    const pushLog = (row: BatchLogRow) => {
      setBatchLog((prev) => [row, ...prev].slice(0, 120));
    };

    for (let i = 0; i < holdings.length; i++) {
      if (aborted()) {
        setStatus(
          `Stopped · ${i}/${total} · PASS ${pass} · FAIL ${fail} · no PDF ${skip}`,
        );
        break;
      }

      const row = holdings[i]!;
      const ticker = row.ticker.toUpperCase();
      const name = row.name;
      setTickerInput(ticker);
      setUrl("");
      setAnnouncedAt(null);
      setFile(null);
      setResult(null);
      setBatchProgress({
        i: i + 1,
        total,
        ticker,
        step: "1/2 Discover Reg-30 PDF",
        pass,
        fail,
        skip,
        label: "Holdings",
      });
      setStatus(
        `${i + 1}/${total} · ${ticker}${name ? ` · ${name}` : ""} · finding Reg-30 order PDF…`,
      );
      pushLog({
        ticker,
        name,
        kind: "running",
        detail: "Discovering Reg-30 order PDF on BSE/NSE…",
      });

      let latestUrl = "";
      let latestTitle: string | null = null;
      let latestAnnounced: string | null = null;
      try {
        const discRes = await fetch(
          `/api/orderbook-screen?discover=${encodeURIComponent(ticker)}`,
          { signal: AbortSignal.timeout(60_000) },
        );
        const disc = (await discRes.json()) as {
          ok?: boolean;
          latest?: {
            url?: string;
            title?: string;
            period?: string | null;
            announced_at?: string | null;
          } | null;
          note?: string;
          error?: string;
        };
        if (!discRes.ok || !disc.ok) {
          throw new Error(disc.error || "Discover failed");
        }
        latestUrl = disc.latest?.url?.trim() || "";
        latestTitle = disc.latest?.title || null;
        latestAnnounced = disc.latest?.announced_at?.trim() || null;
        if (!latestUrl) {
          skip += 1;
          const detail =
            disc.note ||
            "No Reg-30 order / LOI PDF on BSE or NSE — missing for us to fix discover filters or paste URL";
          pushLog({
            ticker,
            name,
            kind: "no_pdf",
            detail,
            title: null,
            url: null,
          });
          setStatus(`${i + 1}/${total} · ${ticker} · NO PDF — ${detail}`);
          setBatchProgress({
            i: i + 1,
            total,
            ticker,
            step: "No PDF found",
            pass,
            fail,
            skip,
          });
          setError(null);
          await sleep(HOLD_PAUSE_BETWEEN_MS, aborted);
          continue;
        }

        setUrl(latestUrl);
        setAnnouncedAt(latestAnnounced);
        setStatus(
          `${i + 1}/${total} · ${ticker} · found · ${latestTitle || "Order PDF"}` +
            (disc.latest?.period ? ` · ${disc.latest.period}` : "") +
            " — pausing so you can see it…",
        );
        pushLog({
          ticker,
          name,
          kind: "running",
          detail: `Found PDF · ${latestTitle || "Order PDF"}`,
          title: latestTitle,
          url: latestUrl,
        });
        setBatchProgress({
          i: i + 1,
          total,
          ticker,
          step: "Pause · review PDF URL",
          pass,
          fail,
          skip,
        });
        await sleep(HOLD_PAUSE_AFTER_DISCOVER_MS, aborted);
        if (aborted()) break;

        setBatchProgress({
          i: i + 1,
          total,
          ticker,
          step: "2/2 Analyse PDF",
          pass,
          fail,
          skip,
        });
        setStatus(
          `${i + 1}/${total} · ${ticker} · analysing awarding / size / sales…`,
        );
        pushLog({
          ticker,
          name,
          kind: "running",
          detail: "Analysing PDF (text → fields → sales)…",
          title: latestTitle,
          url: latestUrl,
        });

        const res = await fetch("/api/orderbook-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: latestUrl,
            ticker,
            mode: useLlm ? "llm" : "lexical",
            announced_at: latestAnnounced || undefined,
          }),
          signal: AbortSignal.timeout(240_000),
        });
        const json = (await res.json()) as ScreenResult & { error?: string };
        setResult(json);

        if (json.decision === "pass") {
          pass += 1;
          const pct = json.extract?.order_to_sales_pct;
          const detail =
            (json.why || "PASS") +
            (pct != null ? ` · Order/Sales ${pct.toFixed(1)}%` : "");
          pushLog({
            ticker,
            name,
            kind: "pass",
            detail,
            title: latestTitle,
            url: latestUrl,
            order_to_sales_pct: pct ?? null,
          });
          setStatus(`${i + 1}/${total} · ${ticker} · PASS`);
          setError(null);
        } else {
          fail += 1;
          const classified = classifyBatchFail(json);
          pushLog({
            ticker,
            name,
            kind: classified.kind,
            detail: classified.detail,
            title: latestTitle,
            url: latestUrl,
            order_to_sales_pct: json.extract?.order_to_sales_pct ?? null,
          });
          setStatus(
            `${i + 1}/${total} · ${ticker} · ${classified.kind.toUpperCase()} — ${classified.detail}`,
          );
          setError(classified.detail);
        }

        setBatchProgress({
          i: i + 1,
          total,
          ticker,
          step: "Done · pause before next",
          pass,
          fail,
          skip,
        });
        await loadHistory();
        await sleep(HOLD_PAUSE_AFTER_SCREEN_MS, aborted);
      } catch (e) {
        fail += 1;
        const detail = e instanceof Error ? e.message : "failed";
        pushLog({
          ticker,
          name,
          kind: "error",
          detail,
          title: latestTitle,
          url: latestUrl || null,
        });
        setStatus(`${i + 1}/${total} · ${ticker} · ERROR — ${detail}`);
        setError(detail);
        setBatchProgress({
          i: i + 1,
          total,
          ticker,
          step: "Error",
          pass,
          fail,
          skip,
        });
        await sleep(HOLD_PAUSE_BETWEEN_MS, aborted);
      }
    }

    if (!batchAbortRef.current) {
      setStatus(
        `Holdings done · ${total} · PASS ${pass} · FAIL ${fail} · no PDF ${skip}`,
      );
    }
    setBatchBusy(false);
    setBatchProgress(null);
    await loadHistory();
  }, [holdings, useLlm, loadHistory]);

  const runAnnouncedBulk = useCallback(async () => {
    const queue = announcedHits.filter((h) => h.url?.trim());
    if (!queue.length) {
      setError(
        announcedHits.length
          ? "No PDF URLs in today’s list — reload Today’s orders"
          : "Load Today’s orders first",
      );
      return;
    }
    batchAbortRef.current = false;
    setBatchBusy(true);
    setBusy(false);
    setError(null);
    setResult(null);
    setBatchLog([]);
    setBatchLogKind("announced");
    setStartedAt(Date.now());
    setElapsedMs(0);
    let pass = 0;
    let fail = 0;
    let skip = 0;
    const total = queue.length;
    const aborted = () => batchAbortRef.current;
    const pushLog = (row: BatchLogRow) => {
      setBatchLog((prev) => [row, ...prev].slice(0, 120));
    };

    for (let i = 0; i < queue.length; i++) {
      if (aborted()) {
        setStatus(
          `Stopped · ${i}/${total} · PASS ${pass} · FAIL ${fail} · no PDF ${skip}`,
        );
        break;
      }

      const h = queue[i]!;
      const ticker = h.ticker.toUpperCase();
      const name = h.company;
      const latestUrl = h.url!.trim();
      const latestTitle = h.title || null;
      const latestAnnounced = h.announced_at?.trim() || null;

      setTickerInput(ticker);
      setUrl(latestUrl);
      setAnnouncedAt(latestAnnounced);
      setFile(null);
      setResult(null);
      setBatchProgress({
        i: i + 1,
        total,
        ticker,
        step: "Analyse PDF",
        pass,
        fail,
        skip,
        label: "Today’s orders",
      });
      setStatus(
        `${i + 1}/${total} · ${ticker}${name ? ` · ${name}` : ""} · analysing…`,
      );
      pushLog({
        ticker,
        name,
        kind: "running",
        detail: `Analysing · ${latestTitle || "Order PDF"}`,
        title: latestTitle,
        url: latestUrl,
      });

      try {
        const res = await fetch("/api/orderbook-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: latestUrl,
            ticker,
            mode: useLlm ? "llm" : "lexical",
            announced_at: latestAnnounced || undefined,
          }),
          signal: AbortSignal.timeout(240_000),
        });
        const json = (await res.json()) as ScreenResult & { error?: string };
        setResult(json);

        if (json.decision === "pass") {
          pass += 1;
          const pct = json.extract?.order_to_sales_pct;
          const detail =
            (json.why || "PASS") +
            (pct != null ? ` · Order/Sales ${pct.toFixed(1)}%` : "");
          pushLog({
            ticker,
            name,
            kind: "pass",
            detail,
            title: latestTitle,
            url: latestUrl,
            order_to_sales_pct: pct ?? null,
          });
          setStatus(`${i + 1}/${total} · ${ticker} · PASS`);
          setError(null);
        } else {
          fail += 1;
          const classified = classifyBatchFail(json);
          pushLog({
            ticker,
            name,
            kind: classified.kind,
            detail: classified.detail,
            title: latestTitle,
            url: latestUrl,
            order_to_sales_pct: json.extract?.order_to_sales_pct ?? null,
          });
          setStatus(
            `${i + 1}/${total} · ${ticker} · ${classified.kind.toUpperCase()} — ${classified.detail}`,
          );
          setError(classified.detail);
        }

        setBatchProgress({
          i: i + 1,
          total,
          ticker,
          step: "Done · pause before next",
          pass,
          fail,
          skip,
          label: "Today’s orders",
        });
        await loadHistory();
        await sleep(HOLD_PAUSE_AFTER_SCREEN_MS, aborted);
      } catch (e) {
        fail += 1;
        const detail = e instanceof Error ? e.message : "failed";
        pushLog({
          ticker,
          name,
          kind: "error",
          detail,
          title: latestTitle,
          url: latestUrl,
        });
        setStatus(`${i + 1}/${total} · ${ticker} · ERROR — ${detail}`);
        setError(detail);
        setBatchProgress({
          i: i + 1,
          total,
          ticker,
          step: "Error",
          pass,
          fail,
          skip,
          label: "Today’s orders",
        });
        await sleep(HOLD_PAUSE_BETWEEN_MS, aborted);
      }
    }

    if (!batchAbortRef.current) {
      setStatus(
        `Today’s orders done · ${total} · PASS ${pass} · FAIL ${fail} · no PDF ${skip}`,
      );
    }
    setBatchBusy(false);
    setBatchProgress(null);
    await loadHistory();
  }, [announcedHits, useLlm, loadHistory]);

  const run = useCallback(async (opts?: {
    url?: string;
    ticker?: string;
    announced_at?: string | null;
  }) => {
    const trimmed = (opts?.url ?? url).trim();
    const ticker =
      (opts?.ticker ?? tickerInput).trim().toUpperCase() || undefined;
    const annAt =
      opts && "announced_at" in opts ? opts.announced_at : announcedAt;
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
      file && !opts?.url
        ? `Step 1/4 · Reading uploaded PDF${useLlm ? " (OCR → Mistral)" : " (OCR)"}…`
        : `Step 1/4 · Downloading PDF${useLlm ? " (OCR → Mistral)" : " (OCR)"}…`,
    );
    try {
      let res: Response;
      if (file && !opts?.url) {
        const form = new FormData();
        if (trimmed) form.set("url", trimmed);
        form.set("file", file);
        if (ticker) form.set("ticker", ticker);
        form.set("mode", useLlm ? "llm" : "lexical");
        if (annAt) form.set("announced_at", annAt);
        setStatus(
          useLlm
            ? "Step 2–4 · OCR text + Mistral fields + sales…"
            : "Step 2–4 · Text, fields, ticker DB + sales…",
        );
        res = await fetch("/api/orderbook-screen", {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(240_000),
        });
      } else {
        setStatus(
          useLlm
            ? "Step 2–4 · OCR text + Mistral fields + sales…"
            : "Step 2–4 · Text, fields, ticker DB + sales…",
        );
        res = await fetch("/api/orderbook-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: trimmed,
            ticker,
            mode: useLlm ? "llm" : "lexical",
            announced_at: annAt || undefined,
          }),
          signal: AbortSignal.timeout(240_000),
        });
      }
      const json = (await res.json()) as ScreenResult;
      setResult(json);
      if (!res.ok || json.error) {
        setError(json.error || "Analyse failed");
      } else {
        setStatus(json.why || (json.decision === "pass" ? "PASS" : "Done"));
      }
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analyse failed");
      setStatus(null);
    } finally {
      setBusy(false);
      setProgressStep(PROGRESS_STEPS.length);
    }
  }, [url, file, tickerInput, useLlm, announcedAt, loadHistory]);

  const scanAnnounced = useCallback(
    (h: AnnouncedHit) => {
      if (!h.url) {
        setError("No PDF URL for this filing");
        return;
      }
      setTickerInput(h.ticker);
      setUrl(h.url);
      setAnnouncedAt(h.announced_at);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      void run({
        url: h.url,
        ticker: h.ticker,
        announced_at: h.announced_at,
      });
    },
    [run],
  );

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
        <strong>Research · Order book.</strong>{" "}
        <strong>Today’s orders</strong> lists Reg-30 filings → row{" "}
        <strong>Scan</strong> or <strong>Bulk scan</strong>. Or turn on{" "}
        <strong>Hold</strong> and <strong>Run holdings</strong>. PASS only when
        Order/Sales ≥ 50%.
      </p>

      <div className="concall-dual-row" style={{ marginBottom: 10 }}>
        <button
          type="button"
          className={`chip tag-chip ${announcedBusy ? "busy on" : ""}`}
          disabled={busy || batchBusy || announcedBusy}
          onClick={() => void loadAnnouncedToday()}
          title="List companies with Reg-30 order / LOI PDFs (NSE + BSE)"
        >
          {announcedBusy ? "Scanning…" : "Today’s orders"}
        </button>
        {announcedHits.some((h) => h.url?.trim()) ? (
          batchBusy && batchProgress?.label === "Today’s orders" ? null : (
            <button
              type="button"
              className="chip chip-scan tag-chip"
              disabled={busy || batchBusy || announcedBusy}
              onClick={() => void runAnnouncedBulk()}
              title={`Analyse every PDF in today’s list (${announcedHits.filter((h) => h.url?.trim()).length})`}
            >
              Bulk scan (
              {announcedHits.filter((h) => h.url?.trim()).length})
            </button>
          )
        ) : null}
        <button
          type="button"
          className={`chip tag-chip tag-hold ${holdOn ? "on" : ""}`}
          disabled={batchBusy}
          onClick={() => {
            const next = !holdOn;
            setHoldOn(next);
            if (next && holdings.length === 0) void loadHoldingsList();
          }}
          title="Your holdings — filter PASS list + enable Run holdings"
        >
          Hold
          <span className="chip-count">{holdings.length}</span>
        </button>
        {batchBusy ? (
          <button
            type="button"
            className="chip tag-chip"
            onClick={stopBatch}
            title="Stop after current ticker"
          >
            Stop
          </button>
        ) : holdOn ? (
          <button
            type="button"
            className="chip chip-scan tag-chip"
            disabled={busy || holdings.length === 0}
            onClick={() => void runHoldings()}
            title={`Slow run: discover → pause → analyse → pause for each of ${holdings.length} holdings`}
          >
            Run holdings ({holdings.length})
          </button>
        ) : null}
      </div>

      <div className="buyback-input-row">
        <input
          type="url"
          className="buyback-url-input"
          placeholder="Reg-30 order PDF URL (from Today’s orders / Scan)…"
          value={url}
          disabled={busy || batchBusy}
          onChange={(e) => {
            setUrl(e.target.value);
            setAnnouncedAt(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
        />
        <button
          type="button"
          className={`chip tag-chip ${useLlm ? "on" : ""}`}
          disabled={busy || batchBusy}
          onClick={() => setUseLlm((v) => !v)}
          title="Off = lexical rules only. On = OCR extract (glm-ocr) then Mistral analyse (LLM_MODEL_HIGHLIGHTS / LLM_MODEL_ORDERBOOK)"
        >
          Mistral
        </button>
        <button
          type="button"
          className={`chip chip-scan tag-chip ${busy ? "busy on" : ""}`}
          disabled={busy || batchBusy || (!url.trim() && !file)}
          onClick={() => void run()}
        >
          {busy ? "Analysing…" : useLlm ? "Analyse · OCR + Mistral" : "Analyse"}
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
            setAnnouncedAt(null);
            setFile(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        >
          Sample (AFCONS)
        </button>
      </div>

      {status && !busy && !batchBusy ? (
        <p className="buyback-status" role="status">
          {status}
        </p>
      ) : null}
      {batchBusy && batchProgress ? (
        <div className="buyback-progress" role="status" aria-live="polite">
          <p className="buyback-progress-title">
            {batchProgress.label || "Holdings"} {batchProgress.i}/
            {batchProgress.total} · {batchProgress.ticker}
            <span className="buyback-progress-elapsed">
              {fmtElapsed(elapsedMs)}
            </span>
          </p>
          <p className="buyback-progress-hint">
            <strong>{batchProgress.step}</strong>
            {" · "}
            PASS {batchProgress.pass} · FAIL {batchProgress.fail} · no PDF{" "}
            {batchProgress.skip}
          </p>
          {status ? (
            <p className="buyback-progress-hint" style={{ marginTop: 4 }}>
              {status}
            </p>
          ) : null}
        </div>
      ) : null}
      {batchLog.length > 0 ? (
        <div className="orderbook-batch-log">
          <div className="orderbook-batch-log-head">
            <h3 className="buyback-history-title">
              {batchLogKind === "announced"
                ? "Today’s orders run log"
                : "Holdings run log"}
              <span className="buyback-history-count">{batchLog.length}</span>
            </h3>
            <p className="buyback-history-empty" style={{ margin: 0 }}>
              Watch missing PDF / weak Order-Sales / parse gaps — newest first
            </p>
          </div>
          <ul className="orderbook-batch-log-list">
            {batchLog.map((row, idx) => (
              <li
                key={`${row.ticker}-${idx}-${row.kind}`}
                className={`orderbook-batch-log-item kind-${row.kind}`}
              >
                <div className="orderbook-batch-log-top">
                  <span className={`orderbook-batch-pill kind-${row.kind}`}>
                    {row.kind === "no_pdf"
                      ? "NO PDF"
                      : row.kind === "fail_ratio"
                        ? "LOW %"
                        : row.kind === "fail_fields"
                          ? "PARSE"
                          : row.kind === "running"
                            ? "…"
                            : row.kind.toUpperCase()}
                  </span>
                  <strong>{row.ticker}</strong>
                  {row.name ? (
                    <span className="orderbook-batch-name">{row.name}</span>
                  ) : null}
                  {row.order_to_sales_pct != null ? (
                    <span className="orderbook-batch-pct">
                      {row.order_to_sales_pct.toFixed(1)}%
                    </span>
                  ) : null}
                </div>
                <p className="orderbook-batch-detail">{row.detail}</p>
                {row.url ? (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setTickerInput(row.ticker);
                      setUrl(row.url || "");
                      setAnnouncedAt(null);
                      setFile(null);
                      setHoldOn(true);
                    }}
                  >
                    Open PDF URL
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
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
                Extract uses the OCR model (glm-ocr); Analyse uses Mistral.
                Ticker from Symbol, BSE scrip, or company name in DB.
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
              {result.repaired && result.repaired.length > 0 ? (
                <p className="buyback-history-empty" style={{ marginTop: 8 }}>
                  Repaired: {result.repaired.join(", ")}
                </p>
              ) : null}
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

      {announcedHits.length > 0 || announcedNote ? (
        <div className="buyback-history" style={{ marginBottom: 16 }}>
          <div className="orderbook-batch-log-head">
            <h3 className="buyback-history-title">
              Today’s Reg-30 orders
              <span className="buyback-history-count">
                {announcedHits.length}
              </span>
            </h3>
            {announcedHits.some((h) => h.url?.trim()) && !batchBusy ? (
              <button
                type="button"
                className="chip chip-scan tag-chip"
                disabled={busy || announcedBusy}
                onClick={() => void runAnnouncedBulk()}
                title="Run Analyse on every row with a PDF"
              >
                Bulk scan (
                {announcedHits.filter((h) => h.url?.trim()).length})
              </button>
            ) : null}
          </div>
          <p className="buyback-history-empty" style={{ marginBottom: 8 }}>
            NSE + BSE · row <strong>Scan</strong> or <strong>Bulk scan</strong>{" "}
            all PDFs
            {announcedNote ? ` · ${announcedNote}` : ""}
          </p>
          {announcedHits.length === 0 ? (
            <p className="buyback-history-empty">
              {announcedNote || "No order filings today."}
            </p>
          ) : (
            <div className="buyback-pass-table-wrap">
              <table className="buyback-pass-table orderbook-pass-table">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Title</th>
                    <th>Source</th>
                    <th>PDF</th>
                    <th>Scan</th>
                  </tr>
                </thead>
                <tbody>
                  {announcedHits.map((h, i) => (
                    <tr
                      key={`${h.ticker}-${h.url || h.title}-${i}`}
                      className="buyback-pass-row"
                    >
                      <td>
                        <button
                          type="button"
                          className="link-btn buyback-pass-company"
                          disabled={busy || announcedBusy || batchBusy}
                          onClick={() => {
                            setTickerInput(h.ticker);
                            if (h.url) {
                              setUrl(h.url);
                              setAnnouncedAt(h.announced_at);
                              setFile(null);
                            }
                          }}
                          title="Load ticker + PDF URL"
                        >
                          {h.company || h.ticker}
                        </button>
                        <span className="buyback-pass-co">{h.ticker}</span>
                      </td>
                      <td>{h.title}</td>
                      <td>{h.provider.replace(/_/g, " ")}</td>
                      <td>
                        {h.url ? (
                          <button
                            type="button"
                            className="link-btn"
                            disabled={busy || announcedBusy || batchBusy}
                            onClick={() => {
                              setTickerInput(h.ticker);
                              setUrl(h.url!);
                              setAnnouncedAt(h.announced_at);
                              setFile(null);
                              setStatus(
                                `Loaded ${h.ticker} · click Analyse`,
                              );
                            }}
                          >
                            Use PDF
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {h.url ? (
                          <button
                            type="button"
                            className={`chip chip-scan tag-chip ${busy ? "busy on" : ""}`}
                            disabled={busy || announcedBusy || batchBusy}
                            onClick={() => scanAnnounced(h)}
                            title="Select this filing and run Analyse"
                          >
                            {busy ? "…" : "Scan"}
                          </button>
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
      ) : null}

      <div className="buyback-history">
        <h3 className="buyback-history-title">
          Order book list (PASS)
          <span className="buyback-history-count">
            {holdOn
              ? `${visibleHistory.length}/${history.length}`
              : history.length}
          </span>
        </h3>
        <p className="buyback-history-empty" style={{ marginBottom: 8 }}>
          PASS only · Order/Sales ≥ 50% · Awarding · Size · Execution ·
          Announcement date
          {holdOn ? " · filtered to Hold" : ""}
        </p>
        {visibleHistory.length === 0 ? (
          <p className="buyback-history-empty">
            {holdOn
              ? "No PASS rows in your holdings yet — Run holdings."
              : "No PASS screens yet (need Order/Sales ≥ 50%)."}
          </p>
        ) : (
          <div className="buyback-pass-table-wrap">
            <table className="buyback-pass-table orderbook-pass-table">
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
                {visibleHistory.map((h) => (
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
