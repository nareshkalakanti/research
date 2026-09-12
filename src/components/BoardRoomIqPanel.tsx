"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { announcementDedupeKey } from "@/lib/announcement-dedupe";
import { ANNOUNCED_DAY_OPTIONS } from "@/lib/announced-lookback";
import { governanceDinUrl } from "@/lib/links";
import { IqHintPanel } from "@/components/IqHintPanel";
import { CompanyWatchCell } from "@/components/CompanyWatchCell";

type BoardHit = {
  ticker: string;
  company: string | null;
  title: string;
  url: string | null;
  announced_at: string | null;
  period: string | null;
  provider: string;
  category_hint?: string | null;
};

type BoardDin = {
  name: string;
  din: string | null;
  designation: string | null;
  category: string | null;
};

type HistoryRow = {
  id: number;
  source_url: string | null;
  ticker: string | null;
  company: string | null;
  headline: string;
  proposal: string;
  category: string;
  dins: BoardDin[];
  announcement_date: string | null;
  engine: string | null;
  status: string;
  screened_at: string;
};

type FeedRow = {
  key: string;
  historyId: number | null;
  company: string;
  ticker: string;
  dateLabel: string;
  dateIso: string | null;
  headline: string;
  proposal: string;
  category: string;
  dins: BoardDin[];
  status: string;
  url: string | null;
  hit: BoardHit | null;
};

type Overlay = {
  proposal: string;
  category: string;
  dins: BoardDin[];
  status: string;
};

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

function preferFeedRow(a: FeedRow, b: FeedRow): FeedRow {
  const rank = (r: FeedRow) => {
    let s = 0;
    if (r.status !== "pending") s += 30;
    if (r.dins.some((d) => d.din)) s += 20;
    if (r.historyId != null) s += 10;
    if (r.category && r.category !== "Unclassified") s += 5;
    if (r.url) s += 2;
    return s;
  };
  return rank(b) > rank(a)
    ? { ...b, url: b.url || a.url, hit: b.hit || a.hit }
    : { ...a, url: a.url || b.url, hit: a.hit || b.hit };
}

function hitToFeed(h: BoardHit, i: number): FeedRow {
  return {
    key: `live-${h.ticker}-${h.announced_at}-${i}`,
    historyId: null,
    company: h.company || h.ticker,
    ticker: h.ticker,
    dateLabel: fmtDate(h.announced_at),
    dateIso: h.announced_at,
    headline: h.title,
    proposal: h.title,
    category: h.category_hint || "Unclassified",
    dins: [],
    status: "pending",
    url: h.url,
    hit: h,
  };
}

function histToFeed(h: HistoryRow): FeedRow {
  return {
    key: `hist-${h.id}`,
    historyId: h.id,
    company: h.company || h.ticker || "—",
    ticker: (h.ticker || "—").toUpperCase(),
    dateLabel: fmtDate(h.announcement_date || h.screened_at),
    dateIso: h.announcement_date || h.screened_at,
    headline: h.headline,
    proposal: h.proposal || h.headline,
    category: h.category || "Unclassified",
    dins: Array.isArray(h.dins) ? h.dins : [],
    status: h.status || "pending",
    url: h.source_url,
    hit: null,
  };
}

function DinCell({ dins }: { dins: BoardDin[] }) {
  if (!dins.length) return <>—</>;
  return (
    <>
      {dins.slice(0, 4).map((d, i) => {
        const digits = (d.din || "").replace(/\D/g, "");
        const href = digits.length === 8 ? governanceDinUrl(digits) : null;
        return (
          <span key={`${digits || d.name}-${i}`}>
            {i > 0 ? "; " : null}
            <span>{d.name}</span>
            {href ? (
              <>
                {" · "}
                <a
                  className="briq-din-link"
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  title="Open in Governance"
                >
                  DIN {digits}
                </a>
              </>
            ) : d.din ? (
              ` · DIN ${d.din}`
            ) : null}
          </span>
        );
      })}
    </>
  );
}

