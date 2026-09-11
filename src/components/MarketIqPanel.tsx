"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tradingviewUrl } from "@/lib/links";
import { announcementDedupeKey } from "@/lib/announcement-dedupe";

type MarketIqHit = {
  ticker: string;
  company: string | null;
  title: string;
  url: string | null;
  announced_at: string | null;
  period: string | null;
  provider: string;
  index?: string;
};

type HistoryRow = {
  id: number;
  ticker: string | null;
  company: string | null;
  headline: string;
  summary: string;
  category: string;
  sentiment: string;
  sentiment_why?: string | null;
  confidence?: number | null;
  impact: number;
  announcement_date: string | null;
  source_url: string | null;
  screened_at: string;
};

type SentimentLabel = "bullish" | "bearish" | "neutral" | "pending";

const SENTIMENT_DISPLAY: Record<SentimentLabel, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  neutral: "Neutral",
  pending: "Pending",
};

function formatSentiment(s: SentimentLabel): string {
  return SENTIMENT_DISPLAY[s];
}

type AnalysedOverlay = {
  headline: string;
  summary: string;
  category: string;
  sentiment: SentimentLabel;
  confidence: number | null;
  impact: number | null;
  sentiment_why: string | null;
};

type FeedRow = {
  key: string;
  historyId: number | null;
  company: string;
  ticker: string;
  dateLabel: string;
  dateIso: string | null;
  headline: string;
  summary: string;
  category: string;
  sentiment: SentimentLabel;
  confidence: number | null;
  impact: number | null;
  sentiment_why: string | null;
  url: string | null;
  hit: MarketIqHit | null;
};

type SentimentFilter = "all" | "bullish" | "bearish" | "neutral";

const PAGE_SIZE = 25;
const CAT_PREVIEW = 20;

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

