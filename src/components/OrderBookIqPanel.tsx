"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { announcementDedupeKey } from "@/lib/announcement-dedupe";
import { tradingviewUrl } from "@/lib/links";

type OrderHit = {
  ticker: string;
  company: string | null;
  title: string;
  url: string | null;
  announced_at: string | null;
  period: string | null;
  provider: string;
};

type HistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  order_date: string | null;
  news_date: string | null;
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

type DecisionLabel = "pass" | "fail" | "pending";

type AnalysedOverlay = {
  awarding_entity: string;
  order_size: string;
  execution: string;
  order_size_cr: number | null;
  sales_cr: number | null;
  order_to_sales_pct: number | null;
  decision: DecisionLabel;
  why: string | null;
  ltp: number | null;
  baseline_close: number | null;
  drift_pct: number | null;
  subject: string | null;
};

type FeedRow = {
  key: string;
  historyId: number | null;
  company: string;
  ticker: string;
  dateLabel: string;
  dateIso: string | null;
  headline: string;
  awarding_entity: string;
  order_size: string;
  execution: string;
  order_size_cr: number | null;
  sales_cr: number | null;
  order_to_sales_pct: number | null;
  decision: DecisionLabel;
  why: string | null;
  ltp: number | null;
  baseline_close: number | null;
  drift_pct: number | null;
  url: string | null;
  hit: OrderHit | null;
};

type DecisionFilter = "all" | "pass" | "fail" | "pending";

const PAGE_SIZE = 25;

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

