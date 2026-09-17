"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { announcementDedupeKey } from "@/lib/announcement-dedupe";
import { ANNOUNCED_DAY_OPTIONS } from "@/lib/announced-lookback";
import { isInvestorAnalystMeetAnnouncement } from "@/lib/investor-meet-announcement";
import { isPreferentialAnnouncement } from "@/lib/preferential-announcement";
import { matchMarketIqFundsInText, highlightMarketIqFundSegments } from "@/lib/marketiq-fund-aliases";
import { IqHintPanel } from "@/components/IqHintPanel";
import { CompanyWatchCell } from "@/components/CompanyWatchCell";
import { LiveNseFeedBadge } from "@/components/LiveNseFeedBadge";
import { LiveBseFeedBadge } from "@/components/LiveBseFeedBadge";
import { formatMcap } from "@/lib/types";
import { formatPeDisplay, ttmPeBandClass, ttmPeBandTitle } from "@/lib/valuation";

type MarketIqHit = {
  ticker: string;
  company: string | null;
  title: string;
  url: string | null;
  announced_at: string | null;
  period: string | null;
  provider: string;
  index?: string;
  mcap_cr?: number | null;
  pe_ttm?: number | null;
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
  funds_mentioned?: FundChip[];
  mcap_cr?: number | null;
  pe_ttm?: number | null;
};

type FundChip = {
  name: string;
  alias: string;
  chip_key: string;
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
  funds_mentioned?: FundChip[];
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
  funds_mentioned: FundChip[];
  mcap_cr: number | null;
  pe_ttm: number | null;
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
    funds_mentioned: [],
    mcap_cr: h.mcap_cr ?? null,
    pe_ttm: h.pe_ttm ?? null,
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
    funds_mentioned: Array.isArray(h.funds_mentioned) ? h.funds_mentioned : [],
    mcap_cr: h.mcap_cr ?? null,
    pe_ttm: h.pe_ttm ?? null,
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
    funds_mentioned:
      overlay.funds_mentioned && overlay.funds_mentioned.length
        ? overlay.funds_mentioned
        : row.funds_mentioned,
  };
}

function FundAliasChips({ funds }: { funds: FundChip[] }) {
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

/** Saved chips + live catalog rematch (so new aliases show without re-analyse). */
function resolveFundChips(row: {
  funds_mentioned?: FundChip[];
  headline?: string;
  summary?: string;
}): FundChip[] {
  const live = matchMarketIqFundsInText(row.summary || "", [
    row.headline || "",
  ]);
  const seen = new Set<string>();
  const out: FundChip[] = [];
  for (const f of [...(row.funds_mentioned || []), ...live]) {
    const key = (f.chip_key || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: f.name,
      alias: f.alias,
      chip_key: key,
    });
  }
  return out.sort((a, b) =>
    a.alias.localeCompare(b.alias, undefined, { sensitivity: "base" }),
  );
}