function normSentiment(
  raw: string | null | undefined,
): SentimentLabel {
  const s = (raw || "").trim().toLowerCase();
  // Accept common misspellings / aliases → canonical Bullish | Bearish | Neutral
  if (
    s === "bullish" ||
    s === "positive" ||
    s === "buy" ||
    s === "bull"
  ) {
    return "bullish";
  }
  if (
    s === "bearish" ||
    s === "berish" ||
    s === "negative" ||
    s === "sell" ||
    s === "bear"
  ) {
    return "bearish";
  }
  if (
    s === "neutral" ||
    s === "nuetral" ||
    s === "nutral" ||
    s === "mixed" ||
    s === "flat"
  ) {
    return "neutral";
  }
  return "pending";
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

function hitToFeed(h: MarketIqHit, i: number): FeedRow {
  return {
    key: `live-${h.ticker}-${h.announced_at}-${i}`,
    historyId: null,
    company: h.company || h.ticker,
    ticker: h.ticker,
    dateLabel: fmtDate(h.announced_at),
    dateIso: h.announced_at,
    headline: h.title,
    summary: h.title,
    category: "Unclassified",
    sentiment: "pending",
    confidence: null,
    impact: null,
    sentiment_why: null,
    url: h.url,
    hit: h,
  };
}

function histToFeed(h: HistoryRow): FeedRow {
  const iso = h.announcement_date || h.screened_at;
  return {
    key: `hist-${h.id}`,
    historyId: h.id,
    company: h.company || h.ticker || "—",
    ticker: (h.ticker || "—").toUpperCase(),
    dateLabel: fmtDate(iso),
    dateIso: iso,
    headline: h.headline,
    summary: h.summary || h.headline,
    category: h.category || "Unclassified",
    sentiment: normSentiment(h.sentiment),
    confidence:
      typeof h.confidence === "number" && Number.isFinite(h.confidence)
        ? h.confidence
        : null,
    impact:
      typeof h.impact === "number" &&
      (h.impact > 0 || normSentiment(h.sentiment) !== "pending")
        ? h.impact
        : null,
    sentiment_why: h.sentiment_why ?? null,
    url: h.source_url,
    hit: h.source_url
      ? {
          ticker: (h.ticker || "").toUpperCase(),
          company: h.company,
          title: h.headline,
          url: h.source_url,
          announced_at: h.announcement_date,
          period: null,
          provider: "history",
        }
      : null,
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

function IconTrendUp() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 17l6-6 4 4 7-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 7h6v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconTrendDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 7l6 6 4-4 7 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 17h6v-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconFlat() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 12h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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

function IconExternal() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M14 5h5v5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 5l-9 9" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function SentimentIcon({ s }: { s: SentimentLabel }) {
  if (s === "bullish") return <IconTrendUp />;
  if (s === "bearish") return <IconTrendDown />;
  if (s === "neutral") return <IconFlat />;
  return null;
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

function CompanyTvLink({
  ticker,
  company,
  market,
}: {
  ticker: string | null | undefined;
  company: string | null | undefined;
  market?: string | null;
}) {
  const label = (company || ticker || "—").trim() || "—";
  const sym = (ticker || "").trim().toUpperCase();
  if (!sym || sym === "—") {
    return <div className="miq-co-name">{label}</div>;
  }
  const idx = (market || "").trim().toLowerCase();
  const mk =
    idx === "sme" || idx.includes("bse")
      ? idx.includes("bse")
        ? "BSE"
        : "NSE SME"
      : "NSE";
  return (
    <a
      className="miq-co-name"
      href={tradingviewUrl(sym, mk)}
      target="_blank"
      rel="noreferrer"
      title={`${label} — TradingView`}
    >
      {label}
    </a>
  );
}

function applyOverlay(
  row: FeedRow,
  overlay: AnalysedOverlay | undefined,
): FeedRow {
  if (!overlay) return row;
  return {
    ...row,
    headline: overlay.headline || row.headline,
    summary: overlay.summary || row.summary,
    category: overlay.category || row.category,
    sentiment: overlay.sentiment,
    confidence: overlay.confidence,
    impact: overlay.impact,
    sentiment_why: overlay.sentiment_why,
  };
}

type LabExtract = {
  engine: string;
  text_chars: number;
  text_excerpt: string;
};

type LabResult = {
  engine: string;
  text_chars: number;
  text_excerpt: string;
  extract: {
    ticker: string | null;
    company: string | null;
    headline: string;
    summary: string;
    category: string;
    sentiment: string;
    confidence: number;
    impact: number;
    sentiment_why: string | null;
    announcement_date: string | null;
    score_trace?: Record<string, unknown>;
  };
};

export function MarketIqPanel() {
  const [days, setDays] = useState(1);
  const [q, setQ] = useState("");
  const [catQ, setCatQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [analyseBusyKey, setAnalyseBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [hits, setHits] = useState<MarketIqHit[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [overlay, setOverlay] = useState<Record<string, AnalysedOverlay>>({});
  const [categories, setCategories] = useState<string[]>([]);
  const [category, setCategory] = useState("");
  const [sentiment, setSentiment] = useState<SentimentFilter>("all");
  const [showAllCats, setShowAllCats] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(1);
  const [labFile, setLabFile] = useState<File | null>(null);
  const [labUrl, setLabUrl] = useState("");
  const [labTicker, setLabTicker] = useState("");
  const [labCompany, setLabCompany] = useState("");
  const [labBusy, setLabBusy] = useState<"extract" | "analyse" | null>(null);
  const [labError, setLabError] = useState<string | null>(null);
  const [labExtract, setLabExtract] = useState<LabExtract | null>(null);
  const [labResult, setLabResult] = useState<LabResult | null>(null);
  const labFileRef = useRef<HTMLInputElement | null>(null);
  const scanStopRef = useRef(false);
  const [scanRunning, setScanRunning] = useState(false);
  const [scanStats, setScanStats] = useState<{
    ok: number;
    fail: number;
    skipped: number;
    remaining: number;
    round: number;
  } | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/marketiq?history=1&limit=200");
      const json = (await res.json()) as { history?: HistoryRow[] };
      setHistory(json.history ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchAnnounced = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatusNote(null);
    try {
      const params = new URLSearchParams({
        announced: "1",
        days: String(days),
      });
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/marketiq?${params}`);
      const json = (await res.json()) as {
        ok?: boolean;
        sources?: MarketIqHit[];
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
      setHits([]);
      setLive(false);
    } finally {
      setBusy(false);
    }
  }, [days, q]);

  useEffect(() => {
    void loadHistory();
    void fetch("/api/marketiq?categories=1")
      .then((r) => r.json())
      .then((j: { categories?: string[] }) => {
        setCategories(j.categories ?? []);
      })
      .catch(() => setCategories([]));
    void fetchAnnounced();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveHits = useCallback(async () => {
    if (!hits.length) return;
    setSaveBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/marketiq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", sources: hits }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        history?: HistoryRow[];
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.error || "Save failed");
        return;
      }
      if (json.history) setHistory(json.history);
      else void loadHistory();
      setStatusNote(`Saved ${hits.length} announcements`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaveBusy(false);
    }
  }, [hits, loadHistory]);

  const ingestAnalyseResult = useCallback(
    (result: {
      ok?: boolean;
      extract?: {
        headline?: string;
        summary?: string;
        category?: string;
        sentiment?: string;
        confidence?: number;
        impact?: number;
        sentiment_why?: string | null;
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
      if (!result.ok || !result.extract) return;
      const ex = result.extract;
      const entry: AnalysedOverlay = {
        headline: ex.headline || "",
        summary: ex.summary || "",
        category: ex.category || "Unclassified",
        sentiment: normSentiment(ex.sentiment),
        confidence:
          typeof ex.confidence === "number" ? ex.confidence : null,
        impact: typeof ex.impact === "number" ? ex.impact : null,
        sentiment_why: ex.sentiment_why ?? null,
      };
      const keys = overlayKeysFor({
        url: result.source_url || seed?.url,
        ticker: seed?.ticker,
        title: seed?.title || ex.headline,
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
        const body = row.hit
          ? {
              action: "analyse",
              url: row.hit.url,
              ticker: row.hit.ticker,
              company: row.hit.company,
              title: row.hit.title,
              announced_at: row.hit.announced_at,
              historyId: row.historyId,
            }
          : {
              action: "analyse",
              url: row.url,
              ticker: row.ticker,
              company: row.company,
              title: row.headline,
              announced_at: row.dateIso,
              historyId: row.historyId,
            };
        const res = await fetch("/api/marketiq", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          extract?: AnalysedOverlay & {
            sentiment?: string;
            confidence?: number;
            impact?: number;
            sentiment_why?: string | null;
          };
          source_url?: string | null;
          id?: number;
          history?: HistoryRow[];
          engine?: string;
        };
        if (!res.ok || !json.ok) {
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
        setStatusNote(
          `Analysed · ${json.extract?.sentiment || "?"} · impact ${json.extract?.impact ?? "—"} · ${json.engine || "ok"}`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Analyse failed");
      } finally {
        setAnalyseBusyKey(null);
      }
    },
    [ingestAnalyseResult, loadHistory],
  );

  const feed = useMemo(() => {
    const histByUrl = new Map<string, HistoryRow>();
    for (const h of history) {
      const u = h.source_url?.trim();
      if (!u) continue;
      // Newest history first in list — keep first seen.
      if (!histByUrl.has(u)) histByUrl.set(u, h);
    }

    const rows =
      hits.length > 0
        ? hits.map((h, i) => {
            const live = hitToFeed(h, i);
            const hist = h.url?.trim() ? histByUrl.get(h.url.trim()) : undefined;
            if (!hist) return live;
            const sent = normSentiment(hist.sentiment);
            if (sent === "pending") return live;
            // Merge analysed history onto the live NSE row so Refresh doesn't wipe scores.
            const merged = histToFeed(hist);
            return {
              ...merged,
              key: live.key,
              hit: live.hit,
              dateLabel: live.dateLabel || merged.dateLabel,
              dateIso: live.dateIso || merged.dateIso,
            };
          })
        : history.map(histToFeed);

    const withOverlay = rows.map((r) => {
      const keys = overlayKeysFor({
        url: r.url,
        ticker: r.ticker,
        title: r.headline,
        historyId: r.historyId,
      });
      let o: AnalysedOverlay | undefined;
      for (const k of keys) {
        if (overlay[k]) {
          o = overlay[k];
          break;
        }
      }
      return applyOverlay(r, o);
    });

    const prefer = (a: FeedRow, b: FeedRow): FeedRow => {
      const rank = (r: FeedRow) => {
        let s = 0;
        if (r.sentiment !== "pending") s += 30;
        if ((r.impact ?? 0) > 0) s += 10;
        if (r.historyId != null) s += 5;
        if (r.url) s += 2;
        s += Math.min(3, Math.floor((r.summary || "").length / 80));
        return s;
      };
      const rb = rank(b);
      const ra = rank(a);
      if (rb > ra) return { ...b, url: b.url || a.url, hit: b.hit || a.hit };
      if (ra > rb) return { ...a, url: a.url || b.url, hit: a.hit || b.hit };
      // Tie: keep longer summary text
      const pick =
        (b.summary || "").length > (a.summary || "").length ? b : a;
      const other = pick === a ? b : a;
      return { ...pick, url: pick.url || other.url, hit: pick.hit || other.hit };
    };

    const byIdentity = new Map<string, FeedRow>();
    for (const r of withOverlay) {
      const key = announcementDedupeKey({
        ticker: r.ticker,
        company: r.company,
        title: r.headline,
        day: r.dateIso,
      });
      const prev = byIdentity.get(key);
      byIdentity.set(key, prev ? prefer(prev, r) : r);
    }

    const qn = q.trim().toLowerCase();
    const cat = category.trim().toLowerCase();
    return [...byIdentity.values()]
      .filter((r) => {
        if (sentiment !== "all" && r.sentiment !== sentiment) {
          return false;
        }
        if (cat) {
          if (
            !r.category.toLowerCase().includes(cat) &&
            !r.headline.toLowerCase().includes(cat)
          ) {
            return false;
          }
        }
        if (qn) {
          const hay =
            `${r.company} ${r.ticker} ${r.headline} ${r.summary}`.toLowerCase();
          if (!hay.includes(qn)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ad = a.dateIso ? Date.parse(a.dateIso) : 0;
        const bd = b.dateIso ? Date.parse(b.dateIso) : 0;
        return bd - ad;
      });
  }, [hits, history, q, category, sentiment, overlay]);

  const pages = Math.max(1, Math.ceil(feed.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const pageRows = feed.slice(
    (pageSafe - 1) * PAGE_SIZE,
    pageSafe * PAGE_SIZE,
  );

  const catFiltered = useMemo(() => {
    const n = catQ.trim().toLowerCase();
    if (!n) return categories;
    return categories.filter((c) => c.toLowerCase().includes(n));
  }, [categories, catQ]);

  const catVisible = showAllCats
    ? catFiltered
    : catFiltered.slice(0, CAT_PREVIEW);

  const pageButtons = useMemo(() => {
    const nums: number[] = [];
    const start = Math.max(1, pageSafe - 2);
    const end = Math.min(pages, start + 4);
    for (let i = start; i <= end; i++) nums.push(i);
    return nums;
  }, [pageSafe, pages]);

  const analysing = analyseBusyKey != null || labBusy != null || scanRunning;

  const stopScan = useCallback(() => {
    scanStopRef.current = true;
    setStatusNote("Stopping scan after current batch…");
  }, []);

  const scanAllAnnouncements = useCallback(async () => {
    if (scanRunning) return;
    scanStopRef.current = false;
    setScanRunning(true);
    setError(null);
    setScanStats({ ok: 0, fail: 0, skipped: 0, remaining: 0, round: 0 });
    setStatusNote("Starting scan of all announcements…");

    let ok = 0;
    let fail = 0;
    let skipped = 0;
    let round = 0;

    try {
      // Prefer live NSE list; else server rediscovers for selected days.
      const sources: MarketIqHit[] =
        hits.length > 0
          ? hits
          : history
              .filter((h) => h.source_url || h.headline)
              .map((h) => ({
                ticker: (h.ticker || "").toUpperCase(),
                company: h.company,
                title: h.headline,
                url: h.source_url,
                announced_at: h.announcement_date,
                period: null,
                provider: "history",
              }));

      while (!scanStopRef.current) {
        round += 1;
        setStatusNote(
          `Scanning batch ${round}… (${ok} ok · ${fail} fail · ${skipped} skipped)`,
        );
        const res = await fetch("/api/marketiq", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "scan",
            days,
            q: q.trim() || null,
            limit: 3,
            pendingOnly: true,
            skipOcr: true,
            sources: sources.length ? sources : null,
          }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          attempted?: number;
          analysed?: number;
          failed?: number;
          skipped?: number;
          remaining?: number;
          total_candidates?: number;
          note?: string;
          results?: Array<{
            ok?: boolean;
            extract?: {
              headline?: string;
              summary?: string;
              category?: string;
              sentiment?: string;
              confidence?: number;
              impact?: number;
              sentiment_why?: string | null;
            };
            source_url?: string | null;
            id?: number;
            error?: string;
          }>;
          history?: HistoryRow[];
        };

        if (!res.ok || json.ok === false) {
          setError(json.error || "Scan batch failed");
          break;
        }

        skipped = Math.max(skipped, json.skipped ?? skipped);
        ok += json.analysed ?? 0;
        fail += json.failed ?? 0;
        const remaining = json.remaining ?? 0;
        setScanStats({
          ok,
          fail,
          skipped,
          remaining,
          round,
        });

        for (const r of json.results ?? []) {
          ingestAnalyseResult(r, {
            url: r.source_url,
            title: r.extract?.headline,
            historyId: r.id ?? null,
          });
        }
        if (json.history) setHistory(json.history);

        if ((json.attempted ?? 0) === 0 || remaining === 0) {
          setStatusNote(
            scanStopRef.current
              ? `Scan stopped · ${ok} analysed · ${fail} failed · ${skipped} already scored`
              : `Scan complete · ${ok} analysed · ${fail} failed · ${skipped} already scored`,
          );
          break;
        }

        setStatusNote(
          `Scanned ${ok + fail} · ${remaining} remaining · batch ${round}`,
        );
      }

      if (scanStopRef.current) {
        setStatusNote(
          `Scan stopped · ${ok} analysed · ${fail} failed · ${skipped} already scored`,
        );
      }
      void loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanRunning(false);
      scanStopRef.current = false;
    }
  }, [scanRunning, hits, history, days, q, ingestAnalyseResult, loadHistory]);

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
      const res = await fetch("/api/marketiq", {
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
      const res = await fetch("/api/marketiq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyse",
          url: labUrl.trim() || null,
          bufferBase64: bufferBase64 || null,
          ticker: labTicker.trim() || null,
          company: labCompany.trim() || null,
        }),
      });
      const json = (await res.json()) as LabResult & {
        ok?: boolean;
        error?: string;
        history?: HistoryRow[];
      };
      if (!res.ok || !json.ok || !json.extract) {
        setLabError(json.error || "Analyse failed");
        return;
      }
      setLabResult({
        engine: json.engine,
        text_chars: json.text_chars,
        text_excerpt: json.text_excerpt,
        extract: json.extract,
      });
      if (json.text_excerpt) {
        setLabExtract({
          engine: json.engine.replace(/\+llm$/, ""),
          text_chars: json.text_chars,
          text_excerpt: json.text_excerpt,
        });
      }
      if (json.history) setHistory(json.history);
      else void loadHistory();
    } catch (e) {
      setLabError(e instanceof Error ? e.message : "Analyse failed");
    } finally {
      setLabBusy(null);
    }
  }, [labFile, labUrl, labTicker, labCompany, loadHistory]);

  return (
    <section className="miq panel">
      <header className="miq-head">
        <div>
          <h1 className="miq-title">Corporate Announcements</h1>
          <p className="miq-sub">
            PDF extract → sentiment / impact (formula + Mistral).
          </p>
        </div>
        <div className="miq-head-actions">
          <span className={`miq-live ${live || busy ? "on" : ""}`}>
            <i className="miq-live-dot" aria-hidden />
            {busy ? "Fetching…" : live ? "Live Data" : "Cached"}
          </span>
          <button
            type="button"
            className="chip tag-chip"
            disabled={busy || analysing}
            onClick={() => void fetchAnnounced()}
          >
            {busy ? "Refreshing…" : "Refresh NSE"}
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
          {hits.length > 0 ? (
            <button
              type="button"
              className="chip tag-chip"
              disabled={saveBusy || analysing}
              onClick={() => void saveHits()}
            >
              {saveBusy ? "Saving…" : `Save ${hits.length}`}
            </button>
          ) : null}
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
                : "Scan & analyse all pending announcements (batches of 3)"
            }
          >
            {scanRunning
              ? `Stop · ${scanStats?.ok ?? 0} ok${
                  scanStats?.remaining != null
                    ? ` · ${scanStats.remaining} left`
                    : ""
                }`
              : "Scan & Analyse"}
          </button>
        </div>
      </header>

      <section className="miq-lab" aria-label="PDF test lab">
        <div className="miq-lab-head">
          <h2 className="miq-lab-title">PDF test lab</h2>
          <p className="miq-lab-sub">
            Upload a filing → Extract text → Analyse for Bullish / Bearish /
            Neutral + impact.
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
              placeholder="PIRAMALFIN"
            />
          </label>
          <label className="miq-lab-field">
            <span>Company (optional)</span>
            <input
              className="buyback-url-input"
              value={labCompany}
              disabled={labBusy != null}
              onChange={(e) => setLabCompany(e.target.value)}
              placeholder="Piramal Finance Limited"
            />
          </label>
        </div>
        <div className="miq-lab-actions">
          <button
            type="button"
            className="chip tag-chip"
            disabled={labBusy != null || (!labFile && !labUrl.trim())}
            onClick={() => void runLabExtract()}
            title="Fast pdf-parse first; OCR only if little text"
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
              Analysed · {labResult.engine} · impact {labResult.extract.impact}
            </div>
            <table className="miq-table miq-lab-preview-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Details</th>
                  <th>Category</th>
                  <th>Sentiment</th>
                  <th>Download</th>
                  <th>Impact</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="miq-td-co">
                    <CompanyTvLink
                      ticker={labResult.extract.ticker || labTicker}
                      company={
                        labResult.extract.company ||
                        labCompany ||
                        labResult.extract.ticker ||
                        labTicker
                      }
                    />
                    <div className="miq-co-meta">
                      <span>
                        {(labResult.extract.ticker || labTicker || "—").toUpperCase()}
                      </span>
                      {labResult.extract.announcement_date ? (
                        <>
                          <span className="miq-dot">·</span>
                          <span className="miq-co-date">
                            <IconCalendar />
                            {fmtDate(labResult.extract.announcement_date)}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </td>
                  <td className="miq-td-details">
                    <div className="miq-headline">
                      {labResult.extract.headline}
                    </div>
                    <div className="miq-summary">{labResult.extract.summary}</div>
                    {labResult.extract.sentiment_why ? (
                      <div className="miq-why">
                        {labResult.extract.sentiment_why}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span className="miq-cat-pill">
                      {labResult.extract.category}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`miq-sent-pill miq-sent-${normSentiment(labResult.extract.sentiment)}`}
                    >
                      <SentimentIcon
                        s={normSentiment(labResult.extract.sentiment)}
                      />
                      {formatSentiment(
                        normSentiment(labResult.extract.sentiment),
                      )}
                      {labResult.extract.confidence != null
                        ? ` ${labResult.extract.confidence}%`
                        : ""}
                    </span>
                  </td>
                  <td>
                    {labUrl.trim() ? (
                      <a
                        className="miq-icon-btn"
                        href={labUrl.trim()}
                        target="_blank"
                        rel="noreferrer"
                        title="Open PDF"
                      >
                        <IconDownload />
                      </a>
                    ) : (
                      <span className="miq-icon-btn is-disabled" title="Upload">
                        <IconDownload />
                      </span>
                    )}
                  </td>
                  <td className="miq-td-impact">
                    <span className="miq-impact-ring">
                      {labResult.extract.impact}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
            {labResult.extract.score_trace ? (
              <pre className="miq-lab-trace">
                {JSON.stringify(labResult.extract.score_trace, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className="miq-search-row">
        <input
          className="buyback-url-input miq-search"
          type="search"
          placeholder="Search company, symbol, or keywords…"
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
          <span className="scan-filter-label">Sentiment</span>
          {(
            [
              ["all", "All"],
              ["bullish", "Bullish"],
              ["bearish", "Bearish"],
              ["neutral", "Neutral"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`chip tag-chip ${sentiment === id ? "on" : ""}`}
              onClick={() => {
                setSentiment(id);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="chip tag-chip miq-date-chip">
          Announcement Date · last {days}d
        </span>
      </div>

      <div className="miq-cats">
        <input
          className="buyback-url-input miq-cat-search"
          type="search"
          placeholder="Search categories…"
          value={catQ}
          onChange={(e) => setCatQ(e.target.value)}
        />
        <div className="filter-bar-main miq-cat-chips">
          <button
            type="button"
            className={`chip tag-chip ${!category ? "on" : ""}`}
            onClick={() => {
              setCategory("");
              setPage(1);
            }}
          >
            All Categories
          </button>
          {catVisible.map((c) => (
            <button
              key={c}
              type="button"
              className={`chip tag-chip ${category === c ? "on" : ""}`}
              title={c}
              onClick={() => {
                setCategory(c);
                setPage(1);
              }}
            >
              {c}
            </button>
          ))}
        </div>
        {catFiltered.length > CAT_PREVIEW ? (
          <button
            type="button"
            className="clear-filter miq-show-all"
            onClick={() => setShowAllCats((v) => !v)}
          >
            {showAllCats ? "Show less" : `Show all (${catFiltered.length})`}
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="buyback-status" role="alert">
          {error}
        </p>
      ) : (
        <p className="buyback-status" role="status">
          {busy
            ? "Loading announcements…"
            : statusNote
              ? statusNote
              : `${feed.length} · NSE corporate-announcements (equities + SME)`}
        </p>
      )}

      <div className="table-wrap miq-table-wrap">
        <table className="miq-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Details</th>
              <th>Category</th>
              <th>Sentiment</th>
              <th>Download</th>
              <th>Impact</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty-state">
                  {busy
                    ? "Loading…"
                    : "No announcements match these filters. Try Refresh NSE."}
                </td>
              </tr>
            ) : (
              pageRows.map((r) => {
                const open = !!expanded[r.key];
                const long = r.summary.length > 160;
                const body =
                  open || !long
                    ? r.summary
                    : `${r.summary.slice(0, 160).trim()}…`;
                const rowBusy = analyseBusyKey === r.key;
                return (
                  <tr key={r.key}>
                    <td className="miq-td-co">
                      <CompanyTvLink
                        ticker={r.ticker}
                        company={r.company}
                        market={r.hit?.index}
                      />
                      <div className="miq-co-meta">
                        <span>{r.ticker}</span>
                        <span className="miq-dot">·</span>
                        <span className="miq-co-date">
                          <IconCalendar />
                          {r.dateLabel}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="miq-row-analyse"
                        disabled={analysing}
                        onClick={() => void analyseRow(r)}
                      >
                        {rowBusy ? "Analysing…" : "Analyse"}
                      </button>
                    </td>
                    <td className="miq-td-details">
                      <div className="miq-headline">{r.headline}</div>
                      {r.summary !== r.headline || long ? (
                        <>
                          <div className="miq-summary">{body}</div>
                          {r.sentiment_why ? (
                            <div className="miq-why">{r.sentiment_why}</div>
                          ) : null}
                          {long ? (
                            <button
                              type="button"
                              className="miq-readmore"
                              onClick={() =>
                                setExpanded((prev) => ({
                                  ...prev,
                                  [r.key]: !open,
                                }))
                              }
                            >
                              {open ? "Read less" : "Read more"}
                            </button>
                          ) : null}
                        </>
                      ) : r.sentiment_why ? (
                        <div className="miq-why">{r.sentiment_why}</div>
                      ) : null}
                    </td>
                    <td>
                      <span className="miq-cat-pill">{r.category}</span>
                    </td>
                    <td>
                      <span
                        className={`miq-sent-pill miq-sent-${r.sentiment}`}
                        title={r.sentiment_why || undefined}
                      >
                        <SentimentIcon s={r.sentiment} />
                        {formatSentiment(r.sentiment)}
                        {r.sentiment !== "pending" && r.confidence != null
                          ? ` ${r.confidence}%`
                          : ""}
                      </span>
                    </td>
                    <td>
                      {r.url ? (
                        <a
                          className="miq-icon-btn"
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          title="Download PDF"
                        >
                          <IconDownload />
                        </a>
                      ) : (
                        <span className="miq-icon-btn is-disabled">—</span>
                      )}
                    </td>
                    <td className="miq-td-impact">
                      {r.impact != null ? (
                        <span className="miq-impact-ring">{r.impact}</span>
                      ) : (
                        <span className="miq-impact-ring is-empty">—</span>
                      )}
                      {r.url ? (
                        <a
                          className="miq-icon-btn"
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          title="Open filing"
                        >
                          <IconExternal />
                        </a>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {feed.length > 0 ? (
        <div className="miq-pager">
          <span className="buyback-status" style={{ margin: 0 }}>
            Page {pageSafe} of {pages}
            {feed.length ? ` · ${feed.length} rows` : ""}
          </span>
          <div className="filter-bar-main">
            <button
              type="button"
              className="chip tag-chip"
              disabled={pageSafe <= 1}
              onClick={() => setPage(1)}
            >
              First
            </button>
            <button
              type="button"
              className="chip tag-chip"
              disabled={pageSafe <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            {pageButtons.map((n) => (
              <button
                key={n}
                type="button"
                className={`chip tag-chip ${n === pageSafe ? "on" : ""}`}
                onClick={() => setPage(n)}
              >
                {n}
              </button>
            ))}
            <button
              type="button"
              className="chip tag-chip"
              disabled={pageSafe >= pages}
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
            >
              Next
            </button>
            <button
              type="button"
              className="chip tag-chip"
              disabled={pageSafe >= pages}
              onClick={() => setPage(pages)}
            >
              Last
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