export function BoardRoomIqPanel() {
  const [days, setDays] = useState(2);
  const [useOcr, setUseOcr] = useState(false);
  const [q, setQ] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [tagQuery, setTagQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "pending" | "analysed"
  >("all");
  const [dinFilter, setDinFilter] = useState<
    "all" | "with_din" | "no_din" | "unclassified"
  >("all");
  const [busy, setBusy] = useState(false);
  const [analyseBusyKey, setAnalyseBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [hits, setHits] = useState<BoardHit[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<Record<string, Overlay>>({});
  const [page, setPage] = useState(1);
  const [scanRunning, setScanRunning] = useState(false);
  const [scanningUrls, setScanningUrls] = useState<string[]>([]);
  const [scanStats, setScanStats] = useState<{
    pct: number;
    done: number;
    total: number;
    ok: number;
    fail: number;
    skipped: number;
    current: string[];
    finished?: boolean;
    errored?: boolean;
  } | null>(null);
  const stopRef = useRef(false);

  const loadHistory = useCallback(async () => {
    const res = await fetch("/api/boardroomiq?history=1&limit=200");
    const json = (await res.json()) as {
      ok?: boolean;
      history?: HistoryRow[];
    };
    if (json.history) setHistory(json.history);
  }, []);

  const loadCategories = useCallback(async () => {
    const res = await fetch("/api/boardroomiq?categories=1");
    const json = (await res.json()) as {
      ok?: boolean;
      categories?: string[];
    };
    if (Array.isArray(json.categories)) setCategories(json.categories);
  }, []);

  const announcedAbortRef = useRef<AbortController | null>(null);

  const fetchAnnounced = useCallback(async () => {
    announcedAbortRef.current?.abort();
    const ac = new AbortController();
    announcedAbortRef.current = ac;
    setBusy(true);
    setError(null);
    setStatusNote("Refreshing live board filings…");
    try {
      const params = new URLSearchParams({
        announced: "1",
        days: String(days),
      });
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/boardroomiq?${params}`, {
        signal: ac.signal,
      });
      const json = (await res.json()) as {
        ok?: boolean;
        sources?: BoardHit[];
        note?: string;
        error?: string;
        cached?: boolean;
      };
      if (ac.signal.aborted) return;
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || "Refresh failed");
      }
      setHits(json.sources || []);
      setLive(true);
      setStatusNote(
        json.note ||
          `${json.sources?.length ?? 0} board / director / AGM filings${json.cached ? " (cache)" : ""}`,
      );
      setPage(1);
      if (json.sources?.length) {
        await fetch("/api/boardroomiq", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "save", sources: json.sources }),
          signal: ac.signal,
        });
        if (!ac.signal.aborted) await loadHistory();
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      if (!ac.signal.aborted) setBusy(false);
    }
  }, [days, q, loadHistory]);

  useEffect(() => {
    void loadHistory();
    setStatusNote("Showing saved screens — Refresh board for live NSE");
    const t = window.setTimeout(() => {
      void loadCategories();
    }, 200);
    return () => {
      announcedAbortRef.current?.abort();
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const analyseRow = useCallback(
    async (row: FeedRow) => {
      if (!row.url) {
        setError("No PDF URL on this row");
        return;
      }
      setAnalyseBusyKey(row.key);
      setError(null);
      try {
        const res = await fetch("/api/boardroomiq", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "analyse",
            url: row.url,
            ticker: row.ticker,
            company: row.company,
            title: row.headline,
            announced_at: row.dateIso,
            historyId: row.historyId,
          }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          status?: string;
          extract?: {
            proposal?: string;
            category?: string;
            dins?: BoardDin[];
          };
          source_url?: string | null;
          id?: number;
        };
        if (!res.ok && !json.extract) {
          throw new Error(json.error || "Analyse failed");
        }
        const entry: Overlay = {
          proposal: json.extract?.proposal || row.proposal,
          category: json.extract?.category || row.category,
          dins: Array.isArray(json.extract?.dins) ? json.extract!.dins! : [],
          status: json.status || (json.ok ? "ok" : "empty_extract"),
        };
        const keys = [
          row.key,
          row.url,
          `hist-${json.id ?? row.historyId}`,
        ].filter(Boolean) as string[];
        setOverlay((prev) => {
          const next = { ...prev };
          for (const k of keys) next[k] = entry;
          return next;
        });
        await loadHistory();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Analyse failed");
      } finally {
        setAnalyseBusyKey(null);
      }
    },
    [loadHistory],
  );

  const stopScan = useCallback(() => {
    stopRef.current = true;
  }, []);

  const scanAll = useCallback(async () => {
    stopRef.current = false;
    setScanRunning(true);
    setError(null);
    setScanningUrls([]);
    let done = 0;
    let ok = 0;
    let fail = 0;
    let skipped = 0;
    const queue = hits.filter((h) => h.url?.trim());
    let total = Math.max(queue.length, 1);
    const skipUrls = new Set<string>();
    setScanStats({
      pct: 0,
      done: 0,
      total,
      ok: 0,
      fail: 0,
      skipped: 0,
      current: [],
    });
    try {
      // Prefetch already-screened URLs so progress reflects pending only
      try {
        const scr = await fetch("/api/boardroomiq?screened=1");
        const sj = (await scr.json()) as { urls?: string[] };
        for (const u of sj.urls || []) skipUrls.add(u);
      } catch {
        /* ignore */
      }
      let pending = queue.filter((h) => !skipUrls.has(h.url!.trim()));
      skipped = queue.length - pending.length;
      total = Math.max(pending.length, 1);
      setScanStats({
        pct: pending.length === 0 ? 100 : 0,
        done: 0,
        total,
        ok: 0,
        fail: 0,
        skipped,
        current: [],
        finished: pending.length === 0,
      });

      while (pending.length > 0 && !stopRef.current) {
        const batchSources = pending.slice(0, 3);
        const current = batchSources
          .map((s) => (s.ticker || "").toUpperCase())
          .filter(Boolean);
        const batchUrls = batchSources
          .map((s) => s.url?.trim() || "")
          .filter(Boolean);
        setScanningUrls(batchUrls);
        setScanStats({
          pct: Math.min(100, Math.round((done / Math.max(1, total)) * 100)),
          done,
          total,
          ok,
          fail,
          skipped,
          current,
        });
        setStatusNote(
          current.length
            ? `Analysing ${current.join(", ")}… · ${done}/${total}`
            : `Scanning board filings… · ${done}/${total}`,
        );
        let json: {
          ok?: boolean;
          error?: string;
          attempted?: number;
          analysed?: number;
          failed?: number;
          remaining?: number;
          history?: HistoryRow[];
          results?: Array<{
            ok?: boolean;
            status?: string;
            source_url?: string | null;
            extract?: {
              proposal?: string;
              category?: string;
              dins?: BoardDin[];
            };
            id?: number;
          }>;
          attempted_urls?: string[];
        };
        try {
          const res = await fetch("/api/boardroomiq", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "scan",
              days,
              limit: 3,
              pendingOnly: true,
              sources: batchSources,
              skipOcr: !useOcr,
            }),
          });
          json = (await res.json()) as typeof json;
          if (!res.ok || json.ok === false) {
            throw new Error(json.error || `Scan batch failed (${res.status})`);
          }
        } catch (batchErr) {
          // Soft-fail one batch; continue with the rest
          fail += batchSources.length;
          done += batchSources.length;
          for (const s of batchSources) {
            const u = s.url?.trim();
            if (u) skipUrls.add(u);
          }
          pending = pending.filter((h) => !skipUrls.has(h.url!.trim()));
          setScanStats({
            pct: Math.min(
              100,
              Math.round((done / Math.max(1, total)) * 100),
            ),
            done,
            total,
            ok,
            fail,
            skipped,
            current,
          });
          setError(
            batchErr instanceof Error
              ? batchErr.message
              : "Scan batch failed",
          );
          continue;
        }

        const attemptedUrls =
          json.attempted_urls?.filter(Boolean) ||
          batchSources.map((s) => s.url!.trim());
        for (const u of attemptedUrls) skipUrls.add(u);

        done += json.attempted ?? attemptedUrls.length;
        ok += json.analysed ?? 0;
        fail += json.failed ?? 0;
        pending = pending.filter((h) => !skipUrls.has(h.url!.trim()));

        setScanStats({
          pct: Math.min(
            100,
            Math.round((done / Math.max(1, total)) * 100),
          ),
          done,
          total,
          ok,
          fail,
          skipped,
          current,
        });
        if (json.history) setHistory(json.history);
        for (const r of json.results || []) {
          if (!r.extract) continue;
          const entry: Overlay = {
            proposal: r.extract.proposal || "",
            category: r.extract.category || "Unclassified",
            dins: Array.isArray(r.extract.dins) ? r.extract.dins : [],
            status: r.status || (r.ok ? "ok" : "empty_extract"),
          };
          const keys = [r.source_url, `hist-${r.id}`].filter(
            Boolean,
          ) as string[];
          setOverlay((prev) => {
            const next = { ...prev };
            for (const k of keys) next[k] = entry;
            return next;
          });
        }
        if ((json.attempted ?? 0) === 0 && attemptedUrls.length === 0) break;
      }

      setScanningUrls([]);
      setScanStats({
        pct: 100,
        done,
        total,
        ok,
        fail,
        skipped,
        current: [],
        finished: true,
      });
      setStatusNote(
        stopRef.current
          ? `Scan stopped · ${ok} analysed · ${fail} failed`
          : `Scan done · ${ok} analysed · ${fail} failed`,
      );
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
      setScanningUrls([]);
      setScanStats((s) =>
        s
          ? {
              ...s,
              current: [],
              pct: Math.max(s.pct, done > 0 ? 100 : s.pct),
              done,
              ok,
              fail,
              skipped,
              finished: done > 0,
              errored: done === 0,
            }
          : {
              pct: 0,
              done,
              total,
              ok,
              fail,
              skipped,
              current: [],
              errored: true,
            },
      );
      if (done > 0) {
        setStatusNote(`Scan ended early · ${ok} analysed · ${fail} failed`);
      }
    } finally {
      setScanRunning(false);
      setScanningUrls([]);
    }
  }, [days, hits, useOcr, loadHistory]);

  const pushDinsToGov = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/boardroomiq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "push_gov", limit: 200 }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        attempted?: number;
        pushed_rows?: number;
        pushed_seats?: number;
        skipped?: number;
        error?: string;
      };
      if (!res.ok || json.error) {
        setError(json.error || "Push to governance failed");
        return;
      }
      setStatusNote(
        `Pushed ${json.pushed_seats ?? 0} DIN seat(s) from ${json.pushed_rows ?? 0} filing(s) → Governance (source: boardroomiq_pdf). Open Governance → PDF DIN pushes.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Push failed");
    } finally {
      setBusy(false);
    }
  }, []);

  const feed = useMemo(() => {
    const rows =
      hits.length > 0 ? hits.map((h, i) => hitToFeed(h, i)) : history.map(histToFeed);

    // Merge history onto live URLs
    const histByUrl = new Map<string, HistoryRow>();
    for (const h of history) {
      const u = h.source_url?.trim();
      if (u && !histByUrl.has(u)) histByUrl.set(u, h);
    }

    const merged = rows.map((r) => {
      const hist = r.url ? histByUrl.get(r.url) : undefined;
      let out = r;
      if (hist && hist.status !== "pending") {
        out = {
          ...histToFeed(hist),
          key: r.key,
          hit: r.hit,
          dateLabel: r.dateLabel || fmtDate(hist.announcement_date),
          dateIso: r.dateIso || hist.announcement_date,
        };
      }
      const o =
        overlay[r.key] ||
        (r.url ? overlay[r.url] : undefined) ||
        (r.historyId != null ? overlay[`hist-${r.historyId}`] : undefined);
      if (o) {
        out = {
          ...out,
          proposal: o.proposal || out.proposal,
          category: o.category || out.category,
          dins: o.dins.length ? o.dins : out.dins,
          status: o.status || out.status,
        };
      }
      return out;
    });

    const byIdentity = new Map<string, FeedRow>();
    for (const row of merged) {
      const key = announcementDedupeKey({
        ticker: row.ticker,
        company: row.company,
        title: row.headline,
        day: row.dateIso,
      });
      const prev = byIdentity.get(key);
      byIdentity.set(key, prev ? preferFeedRow(prev, row) : row);
    }

    const qn = q.trim().toLowerCase();
    const tagSet = new Set(selectedTags.map((t) => t.toLowerCase()));
    return [...byIdentity.values()]
      .filter((r) => {
        if (statusFilter === "pending" && r.status !== "pending") return false;
        if (statusFilter === "analysed" && r.status === "pending") return false;
        if (dinFilter === "with_din" && !r.dins.some((d) => d.din)) return false;
        if (
          dinFilter === "no_din" &&
          (r.status === "pending" || r.dins.some((d) => d.din))
        ) {
          return false;
        }
        if (
          dinFilter === "unclassified" &&
          r.category !== "Unclassified"
        ) {
          return false;
        }
        if (tagSet.size > 0 && !tagSet.has(r.category.toLowerCase())) {
          return false;
        }
        if (!qn) return true;
        const hay =
          `${r.company} ${r.ticker} ${r.headline} ${r.proposal} ${r.category} ${r.dins
            .map((d) => `${d.name} ${d.din || ""}`)
            .join(" ")}`.toLowerCase();
        return hay.includes(qn);
      })
      .sort((a, b) => {
        const ad = a.dateIso ? Date.parse(a.dateIso) : 0;
        const bd = b.dateIso ? Date.parse(b.dateIso) : 0;
        return bd - ad;
      });
  }, [hits, history, overlay, q, selectedTags, statusFilter, dinFilter]);

  const pageCount = Math.max(1, Math.ceil(feed.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = feed.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const analysing = analyseBusyKey != null || scanRunning;

  const TAG_COLLAPSE = 12;
  const filteredTags = useMemo(() => {
    const tq = tagQuery.trim().toLowerCase();
    if (!tq) return categories;
    return categories.filter((c) => c.toLowerCase().includes(tq));
  }, [categories, tagQuery]);
  const visibleTags = tagsExpanded
    ? filteredTags
    : filteredTags.slice(0, TAG_COLLAPSE);
  const moreTagCount = Math.max(0, filteredTags.length - TAG_COLLAPSE);

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) => {
      if (prev.includes(tag)) return prev.filter((t) => t !== tag);
      return [...prev, tag];
    });
    setPage(1);
  }, []);

  const resetFilters = useCallback(() => {
    setQ("");
    setTagQuery("");
    setSelectedTags([]);
    setStatusFilter("all");
    setDinFilter("all");
    setTagsExpanded(false);
    setPage(1);
  }, []);

  return (
    <div className="miq-panel briq-panel">
      <header className="miq-head">
        <div>
          <h1 className="miq-title">BoardRoomIQ</h1>
          <p className="miq-sub">
            NSE board / director / AGM filings · tags from scraped governance
            taxonomy ({categories.length || "…"}) · DIN from PDF
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
            {busy ? "Refreshing…" : "Refresh board"}
          </button>
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
            title="Off = pdf-parse only (fast). On = vision OCR for scanned/thin PDFs (slower)"
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
            disabled={busy || (!scanRunning && hits.length === 0 && history.length === 0)}
            onClick={() => {
              if (scanRunning) stopScan();
              else void scanAll();
            }}
          >
            {scanRunning
              ? `Stop · ${scanStats?.pct ?? 0}%${
                  scanStats?.current?.length
                    ? ` · ${scanStats.current.join(", ")}`
                    : ""
                }`
              : "Scan & Analyse"}
          </button>
          <button
            type="button"
            className="chip tag-chip"
            disabled={busy || analysing || scanRunning || history.length === 0}
            onClick={() => void pushDinsToGov()}
            title="Push saved BoardRoom DINs into governance.db (additive)"
          >
            Push DINs → Gov
          </button>
        </div>
      </header>

      {scanRunning || scanStats ? (
        <div
          className={`fill-progress ${scanStats?.errored ? "is-error" : ""} ${
            scanStats?.finished ? "is-done" : ""
          }`}
          role="status"
        >
          <div className="fill-progress-meta">
            <span className="fill-progress-label">
              {scanStats?.errored
                ? "Scan failed"
                : scanStats?.finished
                  ? "Scan complete"
                  : scanStats?.current?.length
                    ? `Analysing ${scanStats.current.join(", ")}…`
                    : "Scanning board filings…"}
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
              ? `${scanStats.done}/${scanStats.total} · ${scanStats.ok} ok · ${scanStats.fail} fail · skipped ${scanStats.skipped}${
                  scanStats.current?.length
                    ? ` · now ${scanStats.current.join(", ")}`
                    : ""
                }`
              : "…"}
          </p>
        </div>
      ) : null}

      <IqHintPanel title="How it works" aria-label="How BoardRoomIQ works">
        <ul className="miq-how-list">
          <li>
            Pulls NSE CAME board / director / AGM notices (not LotusDew live).
          </li>
          <li>
            Tags each filing with the scraped governance list (
            {categories.length || 153}+ labels such as Director Appointment).
          </li>
          <li>
            Analyse PDF → DIN + proposal summary. DINs link to Governance and are
            pushed into gov.
          </li>
        </ul>
      </IqHintPanel>

      <div className="briq-filters">
        <div className="briq-filters-row">
          <input
            className="miq-search briq-search"
            placeholder="Search companies, proposals, DIN…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
          <button
            type="button"
            className="chip tag-chip"
            onClick={resetFilters}
            title="Clear search and tag filters"
          >
            Reset filters
          </button>
        </div>

        <div className="briq-filter-pills" role="group" aria-label="Status">
          {(
            [
              ["all", "ALL"],
              ["pending", "PENDING"],
              ["analysed", "ANALYSED"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={
                statusFilter === id
                  ? "briq-pill briq-pill-active"
                  : "briq-pill"
              }
              onClick={() => {
                setStatusFilter(id);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="briq-filter-pills" role="group" aria-label="DIN result">
          {(
            [
              ["all", "All results"],
              ["with_din", "WITH DIN"],
              ["no_din", "NO DIN"],
              ["unclassified", "UNCLASSIFIED"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={
                dinFilter === id
                  ? "briq-pill briq-pill-dark"
                  : "briq-pill briq-pill-muted"
              }
              onClick={() => {
                setDinFilter(id);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="briq-tags-block">
          <div className="briq-tags-head">
            <span className="briq-tags-label">
              Tags
              {selectedTags.length
                ? ` · ${selectedTags.length} selected`
                : ` · ${categories.length}`}
            </span>
            <input
              className="briq-tag-search"
              placeholder="Filter tags…"
              value={tagQuery}
              onChange={(e) => setTagQuery(e.target.value)}
            />
          </div>
          <div className="briq-tags-grid">
            {visibleTags.map((tag) => {
              const on = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  className={on ? "briq-tag briq-tag-on" : "briq-tag"}
                  onClick={() => toggleTag(tag)}
                  title={on ? `Exclude '${tag}'` : `Include '${tag}'`}
                >
                  <span>{tag}</span>
                  <span
                    className={
                      on ? "briq-tag-check briq-tag-check-on" : "briq-tag-check"
                    }
                    aria-hidden
                  />
                </button>
              );
            })}
          </div>
          {moreTagCount > 0 ? (
            <button
              type="button"
              className="briq-tags-more"
              onClick={() => setTagsExpanded((v) => !v)}
            >
              {tagsExpanded
                ? "Show less"
                : `+${moreTagCount} more`}
            </button>
          ) : null}
        </div>
      </div>

      {error ? <p className="miq-error">{error}</p> : null}
      {statusNote ? <p className="miq-note">{statusNote}</p> : null}

      <div className="miq-table-wrap">
        <table className="miq-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Proposal</th>
              <th>Tag</th>
              <th>DIN</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={5} className="miq-empty">
                  No rows — refresh board or widen days.
                </td>
              </tr>
            ) : (
              pageRows.map((row) => {
                const busyRow = analyseBusyKey === row.key;
                const rowScanning =
                  busyRow ||
                  (!!row.url?.trim() && scanningUrls.includes(row.url.trim()));
                return (
                  <tr
                    key={row.key}
                    className={rowScanning ? "is-scanning" : undefined}
                  >
                    <td className="miq-td-co">
                      <CompanyWatchCell
                        ticker={row.ticker}
                        company={row.company}
                      />
                      <div className="miq-co-meta">
                        <span>{row.ticker}</span>
                        <span className="miq-dot">·</span>
                        <span className="miq-co-date">{row.dateLabel}</span>
                      </div>
                    </td>
                    <td>
                      <div className="miq-headline">{row.headline}</div>
                      <p className="miq-summary">{row.proposal}</p>
                    </td>
                    <td>
                      <span className="miq-cat-pill">{row.category}</span>
                      <div className="miq-co-meta">{row.status}</div>
                    </td>
                    <td className="briq-dins">
                      <DinCell dins={row.dins} />
                    </td>
                    <td>
                      <div className="miq-row-actions">
                        {row.url ? (
                          <a
                            className="chip tag-chip"
                            href={row.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            PDF
                          </a>
                        ) : null}
                        <button
                          type="button"
                          className="miq-row-analyse"
                          disabled={busyRow || !row.url || scanRunning}
                          onClick={() => void analyseRow(row)}
                        >
                          {rowScanning ? "Analysing…" : "Analyse"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="miq-pager">
        <button
          type="button"
          className="chip tag-chip"
          disabled={safePage <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Prev
        </button>
        <span>
          Page {safePage} / {pageCount} · {feed.length} rows
        </span>
        <button
          type="button"
          className="chip tag-chip"
          disabled={safePage >= pageCount}
          onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
        >
          Next
        </button>
      </div>
    </div>
  );
}