function fmtNum(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function fmtDrift(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function preferFeedRow(a: FeedRow, b: FeedRow): FeedRow {
  const rank = (r: FeedRow) => {
    let s = 0;
    if (r.decision === "pass") s += 40;
    else if (r.decision === "fail") s += 20;
    if (r.historyId != null) s += 15;
    if (!/^BSE\d+/i.test(r.ticker)) s += 10;
    if (r.order_to_sales_pct != null) s += 8;
    if (r.order_size_cr != null) s += 5;
    if (r.url) s += 2;
    if ((r.company || "").length > 8) s += 1;
    return s;
  };
  if (rank(b) > rank(a)) {
    return {
      ...b,
      url: b.url || a.url,
      hit: b.hit || a.hit,
    };
  }
  return {
    ...a,
    url: a.url || b.url,
    hit: a.hit || b.hit,
  };
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

function orderbookTvMarket(ticker: string | null | undefined): string {
  const t = (ticker || "").trim().toUpperCase();
  if (t.startsWith("BSE") || /^\d{6}$/.test(t)) return "BSE";
  return "NSE";
}

function CompanyTvLink({
  ticker,
  company,
}: {
  ticker: string | null | undefined;
  company: string | null | undefined;
}) {
  const label = (company || ticker || "—").trim() || "—";
  const sym = (ticker || "").trim().toUpperCase();
  // Placeholder BSE###### codes are not TradingView symbols.
  if (!sym || sym === "—" || /^BSE\d+$/i.test(sym)) {
    return <div className="miq-co-name">{label}</div>;
  }
  return (
    <a
      className="miq-co-name"
      href={tradingviewUrl(sym, orderbookTvMarket(sym))}
      target="_blank"
      rel="noreferrer"
      title={`${label} — TradingView`}
    >
      {label}
    </a>
  );
}

function overlayKeysFor(opts: {
  url?: string | null;
  ticker?: string | null;
  title?: string | null;
  historyId?: number | null;
}): string[] {
  const keys: string[] = [];
  if (opts.url?.trim()) keys.push(`url:${opts.url.trim()}`);
  if (opts.historyId != null) keys.push(`id:${opts.historyId}`);
  if (opts.ticker || opts.title) {
    keys.push(`t:${(opts.ticker || "").toUpperCase()}|${opts.title || ""}`);
  }
  return [...new Set(keys)];
}

function hitToFeed(h: OrderHit, i: number): FeedRow {
  return {
    key: `live-${h.ticker}-${h.announced_at}-${i}`,
    historyId: null,
    company: h.company || h.ticker,
    ticker: h.ticker,
    dateLabel: fmtDate(h.announced_at),
    dateIso: h.announced_at,
    headline: h.title,
    awarding_entity: "—",
    order_size: "—",
    execution: "—",
    order_size_cr: null,
    sales_cr: null,
    order_to_sales_pct: null,
    decision: "pending",
    why: null,
    ltp: null,
    baseline_close: null,
    drift_pct: null,
    url: h.url,
    hit: h,
  };
}

function histToFeed(h: HistoryRow): FeedRow {
  const iso = h.news_date || h.order_date || h.screened_at;
  return {
    key: `hist-${h.id}`,
    historyId: h.id,
    company: h.company || h.ticker || "—",
    ticker: (h.ticker || "—").toUpperCase(),
    dateLabel: fmtDate(iso),
    dateIso: iso,
    headline: h.awarding_entity
      ? `Order · ${h.awarding_entity}`
      : "Order win (PASS)",
    awarding_entity: h.awarding_entity || "—",
    order_size: h.order_size || "—",
    execution: h.execution || "—",
    order_size_cr: h.order_size_cr,
    sales_cr: h.sales_cr,
    order_to_sales_pct: h.order_to_sales_pct,
    decision: "pass",
    why: null,
    ltp: h.ltp,
    baseline_close: h.baseline_close,
    drift_pct: h.drift_pct,
    url: h.source_url,
    hit: h.source_url
      ? {
          ticker: (h.ticker || "").toUpperCase(),
          company: h.company,
          title: h.awarding_entity || "Order",
          url: h.source_url,
          announced_at: h.news_date || h.order_date,
          period: null,
          provider: "history",
        }
      : null,
  };
}

function applyOverlay(
  row: FeedRow,
  overlay: AnalysedOverlay | undefined,
): FeedRow {
  if (!overlay) return row;
  return {
    ...row,
    awarding_entity: overlay.awarding_entity || row.awarding_entity,
    order_size: overlay.order_size || row.order_size,
    execution: overlay.execution || row.execution,
    order_size_cr: overlay.order_size_cr ?? row.order_size_cr,
    sales_cr: overlay.sales_cr ?? row.sales_cr,
    order_to_sales_pct: overlay.order_to_sales_pct ?? row.order_to_sales_pct,
    decision: overlay.decision,
    why: overlay.why,
    ltp: overlay.ltp ?? row.ltp,
    baseline_close: overlay.baseline_close ?? row.baseline_close,
    drift_pct: overlay.drift_pct ?? row.drift_pct,
    headline: overlay.subject || row.headline,
  };
}

function IconCalendar() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.75" />
      <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 4v10m0 0l4-4m-4 4l-4-4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 19h14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

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

type LabExtract = {
  engine: string;
  text_chars: number;
  text_excerpt: string;
};

type LabResult = {
  engine: string;
  decision: DecisionLabel;
  why: string;
  extract: {
    ticker: string | null;
    company: string | null;
    subject: string | null;
    awarding_entity: string;
    order_size: string;
    execution: string;
    order_size_cr: number | null;
    sales_cr: number | null;
    order_to_sales_pct: number | null;
    order_date: string | null;
    news_date: string | null;
    ltp: number | null;
    baseline_close: number | null;
    drift_pct: number | null;
  };
};

export function OrderBookIqPanel() {
  const [days, setDays] = useState(1);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [analyseBusyKey, setAnalyseBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [hits, setHits] = useState<OrderHit[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [overlay, setOverlay] = useState<Record<string, AnalysedOverlay>>({});
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [page, setPage] = useState(1);
  const [labFile, setLabFile] = useState<File | null>(null);
  const [labUrl, setLabUrl] = useState("");
  const [labTicker, setLabTicker] = useState("");
  const [labBusy, setLabBusy] = useState<"extract" | "analyse" | null>(null);
  const [labError, setLabError] = useState<string | null>(null);
  const [labExtract, setLabExtract] = useState<LabExtract | null>(null);
  const [labResult, setLabResult] = useState<LabResult | null>(null);
  const [passMinPct, setPassMinPct] = useState(50);
  const labFileRef = useRef<HTMLInputElement | null>(null);
  const scanStopRef = useRef(false);
  const [scanRunning, setScanRunning] = useState(false);
  const [scanStats, setScanStats] = useState<{
    ok: number;
    pass: number;
    fail: number;
    skipped: number;
    remaining: number;
    round: number;
    total: number;
    done: number;
    pct: number;
    finished?: boolean;
    errored?: boolean;
  } | null>(null);

  const loadHistory = useCallback(async (opts?: { prices?: boolean }) => {
    const withPrices = opts?.prices !== false;
    try {
      const res = await fetch(
        `/api/orderbook-screen?limit=200${withPrices ? "" : "&prices=0"}`,
      );
      const json = (await res.json()) as {
        history?: HistoryRow[];
        pass_min_pct?: number;
      };
      setHistory(json.history ?? []);
      if (
        typeof json.pass_min_pct === "number" &&
        Number.isFinite(json.pass_min_pct)
      ) {
        setPassMinPct(json.pass_min_pct);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const refreshDrift = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatusNote("Refreshing post-announcement drift…");
    try {
      await loadHistory({ prices: true });
      setStatusNote("Drift refreshed from LTP vs close before news day");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Drift refresh failed");
    } finally {
      setBusy(false);
    }
  }, [loadHistory]);

  const fetchAnnounced = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatusNote(null);
    try {
      const params = new URLSearchParams({
        announced: "1",
        days: String(days),
      });
      const res = await fetch(`/api/orderbook-screen?${params}`);
      const json = (await res.json()) as {
        ok?: boolean;
        sources?: OrderHit[];
        count?: number;
        note?: string;
        error?: string;
      };
      if (!res.ok || json.ok === false) {
        setError(json.error || "Fetch failed");
        setHits([]);
        setLive(false);
        return;
      }
      setHits(json.sources ?? []);
      setLive(true);
      setPage(1);
      if (json.note) setStatusNote(json.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
      setHits([]);
      setLive(false);
    } finally {
      setBusy(false);
    }
  }, [days]);

  useEffect(() => {
    void loadHistory();
    void fetchAnnounced();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ingestAnalyseResult = useCallback(
    (
      result: {
        ok?: boolean;
        decision?: string;
        why?: string;
        extract?: {
          awarding_entity?: string;
          order_size?: string;
          execution?: string;
          order_size_cr?: number | null;
          sales_cr?: number | null;
          order_to_sales_pct?: number | null;
          ltp?: number | null;
          baseline_close?: number | null;
          drift_pct?: number | null;
          subject?: string | null;
        };
        source_url?: string | null;
        id?: number;
      },
      seed?: {
        ticker?: string | null;
        title?: string | null;
        historyId?: number | null;
        url?: string | null;
      },
    ) => {
      if (!result.extract) return;
      const ex = result.extract;
      const decision: DecisionLabel =
        result.decision === "pass"
          ? "pass"
          : result.ok === false
            ? "fail"
            : result.decision === "fail"
              ? "fail"
              : "fail";
      const entry: AnalysedOverlay = {
        awarding_entity: ex.awarding_entity || "—",
        order_size: ex.order_size || "—",
        execution: ex.execution || "—",
        order_size_cr:
          typeof ex.order_size_cr === "number" ? ex.order_size_cr : null,
        sales_cr: typeof ex.sales_cr === "number" ? ex.sales_cr : null,
        order_to_sales_pct:
          typeof ex.order_to_sales_pct === "number"
            ? ex.order_to_sales_pct
            : null,
        decision,
        why: result.why ?? null,
        ltp: typeof ex.ltp === "number" ? ex.ltp : null,
        baseline_close:
          typeof ex.baseline_close === "number" ? ex.baseline_close : null,
        drift_pct: typeof ex.drift_pct === "number" ? ex.drift_pct : null,
        subject: ex.subject ?? null,
      };
      const keys = overlayKeysFor({
        url: result.source_url || seed?.url,
        ticker: seed?.ticker,
        title: seed?.title || ex.subject,
        historyId: seed?.historyId ?? result.id ?? null,
      });
      setOverlay((prev) => {
        const next = { ...prev };
        for (const k of keys) next[k] = entry;
        return next;
      });
    },
    [],
  );

  const analyseRow = useCallback(
    async (row: FeedRow) => {
      setAnalyseBusyKey(row.key);
      setError(null);
      setStatusNote("Analysing… PDF extract / OCR can take 1–2 min");
      try {
        const body = {
          action: "analyse",
          url: row.hit?.url || row.url,
          ticker: row.hit?.ticker || row.ticker,
          company: row.hit?.company || row.company,
          announced_at: row.hit?.announced_at || row.dateIso,
          mode: "llm",
        };
        const res = await fetch("/api/orderbook-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          decision?: string;
          why?: string;
          error?: string;
          extract?: AnalysedOverlay;
          source_url?: string | null;
          id?: number;
          history?: HistoryRow[];
          engine?: string;
        };
        if (!res.ok && !json.extract) {
          setError(json.error || "Analyse failed");
          return;
        }
        ingestAnalyseResult(json, {
          ticker: row.ticker,
          title: row.headline,
          historyId: row.historyId,
          url: row.url || row.hit?.url,
        });
        if (json.history) setHistory(json.history);
        else void loadHistory();
        const pct =
          typeof json.extract?.order_to_sales_pct === "number"
            ? `${json.extract.order_to_sales_pct.toFixed(1)}%`
            : "—";
        setStatusNote(
          `${(json.decision || "?").toUpperCase()} · Order/Sales ${pct} · ${json.engine || "ok"}`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Analyse failed");
      } finally {
        setAnalyseBusyKey(null);
      }
    },
    [ingestAnalyseResult, loadHistory],
  );

  const stopScan = useCallback(() => {
    scanStopRef.current = true;
  }, []);

  const scanAllAnnouncements = useCallback(async () => {
    if (scanRunning) return;
    scanStopRef.current = false;
    setScanRunning(true);
    setError(null);
    setScanStats({
      ok: 0,
      pass: 0,
      fail: 0,
      skipped: 0,
      remaining: 0,
      round: 0,
      total: 0,
      done: 0,
      pct: 0,
    });
    setStatusNote("Loading already-screened PDFs…");

    const queue = hits.filter((h) => h.url?.trim());
    const doneUrls = new Set<string>();

    try {
      const scr = await fetch("/api/orderbook-screen?screened=1");
      const scrJson = (await scr.json()) as { urls?: string[] };
      for (const u of scrJson.urls ?? []) {
        if (u.trim()) doneUrls.add(u.trim());
      }
    } catch {
      /* fall back to PASS history only */
      for (const h of history) {
        const u = h.source_url?.trim();
        if (u) doneUrls.add(u);
      }
    }

    const pendingQueue = queue.filter((h) => {
      const u = h.url?.trim() || "";
      return u && !doneUrls.has(u);
    });
    const already = Math.max(0, queue.length - pendingQueue.length);

    if (pendingQueue.length === 0) {
      setScanStats({
        ok: 0,
        pass: 0,
        fail: 0,
        skipped: already || doneUrls.size,
        remaining: 0,
        round: 0,
        total: already || queue.length || doneUrls.size,
        done: already || queue.length || doneUrls.size,
        pct: 100,
        finished: true,
      });
      setStatusNote(
        already || doneUrls.size
          ? `Nothing pending — ${already || doneUrls.size} already screened in DB`
          : "No order PDFs to scan — Refresh orders first",
      );
      setScanRunning(false);
      scanStopRef.current = false;
      return;
    }

    setScanStats({
      ok: 0,
      pass: 0,
      fail: 0,
      skipped: already,
      remaining: pendingQueue.length,
      round: 0,
      total: pendingQueue.length,
      done: 0,
      pct: 0,
    });
    setStatusNote(
      `Scanning ${pendingQueue.length} pending · skipped ${already} already in DB`,
    );

    let ok = 0;
    let pass = 0;
    let fail = 0;
    let skipped = already;
    let round = 0;
    let total = pendingQueue.length;
    let doneCount = 0;
    let errored = false;

    try {
      for (;;) {
        if (scanStopRef.current) break;
        round += 1;
        const res = await fetch("/api/orderbook-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "scan",
            days,
            limit: 3,
            pendingOnly: true,
            mode: "lexical",
            sources: pendingQueue,
            skipUrls: [...doneUrls],
          }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          attempted?: number;
          analysed?: number;
          passed?: number;
          failed?: number;
          skipped?: number;
          remaining?: number;
          attempted_urls?: string[];
          note?: string;
          results?: Array<{
            ok?: boolean;
            decision?: string;
            why?: string;
            extract?: {
              awarding_entity?: string;
              order_size?: string;
              execution?: string;
              order_size_cr?: number | null;
              sales_cr?: number | null;
              order_to_sales_pct?: number | null;
              ltp?: number | null;
              baseline_close?: number | null;
              drift_pct?: number | null;
              subject?: string | null;
            };
            source_url?: string | null;
            id?: number;
          }>;
          history?: HistoryRow[];
        };

        if (!res.ok || json.ok === false) {
          setError(json.error || "Scan batch failed");
          errored = true;
          break;
        }

        skipped = Math.max(skipped, already + (json.skipped ?? 0));
        ok += json.analysed ?? 0;
        pass += json.passed ?? 0;
        fail += json.failed ?? 0;
        const remaining = json.remaining ?? 0;
        const attempted = json.attempted ?? 0;
        if (round === 1 && total <= 0) {
          total = attempted + remaining;
        }
        doneCount += attempted;
        const pct =
          total > 0
            ? Math.min(100, Math.round((100 * doneCount) / total))
            : attempted === 0
              ? 100
              : 0;

        setScanStats({
          ok,
          pass,
          fail,
          skipped,
          remaining,
          round,
          total,
          done: doneCount,
          pct,
        });

        for (const u of json.attempted_urls ?? []) {
          if (u.trim()) doneUrls.add(u.trim());
        }
        for (const r of json.results ?? []) {
          const u = r.source_url?.trim();
          if (u) doneUrls.add(u);
          ingestAnalyseResult(r, {
            url: r.source_url,
            historyId: r.id ?? null,
          });
        }
        if (json.history) setHistory(json.history);

        if (attempted === 0 || remaining === 0) {
          setStatusNote(
            scanStopRef.current
              ? `Scan stopped · ${pass} PASS · ${fail} FAIL · ${skipped} skipped`
              : `Scan complete · ${pass} PASS · ${fail} FAIL · ${skipped} skipped`,
          );
          break;
        }

        setStatusNote(
          `Scanned ${doneCount}/${total} · ${pass} PASS · ${fail} FAIL · ${remaining} left · batch ${round}`,
        );
      }

      if (scanStopRef.current) {
        setStatusNote(
          `Scan stopped · ${pass} PASS · ${fail} FAIL · ${skipped} skipped`,
        );
      }
      void loadHistory({ prices: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
      errored = true;
    } finally {
      setScanStats((prev) =>
        prev
          ? {
              ...prev,
              pct: errored ? prev.pct : 100,
              finished: !errored,
              errored,
            }
          : prev,
      );
      setScanRunning(false);
      scanStopRef.current = false;
    }
  }, [scanRunning, hits, history, days, ingestAnalyseResult, loadHistory]);

  useEffect(() => {
    if (scanRunning || !scanStats?.finished) return;
    const t = window.setTimeout(() => setScanStats(null), 4000);
    return () => window.clearTimeout(t);
  }, [scanRunning, scanStats?.finished]);

  const runLabExtract = useCallback(async () => {
    setLabBusy("extract");
    setLabError(null);
    setLabResult(null);
    try {
      let bufferBase64: string | undefined;
      if (labFile) bufferBase64 = await fileToBase64(labFile);
      if (!bufferBase64 && !labUrl.trim()) {
        setLabError("Choose a PDF or paste an NSE/BSE PDF URL");
        return;
      }
      const res = await fetch("/api/orderbook-screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "extract",
          url: labUrl.trim() || null,
          bufferBase64: bufferBase64 || null,
          skipOcr: true,
        }),
      });
      const json = (await res.json()) as LabExtract & {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setLabError(json.error || "Extract failed");
        setLabExtract(null);
        return;
      }
      setLabExtract({
        engine: json.engine,
        text_chars: json.text_chars,
        text_excerpt: json.text_excerpt,
      });
    } catch (e) {
      setLabError(e instanceof Error ? e.message : "Extract failed");
    } finally {
      setLabBusy(null);
    }
  }, [labFile, labUrl]);

  const runLabAnalyse = useCallback(async () => {
    setLabBusy("analyse");
    setLabError(null);
    try {
      let bufferBase64: string | undefined;
      if (labFile) bufferBase64 = await fileToBase64(labFile);
      if (!bufferBase64 && !labUrl.trim()) {
        setLabError("Choose a PDF or paste an NSE/BSE PDF URL");
        return;
      }
      const res = await fetch("/api/orderbook-screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyse",
          url: labUrl.trim() || null,
          bufferBase64: bufferBase64 || null,
          ticker: labTicker.trim() || null,
          company: null,
          mode: "llm",
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        decision?: string;
        why?: string;
        error?: string;
        engine?: string;
        extract?: LabResult["extract"];
        history?: HistoryRow[];
      };
      if (!json.extract) {
        setLabError(json.error || "Analyse failed");
        setLabResult(null);
        return;
      }
      setLabResult({
        engine: json.engine || "ok",
        decision: json.decision === "pass" ? "pass" : "fail",
        why: json.why || "",
        extract: json.extract,
      });
      if (json.history) setHistory(json.history);
      else void loadHistory();
    } catch (e) {
      setLabError(e instanceof Error ? e.message : "Analyse failed");
    } finally {
      setLabBusy(null);
    }
  }, [labFile, labUrl, labTicker, loadHistory]);

  const feed = useMemo(() => {
    const byUrl = new Map<string, FeedRow>();
    const rows: FeedRow[] = [];

    for (const h of history) {
      const row = histToFeed(h);
      rows.push(row);
      if (h.source_url) byUrl.set(h.source_url.trim(), row);
    }

    for (let i = 0; i < hits.length; i += 1) {
      const h = hits[i]!;
      const url = h.url?.trim() || "";
      if (url && byUrl.has(url)) continue;
      rows.push(hitToFeed(h, i));
    }

    const withOverlay = rows.map((row) => {
      const keys = overlayKeysFor({
        url: row.url,
        ticker: row.ticker,
        title: row.headline,
        historyId: row.historyId,
      });
      let ov: AnalysedOverlay | undefined;
      for (const k of keys) {
        if (overlay[k]) {
          ov = overlay[k];
          break;
        }
      }
      return applyOverlay(row, ov);
    });

    // Collapse NSE/BSE doubles (Ltd vs Limited, BSE###### vs real ticker).
    const byIdentity = new Map<string, FeedRow>();
    for (const row of withOverlay) {
      const key = announcementDedupeKey({
        ticker: row.ticker,
        company: row.company,
        title: row.headline,
        day: row.dateIso,
      });
      const prev = byIdentity.get(key);
      byIdentity.set(key, prev ? preferFeedRow(prev, row) : row);
    }
    const deduped = [...byIdentity.values()];

    const qLower = q.trim().toLowerCase();
    return deduped.filter((row) => {
      if (decisionFilter !== "all" && row.decision !== decisionFilter) {
        return false;
      }
      if (!qLower) return true;
      const blob = `${row.company} ${row.ticker} ${row.headline} ${row.awarding_entity}`.toLowerCase();
      return blob.includes(qLower);
    });
  }, [history, hits, overlay, q, decisionFilter]);

  const pageCount = Math.max(1, Math.ceil(feed.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = feed.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  );
  const analysing = analyseBusyKey != null || scanRunning;

  const pdfHref = (url: string | null) => {
    if (!url) return null;
    return `/api/orderbook-screen?pdf=${encodeURIComponent(url)}`;
  };

  return (
    <div className="miq-panel obiq-panel">
      <header className="miq-head">
        <div>
          <h1 className="miq-title">OrderBookIQ</h1>
          <p className="miq-sub">
            NSE + BSE Reg-30 order / LOI / award filings · material Order/Sales
            filter
          </p>
        </div>
        <div className="miq-head-actions">
          <span className={live ? "miq-live on" : "miq-live"}>
            <span className="miq-live-dot" />
            {live ? "Live" : "Cached"}
          </span>
          <button
            type="button"
            className="chip tag-chip"
            disabled={busy || analysing}
            onClick={() => void fetchAnnounced()}
          >
            {busy ? "Refreshing…" : "Refresh orders"}
          </button>
          <label className="chip tag-chip miq-days">
            Days
            <select
              value={days}
              disabled={busy || analysing}
              onChange={(e) => setDays(Number(e.target.value) || 1)}
            >
              {[1, 2, 3, 5, 7].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="chip tag-chip"
            disabled={busy || analysing || history.length === 0}
            onClick={() => void refreshDrift()}
            title="Refresh LTP and Δ vs close before the exchange news day"
          >
            Refresh drift
          </button>
          <button
            type="button"
            className="chip chip-scan tag-chip"
            disabled={
              busy ||
              (!scanRunning && hits.length === 0 && history.length === 0)
            }
            onClick={() => {
              if (scanRunning) stopScan();
              else void scanAllAnnouncements();
            }}
            title={
              scanRunning
                ? "Stop after the current batch"
                : "Scan & analyse all pending order filings (lexical batches of 3)"
            }
          >
            {scanRunning
              ? `Stop · ${scanStats?.pct ?? 0}% · ${scanStats?.pass ?? 0} PASS`
              : "Scan & Analyse"}
          </button>
        </div>
      </header>

      {scanRunning || scanStats ? (
        <div
          className={`fill-progress obiq-scan-progress ${
            scanStats?.errored ? "is-error" : ""
          } ${scanStats?.finished ? "is-done" : ""}`}
          role="status"
          aria-live="polite"
        >
          <div className="fill-progress-meta">
            <span className="fill-progress-label">
              {scanStats?.errored
                ? "Scan failed"
                : scanStats?.finished
                  ? "Scan complete"
                  : scanRunning
                    ? "Scanning order filings…"
                    : "Scan"}
            </span>
            <span className="fill-progress-pct">
              {scanStats?.pct ?? 0}%
            </span>
          </div>
          <div className="fill-progress-track">
            <div
              className="fill-progress-bar"
              style={{ width: `${scanStats?.pct ?? 0}%` }}
            />
          </div>
          <p className="fill-progress-detail">
            {scanStats
              ? `${scanStats.done}/${scanStats.total || 0} pending · ${scanStats.pass} PASS · ${scanStats.fail} FAIL · skipped ${scanStats.skipped} in DB${
                  scanStats.round ? ` · batch ${scanStats.round}` : ""
                }`
              : "Starting…"}
          </p>
        </div>
      ) : null}

      <section className="obiq-rec" aria-label="How to use">
        <h2 className="obiq-rec-title">Recommendation</h2>
        <ul className="obiq-rec-list">
          <li>
            This lane owns <strong>order wins</strong> (MarketIQ excludes them).
          </li>
          <li>
            <strong>PASS</strong> only when awarding entity, order size,
            execution, and{" "}
            <strong>Order/Sales ≥ {passMinPct}%</strong> (order ₹ Cr ÷ annual
            sales ₹ Cr).
          </li>
          <li>
            Low ratios vs sales are noise (FAIL) — keep material wins only.
          </li>
          <li>
            Refresh → Scan &amp; Analyse pending PDFs, or use the PDF lab for a
            single filing.
          </li>
          <li>
            <strong>Δ drift</strong> = price reaction after the news: LTP vs last
            close before the exchange filing day. Shows how the stock moved once
            the order hit the tape. Refresh drift to update.
          </li>
        </ul>
      </section>

      <section className="miq-lab" aria-label="PDF test lab">
        <div className="miq-lab-head">
          <h2 className="miq-lab-title">PDF test lab</h2>
          <p className="miq-lab-sub">
            Upload or paste an order-win PDF → Extract → Analyse for PASS / FAIL
            (Order/Sales ≥ {passMinPct}%).
          </p>
        </div>
        <div className="miq-lab-grid">
          <div className="miq-lab-field miq-lab-file">
            <span>PDF file</span>
            <input
              ref={labFileRef}
              className="miq-lab-file-input"
              type="file"
              accept="application/pdf,.pdf"
              disabled={labBusy != null}
              onChange={(e) => {
                const f = e.target.files?.[0] || null;
                setLabFile(f);
                setLabExtract(null);
                setLabResult(null);
                setLabError(null);
              }}
            />
            <div className="miq-lab-upload-row">
              <button
                type="button"
                className="miq-upload-btn"
                disabled={labBusy != null}
                onClick={() => labFileRef.current?.click()}
              >
                Upload PDF
              </button>
              {labFile ? (
                <button
                  type="button"
                  className="clear-filter"
                  disabled={labBusy != null}
                  onClick={() => {
                    setLabFile(null);
                    if (labFileRef.current) labFileRef.current.value = "";
                    setLabExtract(null);
                    setLabResult(null);
                  }}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <em className="miq-lab-fname">
              {labFile ? labFile.name : "No file chosen — click Upload PDF"}
            </em>
          </div>
          <label className="miq-lab-field">
            <span>Or PDF URL</span>
            <input
              className="buyback-url-input"
              type="url"
              placeholder="https://nsearchives.nseindia.com/…pdf"
              value={labUrl}
              disabled={labBusy != null}
              onChange={(e) => setLabUrl(e.target.value)}
            />
          </label>
          <label className="miq-lab-field">
            <span>Ticker (optional)</span>
            <input
              className="buyback-url-input"
              value={labTicker}
              disabled={labBusy != null}
              onChange={(e) => setLabTicker(e.target.value.toUpperCase())}
              placeholder="SYMBOL"
            />
          </label>
        </div>
        <div className="miq-lab-actions">
          <button
            type="button"
            className="chip tag-chip"
            disabled={labBusy != null || (!labFile && !labUrl.trim())}
            onClick={() => void runLabExtract()}
          >
            {labBusy === "extract" ? "Extracting…" : "1 · Extract PDF"}
          </button>
          <button
            type="button"
            className="chip chip-scan tag-chip"
            disabled={labBusy != null || (!labFile && !labUrl.trim())}
            onClick={() => void runLabAnalyse()}
          >
            {labBusy === "analyse" ? "Analysing…" : "2 · Analyse"}
          </button>
        </div>
        {labError ? (
          <p className="buyback-status" role="alert">
            {labError}
          </p>
        ) : null}
        {labExtract ? (
          <div className="miq-lab-out">
            <div className="miq-lab-out-meta">
              Extracted · {labExtract.engine} · {labExtract.text_chars} chars
            </div>
            <pre className="miq-lab-text">{labExtract.text_excerpt}</pre>
          </div>
        ) : null}
        {labResult ? (
          <div className="miq-lab-result">
            <div className="miq-lab-out-meta">
              Analysed · {labResult.engine} ·{" "}
              <span className={`obiq-pill obiq-${labResult.decision}`}>
                {labResult.decision.toUpperCase()}
              </span>
              {labResult.extract.order_to_sales_pct != null
                ? ` · Order/Sales ${fmtPct(labResult.extract.order_to_sales_pct)}`
                : ""}
            </div>
            {labResult.why ? (
              <p className="miq-why">{labResult.why}</p>
            ) : null}
            <table className="miq-table miq-lab-preview-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Awarding</th>
                  <th>Size</th>
                  <th>Execution</th>
                  <th>Order/Sales</th>
                  <th>Δ drift</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="miq-td-co">
                    <CompanyTvLink
                      ticker={labResult.extract.ticker || labTicker}
                      company={
                        labResult.extract.company ||
                        labResult.extract.ticker ||
                        labTicker
                      }
                    />
                    <div className="miq-co-meta">
                      <span>
                        {(labResult.extract.ticker || labTicker || "—").toUpperCase()}
                      </span>
                      {labResult.extract.order_date ? (
                        <>
                          <span className="miq-dot">·</span>
                          <span className="miq-co-date">
                            <IconCalendar />
                            {fmtDate(labResult.extract.order_date)}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </td>
                  <td>{labResult.extract.awarding_entity}</td>
                  <td>
                    {labResult.extract.order_size}
                    {labResult.extract.order_size_cr != null
                      ? ` (₹${fmtNum(labResult.extract.order_size_cr)} Cr)`
                      : ""}
                  </td>
                  <td>{labResult.extract.execution}</td>
                  <td>
                    {fmtPct(labResult.extract.order_to_sales_pct)}
                    {labResult.extract.sales_cr != null
                      ? ` · sales ₹${fmtNum(labResult.extract.sales_cr)} Cr`
                      : ""}
                  </td>
                  <td className="obiq-td-drift">
                    <DriftTag pct={labResult.extract.drift_pct} />
                    <div className="miq-co-meta">
                      LTP {fmtNum(labResult.extract.ltp, 2)}
                      {labResult.extract.baseline_close != null
                        ? ` · pre-news ${fmtNum(labResult.extract.baseline_close, 2)}`
                        : ""}
                    </div>
                  </td>
                  <td>
                    <span className={`obiq-pill obiq-${labResult.decision}`}>
                      {labResult.decision.toUpperCase()}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <div className="miq-search-row">
        <input
          className="buyback-url-input miq-search"
          type="search"
          placeholder="Search company, symbol, or awarding entity…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void fetchAnnounced();
            }
          }}
        />
      </div>

      <div className="miq-toolbar">
        <div className="filter-bar-main">
          <span className="scan-filter-label">Decision</span>
          {(
            [
              ["all", "All"],
              ["pass", "PASS"],
              ["fail", "FAIL"],
              ["pending", "Pending"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`chip tag-chip ${decisionFilter === id ? "on" : ""}`}
              onClick={() => {
                setDecisionFilter(id);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="chip tag-chip miq-date-chip">
          Order filings · last {days}d · PASS ≥{passMinPct}%
        </span>
      </div>

      {error ? (
        <p className="buyback-status" role="alert">
          {error}
        </p>
      ) : (
        <p className="buyback-status" role="status">
          {busy
            ? "Loading order announcements…"
            : statusNote
              ? statusNote
              : `${feed.length} · NSE + BSE order / LOI / award filings`}
        </p>
      )}

      <div className="table-wrap miq-table-wrap">
        <table className="miq-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Details</th>
              <th>Awarding</th>
              <th>Order / Sales</th>
              <th>Δ drift</th>
              <th>PDF</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="miq-td-details">
                  No rows — refresh orders or widen days.
                </td>
              </tr>
            ) : (
              pageRows.map((row) => {
                const href = pdfHref(row.url);
                const busyRow = analyseBusyKey === row.key;
                return (
                  <tr key={row.key}>
                    <td className="miq-td-co">
                      <CompanyTvLink
                        ticker={row.ticker}
                        company={row.company}
                      />
                      <div className="miq-co-meta">
                        <span>{row.ticker}</span>
                        <span className="miq-dot">·</span>
                        <span className="miq-co-date">
                          <IconCalendar />
                          {row.dateLabel}
                        </span>
                      </div>
                      {row.decision === "pending" || row.decision === "fail" ? (
                        <button
                          type="button"
                          className="miq-row-analyse"
                          disabled={analysing || !row.url}
                          onClick={() => void analyseRow(row)}
                        >
                          {busyRow ? "Analysing…" : "Analyse"}
                        </button>
                      ) : null}
                    </td>
                    <td className="miq-td-details">
                      <div className="miq-headline">{row.headline}</div>
                      <div className="miq-summary">
                        Size {row.order_size}
                        {row.order_size_cr != null
                          ? ` · ₹${fmtNum(row.order_size_cr)} Cr`
                          : ""}
                        {" · "}
                        Exec {row.execution}
                      </div>
                      {row.why ? <div className="miq-why">{row.why}</div> : null}
                    </td>
                    <td>
                      <span className="miq-cat-pill">{row.awarding_entity}</span>
                    </td>
                    <td>
                      <div className="obiq-ratio">
                        {fmtPct(row.order_to_sales_pct)}
                      </div>
                      <div className="miq-co-meta">
                        sales ₹{fmtNum(row.sales_cr)} Cr
                      </div>
                    </td>
                    <td className="obiq-td-drift">
                      <DriftTag pct={row.drift_pct} />
                      <div className="miq-co-meta">
                        LTP {fmtNum(row.ltp, 2)}
                        {row.baseline_close != null
                          ? ` · pre-news ${fmtNum(row.baseline_close, 2)}`
                          : ""}
                      </div>
                    </td>
                    <td>
                      {href ? (
                        <a
                          className="miq-icon-btn"
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          title="Open PDF"
                        >
                          <IconDownload />
                        </a>
                      ) : (
                        <span className="miq-icon-btn is-disabled" title="No PDF">
                          <IconDownload />
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`obiq-pill obiq-${row.decision}`}>
                        {row.decision.toUpperCase()}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 ? (
        <div className="miq-pager">
          <button
            type="button"
            className="chip tag-chip"
            disabled={safePage <= 1}
            onClick={() => setPage(1)}
          >
            First
          </button>
          <button
            type="button"
            className="chip tag-chip"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <span className="chip tag-chip">
            {safePage} / {pageCount}
          </span>
          <button
            type="button"
            className="chip tag-chip"
            disabled={safePage >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          >
            Next
          </button>
          <button
            type="button"
            className="chip tag-chip"
            disabled={safePage >= pageCount}
            onClick={() => setPage(pageCount)}
          >
            Last
          </button>
        </div>
      ) : null}
    </div>
  );
}