function FundHighlightedSummary({
  text,
  funds,
}: {
  text: string;
  funds: FundChip[];
}) {
  if (!funds.length) return <>{text}</>;
  const segs = highlightMarketIqFundSegments(text, funds);
  return (
    <>
      {segs.map((s, i) =>
        s.hit ? (
          <mark key={i} className="miq-fund-mark" title={s.chip_key}>
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
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
  const [days, setDays] = useState(2);
  const [useOcr, setUseOcr] = useState(false);
  const [q, setQ] = useState("");
  const [catQ, setCatQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [analyseBusyKey, setAnalyseBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [nseFeed, setNseFeed] = useState<NseFeedStatus | null>(null);
  const [bseFeed, setBseFeed] = useState<NseFeedStatus | null>(null);
  const [hits, setHits] = useState<MarketIqHit[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [overlay, setOverlay] = useState<Record<string, AnalysedOverlay>>({});
  const [categories, setCategories] = useState<string[]>([]);
  const [category, setCategory] = useState("");
  const [sentiment, setSentiment] = useState<SentimentFilter>("all");
  /** Topic chip: Reg-30 investor / analyst meet & call filings. */
  const [analystMeetOnly, setAnalystMeetOnly] = useState(false);
  const [preferentialOnly, setPreferentialOnly] = useState(false);
  const [showAllCats, setShowAllCats] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(1);
  const [labOpen, setLabOpen] = useState(false);
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
  const [scanningUrls, setScanningUrls] = useState<string[]>([]);
  const [scanStats, setScanStats] = useState<{
    ok: number;
    fail: number;
    skipped: number;
    remaining: number;
    round: number;
    total: number;
    done: number;
    pct: number;
    current: string[];
    finished?: boolean;
    errored?: boolean;
    partial?: boolean;
  } | null>(null);

  const announcedAbortRef = useRef<AbortController | null>(null);

  const loadHistory = useCallback(async (search?: string) => {
    try {
      const params = new URLSearchParams({
        history: "1",
        limit: "800",
      });
      const qq = (search ?? q).trim();
      if (qq) params.set("q", qq);
      const res = await fetch(`/api/marketiq?${params}`);
      const json = (await res.json()) as {
        history?: HistoryRow[];
        nse_feed?: NseFeedStatus;
        bse_feed?: NseFeedStatus;
      };
      setHistory(json.history ?? []);
      if (json.nse_feed) setNseFeed(json.nse_feed);
      if (json.bse_feed) setBseFeed(json.bse_feed);
    } catch {
      /* ignore */
    }
  }, [q]);

  // When the user searches, pull matching rows from DB (not only the newest window).
  // Clearing search reloads the recent window.
  useEffect(() => {
    const qq = q.trim();
    const t = window.setTimeout(() => {
      void loadHistory(qq);
    }, qq ? 280 : 0);
    return () => window.clearTimeout(t);
  }, [q, loadHistory]);

  const fetchAnnounced = useCallback(async (): Promise<MarketIqHit[]> => {
    announcedAbortRef.current?.abort();
    const ac = new AbortController();
    announcedAbortRef.current = ac;
    setBusy(true);
    setError(null);
    setStatusNote("1/3 Get — fetching new announcements from NSE…");
    try {
      const params = new URLSearchParams({
        announced: "1",
        days: String(days),
        fresh: "1",
      });
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/marketiq?${params}`, {
        signal: ac.signal,
      });
      const json = (await res.json()) as {
        ok?: boolean;
        sources?: MarketIqHit[];
        error?: string;
        cached?: boolean;
        nse_feed?: NseFeedStatus;
        bse_feed?: NseFeedStatus;
      };
      if (ac.signal.aborted) return [];
      if (json.nse_feed) setNseFeed(json.nse_feed);
      if (json.bse_feed) setBseFeed(json.bse_feed);
      if (!res.ok || json.ok === false) {
        setError(json.error || "Fetch failed");
        setHits([]);
        setLive(false);
        return [];
      }
      const sources = json.sources ?? [];
      setHits(sources);
      setLive(true);
      setPage(1);
      setStatusNote(`1/3 Get — ${sources.length} announcements`);
      return sources;
    } catch (e) {
      if (ac.signal.aborted) return [];
      setError(e instanceof Error ? e.message : "Fetch failed");
      setHits([]);
      setLive(false);
      return [];
    } finally {
      if (!ac.signal.aborted) setBusy(false);
    }
  }, [days, q]);

  useEffect(() => {
    void loadHistory();
    setStatusNote("Click Run — Get → Save → Analyse (auto-saves to DB)");
    const t = window.setTimeout(() => {
      void fetch("/api/marketiq?categories=1")
        .then((r) => r.json())
        .then((j: { categories?: string[] }) => {
          setCategories(j.categories ?? []);
        })
        .catch(() => setCategories([]));
    }, 200);
    return () => {
      announcedAbortRef.current?.abort();
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveHits = useCallback(
    async (sources: MarketIqHit[]): Promise<number> => {
      if (!sources.length) return 0;
      setSaveBusy(true);
      setError(null);
      setStatusNote(`2/3 Save — writing ${sources.length} rows to DB…`);
      try {
        const res = await fetch("/api/marketiq", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "save", sources }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          saved?: number;
          history?: HistoryRow[];
          error?: string;
        };
        if (!res.ok || !json.ok) {
          setError(json.error || "Save failed");
          return 0;
        }
        if (json.history) setHistory(json.history);
        else void loadHistory();
        const n = typeof json.saved === "number" ? json.saved : sources.length;
        setStatusNote(`2/3 Save — ${n} new row${n === 1 ? "" : "s"} in DB`);
        return n;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed");
        return 0;
      } finally {
        setSaveBusy(false);
      }
    },
    [loadHistory],
  );

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
        funds_mentioned?: FundChip[];
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
        funds_mentioned: Array.isArray(ex.funds_mentioned)
          ? ex.funds_mentioned
          : [],
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
            funds_mentioned?: FundChip[];
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
        const funds = json.extract?.funds_mentioned ?? [];
        setStatusNote(
          [
            `Analysed · ${json.extract?.sentiment || "?"}`,
            `impact ${json.extract?.impact ?? "—"}`,
            funds.length ? `${funds.length} funds` : null,
            json.engine || "ok",
          ]
            .filter(Boolean)
            .join(" · "),
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
      hits.length > 0 && !q.trim()
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
              mcap_cr: merged.mcap_cr ?? live.mcap_cr,
              pe_ttm: merged.pe_ttm ?? live.pe_ttm,
            };
          })
        : hits.length > 0 && q.trim()
          ? [
              ...hits.map((h, i) => {
                const live = hitToFeed(h, i);
                const hist = h.url?.trim()
                  ? histByUrl.get(h.url.trim())
                  : undefined;
                if (!hist) return live;
                const sent = normSentiment(hist.sentiment);
                if (sent === "pending") return live;
                const merged = histToFeed(hist);
                return {
                  ...merged,
                  key: live.key,
                  hit: live.hit,
                  dateLabel: live.dateLabel || merged.dateLabel,
                  dateIso: live.dateIso || merged.dateIso,
                  mcap_cr: merged.mcap_cr ?? live.mcap_cr,
                  pe_ttm: merged.pe_ttm ?? live.pe_ttm,
                };
              }),
              ...history.map(histToFeed),
            ]
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
        s += Math.min(5, r.funds_mentioned.length);
        return s;
      };
      const rb = rank(b);
      const ra = rank(a);
      if (rb > ra)
        return {
          ...b,
          url: b.url || a.url,
          hit: b.hit || a.hit,
          funds_mentioned: b.funds_mentioned.length
            ? b.funds_mentioned
            : a.funds_mentioned,
          mcap_cr: b.mcap_cr ?? a.mcap_cr,
          pe_ttm: b.pe_ttm ?? a.pe_ttm,
        };
      if (ra > rb)
        return {
          ...a,
          url: a.url || b.url,
          hit: a.hit || b.hit,
          funds_mentioned: a.funds_mentioned.length
            ? a.funds_mentioned
            : b.funds_mentioned,
          mcap_cr: a.mcap_cr ?? b.mcap_cr,
          pe_ttm: a.pe_ttm ?? b.pe_ttm,
        };
      // Tie: keep longer summary text
      const pick =
        (b.summary || "").length > (a.summary || "").length ? b : a;
      const other = pick === a ? b : a;
      return {
        ...pick,
        url: pick.url || other.url,
        hit: pick.hit || other.hit,
        funds_mentioned: pick.funds_mentioned.length
          ? pick.funds_mentioned
          : other.funds_mentioned,
        mcap_cr: pick.mcap_cr ?? other.mcap_cr,
        pe_ttm: pick.pe_ttm ?? other.pe_ttm,
      };
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
        if (analystMeetOnly) {
          if (
            !isInvestorAnalystMeetAnnouncement(
              r.category,
              r.headline,
              r.summary,
            )
          ) {
            return false;
          }
        }
        if (preferentialOnly) {
          if (
            !isPreferentialAnnouncement(r.category, r.headline, r.summary)
          ) {
            return false;
          }
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
  }, [hits, history, q, category, sentiment, analystMeetOnly, preferentialOnly, overlay]);

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

  const scanAllAnnouncements = useCallback(
    async (sourceOverride?: MarketIqHit[]) => {
    if (scanRunning) return;
    scanStopRef.current = false;
    setScanRunning(true);
    setError(null);
    setScanningUrls([]);
    setScanStats({
      ok: 0,
      fail: 0,
      skipped: 0,
      remaining: 0,
      round: 0,
      total: 0,
      done: 0,
      pct: 0,
      current: [],
    });
    setStatusNote("3/3 Analyse — extract PDF + score (saves as it goes)…");

    let ok = 0;
    let fail = 0;
    let skipped = 0;
    let round = 0;
    let total = 0;
    let doneCount = 0;
    let lastBatchErr: string | null = null;

    const doneUrls = new Set<string>();
    for (const h of history) {
      const u = h.source_url?.trim();
      if (u && normSentiment(h.sentiment) !== "pending") doneUrls.add(u);
    }

    try {
      // Prefer live NSE list; else server rediscovers for selected days.
      const sources: MarketIqHit[] =
        sourceOverride && sourceOverride.length > 0
          ? sourceOverride
          : hits.length > 0
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
        const pending = sources.filter((s) => {
          const u = s.url?.trim();
          return u && !doneUrls.has(u);
        });
        const batch = pending.slice(0, 3);
        if (round === 1) {
          total = pending.length;
          skipped = Math.max(
            0,
            sources.filter((s) => s.url?.trim()).length - total,
          );
        }
        if (batch.length === 0) {
          setStatusNote(
            scanStopRef.current
              ? `Stopped · ${ok} analysed · ${fail} failed · saved to DB`
              : `Done · ${ok} analysed · ${fail} failed · saved to DB`,
          );
          break;
        }
        const current = batch
          .map((s) => (s.ticker || "").toUpperCase())
          .filter(Boolean);
        const batchUrls = batch
          .map((s) => s.url?.trim() || "")
          .filter(Boolean);
        setScanningUrls(batchUrls);
        setScanStats({
          ok,
          fail,
          skipped,
          remaining: pending.length,
          round,
          total,
          done: doneCount,
          pct:
            total > 0
              ? Math.min(99, Math.round((100 * doneCount) / total))
              : 0,
          current,
        });
        setStatusNote(
          `3/3 Analyse — ${current.join(", ") || "batch"}… (${ok} ok · ${fail} fail)`,
        );

        let json: {
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
        } | null = null;

        try {
          const res = await fetch("/api/marketiq", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "scan",
              days,
              q: q.trim() || null,
              limit: 3,
              pendingOnly: true,
              skipOcr: !useOcr,
              sources: sources.length ? sources : null,
            }),
            signal: AbortSignal.timeout(280_000),
          });
          try {
            json = (await res.json()) as NonNullable<typeof json>;
          } catch {
            json = {
              ok: false,
              error: `Bad response (HTTP ${res.status})`,
            };
          }
          if (!res.ok || json.ok === false) {
            lastBatchErr = json.error || `Scan batch HTTP ${res.status}`;
            // Soft-fail: skip this batch so the rest of the queue can finish
            fail += batchUrls.length || batch.length;
            doneCount += batchUrls.length || batch.length;
            for (const u of batchUrls) doneUrls.add(u);
            setScanStats({
              ok,
              fail,
              skipped,
              remaining: Math.max(
                0,
                pending.length - (batchUrls.length || batch.length),
              ),
              round,
              total,
              done: doneCount,
              pct:
                total > 0
                  ? Math.min(99, Math.round((100 * doneCount) / total))
                  : 0,
              current: [],
            });
            setStatusNote(
              `3/3 Analyse — batch skipped (${lastBatchErr}) · ${ok} ok · ${fail} fail`,
            );
            continue;
          }
        } catch (e) {
          lastBatchErr =
            e instanceof Error ? e.message : "Scan batch failed";
          fail += batchUrls.length || batch.length;
          doneCount += batchUrls.length || batch.length;
          for (const u of batchUrls) doneUrls.add(u);
          setScanStats({
            ok,
            fail,
            skipped,
            remaining: Math.max(
              0,
              pending.length - (batchUrls.length || batch.length),
            ),
            round,
            total,
            done: doneCount,
            pct:
              total > 0
                ? Math.min(99, Math.round((100 * doneCount) / total))
                : 0,
            current: [],
          });
          setStatusNote(
            `3/3 Analyse — batch error (${lastBatchErr}) · ${ok} ok · ${fail} fail`,
          );
          continue;
        }

        skipped = Math.max(skipped, json.skipped ?? skipped);
        ok += json.analysed ?? 0;
        fail += json.failed ?? 0;
        const remaining = json.remaining ?? 0;
        const attempted = json.attempted ?? 0;
        doneCount += attempted;
        if (round === 1 && total <= 0) {
          total = attempted + remaining;
        }
        for (const u of batchUrls) doneUrls.add(u);
        for (const r of json.results ?? []) {
          const u = r.source_url?.trim();
          if (u) doneUrls.add(u);
        }

        setScanStats({
          ok,
          fail,
          skipped,
          remaining,
          round,
          total,
          done: doneCount,
          pct:
            total > 0
              ? Math.min(99, Math.round((100 * doneCount) / total))
              : attempted === 0
                ? 100
                : 0,
          current,
        });

        for (const r of json.results ?? []) {
          ingestAnalyseResult(r, {
            url: r.source_url,
            title: r.extract?.headline,
            historyId: r.id ?? null,
          });
        }
        if (json.history) setHistory(json.history);

        if (attempted === 0 || remaining === 0) {
          setStatusNote(
            scanStopRef.current
              ? `Stopped · ${ok} analysed · ${fail} failed · saved to DB`
              : `Done · ${ok} analysed · ${fail} failed · saved to DB`,
          );
          break;
        }

        setStatusNote(
          `3/3 Analyse — ${doneCount}/${total || doneCount} · ${remaining} left`,
        );
      }

      if (scanStopRef.current) {
        setStatusNote(
          `Stopped · ${ok} analysed · ${fail} failed · saved to DB`,
        );
      }
      void loadHistory();
    } catch (e) {
      lastBatchErr = e instanceof Error ? e.message : "Scan failed";
      setError(lastBatchErr);
    } finally {
      const hardFail = ok === 0 && (fail > 0 || Boolean(lastBatchErr));
      const partial = ok > 0 && (fail > 0 || Boolean(lastBatchErr));
      if (hardFail) setError(lastBatchErr || "Analyse failed");
      else if (partial && lastBatchErr) {
        setStatusNote(
          `Done · ${ok} analysed · ${fail} failed · ${lastBatchErr}`,
        );
      }
      setScanningUrls([]);
      setScanStats((prev) =>
        prev
          ? {
              ...prev,
              current: [],
              ok,
              fail,
              skipped,
              done: Math.max(prev.done, doneCount),
              total: Math.max(prev.total, total),
              pct: 100,
              finished: true,
              errored: hardFail,
              partial: partial && !hardFail,
            }
          : prev,
      );
      setScanRunning(false);
      scanStopRef.current = false;
    }
  },
  [scanRunning, hits, history, days, q, useOcr, ingestAnalyseResult, loadHistory],
  );

  /** One click: Get new announcements → Save → Extract+Analyse (each result saved). */
  const runPipeline = useCallback(async () => {
    if (scanRunning || busy || saveBusy) return;
    setError(null);
    const sources = await fetchAnnounced();
    if (!sources.length) {
      setStatusNote("No new announcements in this lookback");
      return;
    }
    await saveHits(sources);
    await scanAllAnnouncements(sources);
  }, [
    scanRunning,
    busy,
    saveBusy,
    fetchAnnounced,
    saveHits,
    scanAllAnnouncements,
  ]);

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
            One flow: Get → Save → Extract → Analyse (auto-saves to DB).
          </p>
        </div>
        <div className="miq-head-actions">
          <LiveNseFeedBadge status={nseFeed} compact />
          <LiveBseFeedBadge status={bseFeed} compact />
          {busy || saveBusy || scanRunning ? (
            <span className="miq-live on">
              <i className="miq-live-dot" aria-hidden />
              {busy
                ? "Getting…"
                : saveBusy
                  ? "Saving…"
                  : "Analysing…"}
            </span>
          ) : null}
          <label className="chip tag-chip miq-days">
            Days
            <select
              value={days}
              disabled={busy || analysing}
              onChange={(e) => setDays(Number(e.target.value) || 1)}
            >
              {[...ANNOUNCED_DAY_OPTIONS].map((d) => (
                <option key={d} value={d}>
                  {d === 90 ? "90 (3mo)" : d === 180 ? "180 (6mo)" : d}
                </option>
              ))}
            </select>
          </label>
          <label
            className={`chip tag-chip miq-ocr${useOcr ? " on" : ""}`}
            title="Off = pdf-parse only (fast). On = vision OCR for scanned PDFs (slower)"
          >
            <input
              type="checkbox"
              checked={useOcr}
              disabled={busy || analysing || scanRunning}
              onChange={(e) => setUseOcr(e.target.checked)}
            />
            OCR
          </label>
          <button
            type="button"
            className="chip chip-scan tag-chip"
            disabled={busy || saveBusy || (!scanRunning && analysing)}
            onClick={() => {
              if (scanRunning) stopScan();
              else void runPipeline();
            }}
            title={
              scanRunning
                ? "Stop after the current batch"
                : "Get new announcements → save → extract & analyse"
            }
          >
            {scanRunning
              ? `Stop · ${scanStats?.pct ?? 0}%${
                  scanStats?.current?.length
                    ? ` · ${scanStats.current.join(", ")}`
                    : scanStats?.remaining != null
                      ? ` · ${scanStats.remaining} left`
                      : ""
                }`
              : busy
                ? "1 · Getting…"
                : saveBusy
                  ? "2 · Saving…"
                  : "Run · Get → Analyse"}
          </button>
        </div>
      </header>

      {scanRunning || scanStats ? (
        <div
          className={`fill-progress ${scanStats?.errored ? "is-error" : ""} ${
            scanStats?.finished && !scanStats?.errored ? "is-done" : ""
          }`}
          role="status"
          aria-live="polite"
        >
          <div className="fill-progress-meta">
            <span className="fill-progress-label">
              {scanStats?.errored
                ? "Analyse failed"
                : scanStats?.finished
                  ? scanStats.partial
                    ? "Done · partial (some batches skipped)"
                    : "Done · saved to DB"
                  : scanStats?.current?.length
                    ? `3/3 Analyse ${scanStats.current.join(", ")}…`
                    : "3/3 Analyse…"}
            </span>
            <span className="fill-progress-pct">{scanStats?.pct ?? 0}%</span>
          </div>
          <div className="fill-progress-track">
            <div
              className="fill-progress-bar"
              style={{ width: `${scanStats?.pct ?? 0}%` }}
            />
          </div>
          <p className="fill-progress-detail">
            {scanStats
              ? `${scanStats.done}/${scanStats.total || "…"} · ${scanStats.ok} ok · ${scanStats.fail} fail · skipped ${scanStats.skipped}${
                  scanStats.current?.length
                    ? ` · now ${scanStats.current.join(", ")}`
                    : ""
                }`
              : "…"}
          </p>
        </div>
      ) : null}

      <IqHintPanel title="How it works" aria-label="How MarketIQ works">
        <ul className="obiq-rec-list">
          <li>
            Click <strong>Run · Get → Analyse</strong> — that is the whole
            pipeline.
          </li>
          <li>
            <strong>1 Get</strong> new NSE announcements → <strong>2 Save</strong>{" "}
            to DB → <strong>3 Extract + Analyse</strong> each PDF (scores save
            automatically).
          </li>
          <li>
            Per-row <strong>Analyse</strong> re-runs one filing. PDF test lab is
            for a single upload/URL.
          </li>
        </ul>
      </IqHintPanel>

      <section
        className={`miq-lab${labOpen ? "" : " is-collapsed"}`}
        aria-label="PDF test lab"
      >
        <button
          type="button"
          className="miq-lab-toggle"
          aria-expanded={labOpen}
          onClick={() => setLabOpen((v) => !v)}
        >
          <div className="miq-lab-head">
            <h2 className="miq-lab-title">PDF test lab</h2>
            <span className="miq-lab-chevron" aria-hidden>
              {labOpen ? "▾" : "▸"}
            </span>
            {labBusy ? (
              <span className="miq-lab-busy-hint">
                {labBusy === "extract" ? "Extracting…" : "Analysing…"}
              </span>
            ) : null}
            <span className="miq-lab-hint">
              {labOpen ? "Minimise" : "Expand"}
            </span>
          </div>
          {labOpen ? (
            <p className="miq-lab-sub">
              Upload a filing → Extract text → Analyse for Bullish / Bearish /
              Neutral + impact.
            </p>
          ) : null}
        </button>
        <div
          className="miq-lab-body"
          hidden={!labOpen}
          inert={!labOpen ? true : undefined}
        >
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
                    <CompanyWatchCell
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
        </div>
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
        <div className="filter-bar-main">
          <span className="scan-filter-label">Topic</span>
          <button
            type="button"
            className={`chip tag-chip miq-topic-analyst${analystMeetOnly ? " on" : ""}`}
            title="Reg-30 investor / analyst meet & call schedule intimations"
            onClick={() => {
              setAnalystMeetOnly((v) => !v);
              setPage(1);
            }}
          >
            Analyst Meet
          </button>
          <button
            type="button"
            className={`chip tag-chip miq-topic-pref${preferentialOnly ? " on" : ""}`}
            title="Preferential allotment / issue filings"
            onClick={() => {
              setPreferentialOnly((v) => !v);
              setPage(1);
            }}
          >
            Preferential
          </button>
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

      <p className="pe-ttm-legend" aria-label="TTM PE colour bands">
        <span className="pe-ttm pe-ttm-low" title="Market prices little/no growth">
          &lt;10
        </span>
        <span className="pe-ttm pe-ttm-mod" title="Market prices moderate growth">
          10–30
        </span>
        <span className="pe-ttm pe-ttm-high" title="Market prices high growth">
          30–60
        </span>
        <span className="pe-ttm pe-ttm-vhigh" title="Market prices very high growth">
          &gt;60
        </span>
      </p>

      <div className="table-wrap miq-table-wrap">
        <table className="miq-table">
          <thead>
            <tr>
              <th>Company</th>
              <th className="num">Market cap</th>
              <th
                className="num"
                title="TTM PE: under 10 little/no growth priced, 10–30 moderate, 30–60 high, over 60 very high"
              >
                TTM PE
              </th>
              <th>Remarks</th>
              <th>Category</th>
              <th>Sentiment</th>
              <th>Download</th>
              <th>Impact</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty-state">
                  {busy
                    ? "Loading…"
                    : "No announcements yet. Click Run · Get → Analyse."}
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
                const rowScanning =
                  rowBusy ||
                  (!!r.url?.trim() && scanningUrls.includes(r.url.trim()));
                const fundChips = resolveFundChips(r);
                return (
                  <tr
                    key={r.key}
                    className={rowScanning ? "is-scanning" : undefined}
                  >
                    <td className="miq-td-co">
                      <CompanyWatchCell
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
                        {rowScanning ? "Analysing…" : "Analyse"}
                      </button>
                    </td>
                    <td className="num miq-td-mcap">{formatMcap(r.mcap_cr)}</td>
                    <td className="num miq-td-pe">
                      <span
                        className={ttmPeBandClass(r.pe_ttm)}
                        title={ttmPeBandTitle(r.pe_ttm)}
                      >
                        {formatPeDisplay(r.pe_ttm)}
                      </span>
                    </td>
                    <td className="miq-td-details">
                      <div className="miq-headline">{r.headline}</div>
                      <FundAliasChips funds={fundChips} />
                      {r.summary !== r.headline || long ? (
                        <>
                          <div className="miq-summary">
                            <FundHighlightedSummary
                              text={body}
                              funds={fundChips}
                            />
                          </div>
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
