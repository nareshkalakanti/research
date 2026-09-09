"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LiveNseFeedBadge } from "@/components/LiveNseFeedBadge";
import type { NseFeedStatus } from "@/lib/nse-feed-status-types";

type MarketFilter = "All" | "NSE" | "NSE SME" | "Holdings" | "Gov board";
type SentimentFilter = "all" | "bullish" | "bearish" | "neutral";
type SortKey = "date" | "impact" | "name";

type ListCounts = Record<MarketFilter, number>;

type Person = {
  name?: unknown;
  din?: unknown;
  designation?: unknown;
  category?: unknown;
};

type ExtractPayload = {
  directors: Array<Record<string, unknown>>;
  kmp: Array<Record<string, unknown>>;
  company: { cin: string | null; isin: string | null };
  extras: Record<string, string | null>;
  concall?: {
    period: string | null;
    url: string | null;
    title: string | null;
    summary: string | null;
    guidance: string | null;
    margins: string | null;
    capex: string | null;
    orders: string | null;
    tone: string | null;
    sentiment: string | null;
    sentiment_score: number | null;
    sentiment_why: string | null;
    risks: string | null;
    source: string | null;
  } | null;
  source_url: string | null;
  notes: string | null;
};

type Gap = {
  match_din: number;
  missing_din: number;
  names_no_din: number;
  flags: string[];
  summary: string;
};

type Row = {
  ticker: string;
  name: string;
  market: string;
  tv: string;
  document_url: string | null;
  document_title: string | null;
  concall_url: string | null;
  concall_title: string | null;
  concall_period: string | null;
  concall_date: string | null;
  document_date: string | null;
  extracted: ExtractPayload | null;
  expected: ExtractPayload;
  gap: Gap;
  extract_engine: string | null;
  extract_status: string | null;
  updated_at: string | null;
};

type Progress = {
  pct: number;
  label: string;
  detail: string;
  done?: boolean;
  error?: boolean;
  warn?: boolean;
};

type UiSentiment = "Bullish" | "Bearish" | "Neutral" | null;

function asStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const MONTH_IX: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

function periodToMs(period: string | null | undefined): number {
  if (!period) return 0;
  const m = period.trim().match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return 0;
  const mon = MONTH_IX[m[1]!];
  if (mon == null) return 0;
  return Date.UTC(Number(m[2]), mon, 15);
}

/** Prefer concall filing date / period; else board announcement; never scan time. */
function eventDateLabel(r: Row): string {
  const callDate = (r.concall_date || "").trim();
  if (callDate) return callDate;
  const period =
    (r.concall_period || "").trim() ||
    (r.extracted?.concall?.period || "").trim();
  if (period) return period;

  const docRaw = (r.document_date || "").trim();
  const fromUrl = dateFromNseUrl(r.document_url);
  const fromAsOf = asOfFromExtract(r);
  const doc = normalizeDocDate(docRaw) || fromUrl || fromAsOf;
  if (doc) return formatDisplayDate(doc);

  return "—";
}

function dateFromNseUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/_(\d{2})(\d{2})(\d{4})\d{6}_/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function asOfFromExtract(r: Row): string | null {
  for (const d of r.extracted?.directors || []) {
    const a = asStr(d.as_of);
    if (a) return normalizeDocDate(a) || a.slice(0, 10);
  }
  return null;
}

function normalizeDocDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mon: Record<string, string> = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  };
  const m = s.match(
    /^(\d{1,2})[-/\s]([A-Za-z]{3})[-/\s,](\d{4})/,
  );
  if (m && mon[m[2]!]) {
    return `${m[3]}-${mon[m[2]!]}-${m[1]!.padStart(2, "0")}`;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

function formatDisplayDate(isoOrYmd: string): string {
  const ymd = isoOrYmd.slice(0, 10);
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoOrYmd;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function eventDateMs(r: Row): number {
  const callDate = (r.concall_date || "").trim();
  if (callDate) {
    const t = Date.parse(callDate);
    if (!Number.isNaN(t)) return t;
    const fromPeriod = periodToMs(
      callDate.match(/([A-Za-z]{3})\s+(\d{4})/)?.[0] || null,
    );
    if (fromPeriod) return fromPeriod;
  }
  const periodMs = periodToMs(
    r.concall_period || r.extracted?.concall?.period || null,
  );
  if (periodMs) return periodMs;
  const doc =
    normalizeDocDate(r.document_date || "") ||
    dateFromNseUrl(r.document_url) ||
    asOfFromExtract(r);
  if (doc) {
    const t = Date.parse(`${doc}T12:00:00Z`);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function rowMissingDirectorDin(r: Row): boolean {
  // Already have DIN(s) — no gap re-run needed (includes din_off_board / din_ok).
  const hasDin =
    (r.extracted?.directors || []).some((d) => !!asStr(d.din)) ||
    r.gap.flags.includes("din_ok") ||
    r.gap.flags.includes("din_off_board");
  if (hasDin) return false;
  return (
    !r.extracted ||
    r.gap.flags.some((f) =>
      ["empty", "wrong_doc", "kmp_only", "names_no_din"].includes(f),
    ) ||
    !(r.document_url || r.extract_status)
  );
}

function mapSentiment(raw: string | null | undefined): UiSentiment {
  const s = (raw || "").toLowerCase();
  if (!s) return null;
  if (s === "bullish" || s === "optimistic" || s === "positive") return "Bullish";
  if (s === "bearish" || s === "cautious" || s === "negative") return "Bearish";
  if (s === "neutral" || s === "mixed") return "Neutral";
  return null;
}

function impactScore(r: Row): number {
  const c = r.extracted?.concall;
  let n = 3;
  const score = c?.sentiment_score;
  if (score != null) n += Math.abs(score) * 2;
  if (c?.summary) n += 1;
  if (c?.guidance) n += 1;
  if (r.document_url) n += 1;
  if (r.gap.flags.includes("din_ok")) n += 1;
  if (r.gap.flags.includes("empty") || r.gap.flags.includes("wrong_doc")) n -= 1;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function rowHeadline(r: Row): string {
  return (
    r.document_title ||
    r.concall_title ||
    r.extracted?.concall?.title ||
    (r.concall_period ? `Concall ${r.concall_period}` : null) ||
    r.gap.summary ||
    "Corporate update"
  );
}

function rowSnippet(r: Row): string {
  const c = r.extracted?.concall;
  return (
    c?.sentiment_why ||
    c?.summary ||
    c?.guidance ||
    r.gap.summary ||
    (r.extract_status
      ? `${r.extract_engine || "extract"} · ${r.extract_status}`
      : "No extract yet — Run to pull board PDF and concall.")
  );
}

function matchCategory(
  title: string,
  body: string,
  keywords: string[],
): string | null {
  // Prefer title hits (announcement subject) over long transcript noise.
  const tryBlob = (blob: string): string | null => {
    const lower = blob.toLowerCase();
    if (!lower.trim()) return null;
    let best: string | null = null;
    for (const kw of keywords) {
      if (kw.length < 4) continue;
      const needle = kw.toLowerCase();
      if (!lower.includes(needle)) continue;
      if (!best || kw.length > best.length) best = kw;
    }
    return best;
  };
  return tryBlob(title) || tryBlob(body);
}

function PersonTable({
  title,
  people,
  empty,
}: {
  title: string;
  people: Person[];
  empty: string;
}) {
  if (!people.length) {
    return (
      <div className="ann-detail-block">
        <div className="ann-detail-label">{title}</div>
        <p className="ann-empty-hint">{empty}</p>
      </div>
    );
  }
  return (
    <div className="ann-detail-block">
      <div className="ann-detail-label">
        {title}
        <span className="ann-count">{people.length}</span>
      </div>
      <div className="ann-people-scroll">
        <table className="ann-people-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>DIN</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p, i) => (
              <tr key={`${asStr(p.din) || asStr(p.name)}-${i}`}>
                <td>{asStr(p.name) || "—"}</td>
                <td className="ann-mono">{asStr(p.din) || "—"}</td>
                <td>
                  {[asStr(p.designation), asStr(p.category)]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CorporateDataPanel() {
  const [market, setMarket] = useState<MarketFilter>("Holdings");
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<ListCounts>({
    All: 10,
    NSE: 0,
    "NSE SME": 0,
    Holdings: 0,
    "Gov board": 0,
  });
  const [keywords, setKeywords] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyTicker, setBusyTicker] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [nseFeed, setNseFeed] = useState<
    (NseFeedStatus & {
      circuit_open?: boolean;
      circuit_remaining_ms?: number;
    }) | null
  >(null);
  const [dinMissing, setDinMissing] = useState<{
    count: number;
    tickers: string[];
  }>({ count: 0, tickers: [] });
  const [dinOffBoard, setDinOffBoard] = useState<{
    count: number;
    tickers: string[];
  }>({ count: 0, tickers: [] });
  const [showDinMissing, setShowDinMissing] = useState(false);
  const [pushGovBusy, setPushGovBusy] = useState(false);

  const [query, setQuery] = useState("");
  const [sentiment, setSentiment] = useState<SentimentFilter>("all");
  const [category, setCategory] = useState<string | null>(null);
  const [catQuery, setCatQuery] = useState("");
  const [catsExpanded, setCatsExpanded] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortAsc, setSortAsc] = useState(false);

  const load = useCallback(async (opts?: { forceNse?: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ market });
      if (opts?.forceNse) qs.set("nse", "1");
      const res = await fetch(`/api/corporate-data?${qs}`);
      const json = (await res.json()) as {
        ok?: boolean;
        rows?: Row[];
        counts?: Partial<ListCounts>;
        error?: string;
        nse_feed?: (NseFeedStatus & {
          circuit_open?: boolean;
          circuit_remaining_ms?: number;
        }) | null;
        din_missing?: { count: number; tickers: string[] };
        din_off_board?: { count: number; tickers: string[] };
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || "Load failed");
      }
      setRows(json.rows || []);
      if (json.counts) {
        setCounts((prev) => ({
          All: json.counts?.All ?? prev.All,
          NSE: json.counts?.NSE ?? prev.NSE,
          "NSE SME": json.counts?.["NSE SME"] ?? prev["NSE SME"],
          Holdings: json.counts?.Holdings ?? prev.Holdings,
          "Gov board": json.counts?.["Gov board"] ?? prev["Gov board"],
        }));
      }
      if (json.nse_feed) setNseFeed(json.nse_feed);
      if (json.din_missing) {
        setDinMissing({
          count: json.din_missing.count,
          tickers: json.din_missing.tickers || [],
        });
      }
      if (json.din_off_board) {
        setDinOffBoard({
          count: json.din_off_board.count,
          tickers: json.din_off_board.tickers || [],
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [market]);

  useEffect(() => {
    void load({ forceNse: true });
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/corporate-event-keywords");
        const json = (await res.json()) as {
          ok?: boolean;
          keywords?: string[];
        };
        if (json.ok && json.keywords?.length) setKeywords(json.keywords);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  useEffect(() => {
    setExpanded(null);
  }, [market, category, sentiment, query]);

  const gapsRollup = useMemo(() => {
    const needs = rows.filter(rowMissingDirectorDin);
    const dinOk = rows.filter((r) => r.gap.flags.includes("din_ok")).length;
    return { needs, dinOk };
  }, [rows]);

  const enriched = useMemo(() => {
    const kwSorted = [...keywords].sort((a, b) => b.length - a.length);
    return rows.map((r) => {
      const title = [r.document_title, r.concall_title, r.extracted?.concall?.title]
        .filter(Boolean)
        .join(" · ");
      const body = [r.extracted?.concall?.summary, r.gap.summary]
        .filter(Boolean)
        .join(" · ");
      const cat =
        matchCategory(title, body, kwSorted) ||
        (r.extracted?.concall ? "Earnings/Conference Call" : null) ||
        (r.document_url ? "Board Meeting" : "Uncategorized");
      const sent = mapSentiment(
        r.extracted?.concall?.sentiment || r.extracted?.concall?.tone,
      );
      return {
        row: r,
        category: cat,
        sentiment: sent,
        impact: impactScore(r),
        headline: rowHeadline(r),
        snippet: rowSnippet(r),
        downloadUrl: r.document_url || r.concall_url,
        dateMs: eventDateMs(r),
      };
    });
  }, [rows, keywords]);

  const visibleCats = useMemo(() => {
    const q = catQuery.trim().toLowerCase();
    const list = !q
      ? keywords
      : keywords.filter((k) => k.toLowerCase().includes(q));
    const limit = catsExpanded ? 240 : 48;
    return list.slice(0, limit);
  }, [keywords, catQuery, catsExpanded]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = enriched.filter((e) => {
      if (sentiment === "bullish" && e.sentiment !== "Bullish") return false;
      if (sentiment === "bearish" && e.sentiment !== "Bearish") return false;
      if (sentiment === "neutral" && e.sentiment !== "Neutral") return false;
      if (category && e.category.toLowerCase() !== category.toLowerCase()) {
        // also allow contains for compound tags
        if (!e.category.toLowerCase().includes(category.toLowerCase())) {
          return false;
        }
      }
      if (!q) return true;
      return (
        e.row.ticker.toLowerCase().includes(q) ||
        e.row.name.toLowerCase().includes(q) ||
        e.headline.toLowerCase().includes(q) ||
        e.snippet.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q)
      );
    });

    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") cmp = a.row.name.localeCompare(b.row.name);
      else if (sortKey === "impact") cmp = a.impact - b.impact;
      else cmp = a.dateMs - b.dateMs;
      return sortAsc ? cmp : -cmp;
    });
    return list;
  }, [enriched, query, sentiment, category, sortKey, sortAsc]);

  const postAction = async (
    action: "scan" | "extract" | "run",
    ticker: string,
    mkt: string,
    opts?: { resetNse?: boolean },
  ) => {
    const timeoutMs =
      action === "scan" ? 90_000 : action === "run" ? 300_000 : 240_000;
    const res = await fetch("/api/corporate-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        ticker,
        market: mkt,
        reset_nse: opts?.resetNse === true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      error?: string | null;
      found?: boolean;
      blocked?: boolean;
      extract_ok?: boolean;
      status?: string;
      concall_url?: string | null;
      engine?: string;
    };
    if (!res.ok || json.ok === false) {
      throw new Error(json.error || `${action} failed`);
    }
    return json;
  };

  const runOne = async (row: Row) => {
    setBusyTicker(row.ticker);
    setError(null);
    try {
      const r = await postAction("run", row.ticker, row.market, {
        resetNse: true,
      });
      if (r.status === "nse_blocked" || r.blocked) {
        if (!r.extract_ok && !r.concall_url) {
          setError(`${row.ticker}: NSE offline — no stored board PDF yet`);
        }
      } else if (r.status === "no_document") {
        setError(`${row.ticker}: no document`);
      } else if (r.extract_ok === false && r.error) {
        setError(`${row.ticker}: ${r.error}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Run failed for ${row.ticker}`);
    } finally {
      setBusyTicker(null);
    }
  };

  const runAll = async (onlyGaps = false) => {
    setBatchBusy(true);
    setError(null);
    const list = onlyGaps ? rows.filter(rowMissingDirectorDin) : [...rows];
    if (!list.length) {
      setProgress({
        pct: 100,
        label: "Done",
        detail: onlyGaps ? "No missing-DIN rows to re-run" : "No rows",
        done: true,
      });
      setBatchBusy(false);
      return;
    }
    let done = 0;
    let hits = 0;
    let nseOffline = 0;
    setProgress({
      pct: 2,
      label: onlyGaps ? "Re-run gaps" : "Scan",
      detail: `Clearing NSE skip · ${list.length}`,
    });
    try {
      await fetch("/api/corporate-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset-nse" }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      /* ignore */
    }

    for (let idx = 0; idx < list.length; idx++) {
      const row = list[idx]!;
      setBusyTicker(row.ticker);
      try {
        const r = await postAction("run", row.ticker, row.market, {
          resetNse: idx === 0,
        });
        done += 1;
        if (r.status === "nse_blocked" || r.blocked) nseOffline += 1;
        if (r.extract_ok) hits += 1;
        setProgress({
          pct: Math.round((done / list.length) * 100),
          label: onlyGaps ? "Re-run gaps" : "Scan",
          detail: `${row.ticker} · ${r.engine || r.status || "ok"} · ${done}/${list.length}`,
          warn: !!(r.blocked || r.status === "no_document"),
        });
        // Pace NSE to avoid Akamai throttle
        if (idx < list.length - 1) {
          await new Promise((res) => setTimeout(res, 350));
        }
      } catch (e) {
        done += 1;
        setProgress({
          pct: Math.round((done / list.length) * 100),
          label: onlyGaps ? "Re-run gaps" : "Scan",
          detail: `${row.ticker} failed · ${e instanceof Error ? e.message : "error"}`,
          error: true,
        });
      }
    }

    setProgress({
      pct: 100,
      label: "Done",
      detail: `${hits}/${list.length} extracted${nseOffline ? ` · NSE offline ${nseOffline}` : ""}`,
      done: true,
      warn: nseOffline > 0,
    });
    setBusyTicker(null);
    setBatchBusy(false);
    await load();
  };

  const pushNewDinsToGov = async () => {
    if (pushGovBusy || batchBusy) return;
    setPushGovBusy(true);
    setProgress({
      pct: 20,
      label: "Push DINs to gov",
      detail: `Additive upsert for ${market}…`,
    });
    try {
      const res = await fetch("/api/corporate-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "push-gov-batch", market }),
        signal: AbortSignal.timeout(120_000),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        attempted?: number;
        ok_count?: number;
        failed?: number;
        pushed_seats?: number;
        error?: string;
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setProgress({
        pct: 100,
        label: "Pushed to governance",
        detail: `${json.ok_count ?? 0}/${json.attempted ?? 0} tickers · ${json.pushed_seats ?? 0} DIN seats (additive)`,
        done: true,
      });
      await load();
    } catch (e) {
      setProgress({
        pct: 100,
        label: "Push failed",
        detail: e instanceof Error ? e.message : "error",
        error: true,
        done: true,
      });
    } finally {
      setPushGovBusy(false);
    }
  };

  return (
    <section className="ann-panel">
      <div className="ann-topbar">
        <label className="ann-search">
          <span className="ann-search-icon" aria-hidden>
            ⌕
          </span>
          <input
            type="search"
            value={query}
            placeholder="Search company, symbol, or keywords…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <div className="ann-sent-toggle" role="group" aria-label="Sentiment">
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
              className={sentiment === id ? "is-on" : ""}
              onClick={() => setSentiment(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ann-sort">
          <LiveNseFeedBadge status={nseFeed} compact />
          {nseFeed?.circuit_open ? (
            <span
              className="ann-circuit"
              title="Soft skip after NSE failure — clears automatically"
            >
              skip {Math.ceil((nseFeed.circuit_remaining_ms || 0) / 1000)}s
            </span>
          ) : null}
          <button
            type="button"
            className="ann-btn ann-btn--ghost"
            title="Re-probe NSE live"
            disabled={loading || batchBusy}
            onClick={() => void load({ forceNse: true })}
          >
            Check NSE
          </button>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            aria-label="Sort by"
          >
            <option value="date">Concall / announcement date</option>
            <option value="impact">Impact</option>
            <option value="name">Company</option>
          </select>
          <button
            type="button"
            className="ann-sort-dir"
            title={sortAsc ? "Ascending" : "Descending"}
            onClick={() => setSortAsc((v) => !v)}
          >
            {sortAsc ? "↑" : "↓"}
          </button>
        </div>
      </div>

      <div className="ann-cats">
        <div className="ann-cats-tools">
          <label className="ann-cat-search">
            <span className="ann-search-icon" aria-hidden>
              ⌕
            </span>
            <input
              type="search"
              value={catQuery}
              placeholder="Search categories…"
              onChange={(e) => setCatQuery(e.target.value)}
            />
          </label>
          <div className="ann-list-select">
            <select
              value={market}
              disabled={batchBusy}
              onChange={(e) => setMarket(e.target.value as MarketFilter)}
            >
              <option value="Holdings">Holdings ({counts.Holdings})</option>
              <option value="Gov board">
                Gov board (NSE DIN) ({counts["Gov board"]})
              </option>
              <option value="NSE">NSE ({counts.NSE})</option>
              <option value="NSE SME">NSE SME ({counts["NSE SME"]})</option>
              <option value="All">Seed All ({counts.All})</option>
            </select>
            <button
              type="button"
              className="ann-btn ann-btn--primary"
              disabled={batchBusy || loading}
              onClick={() => void runAll(false)}
            >
              {batchBusy ? "Running…" : "Scan"}
            </button>
            <button
              type="button"
              className="ann-btn"
              disabled={batchBusy || gapsRollup.needs.length === 0}
              title="Only rows still missing director DINs"
              onClick={() => void runAll(true)}
            >
              Re-run gaps ({gapsRollup.needs.length})
            </button>
            <button
              type="button"
              className="ann-btn"
              disabled={batchBusy || pushGovBusy}
              title="Add extracted director DINs into governance.db (keeps existing seats)"
              onClick={() => void pushNewDinsToGov()}
            >
              {pushGovBusy
                ? "Pushing…"
                : `Push DINs to gov${dinOffBoard.count ? ` (${dinOffBoard.count})` : ""}`}
            </button>
            <button
              type="button"
              className="ann-btn ann-btn--ghost"
              disabled={batchBusy}
              onClick={() => void load()}
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="ann-chips">
          <button
            type="button"
            className={`ann-chip ${!category ? "is-on" : ""}`}
            onClick={() => setCategory(null)}
          >
            All Categories
          </button>
          {visibleCats.map((k) => (
            <button
              key={k}
              type="button"
              className={`ann-chip ${category === k ? "is-on" : ""}`}
              onClick={() => setCategory(category === k ? null : k)}
              title={k}
            >
              {k}
            </button>
          ))}
        </div>
        {keywords.length > 48 ? (
          <div className="ann-cats-foot">
            <button
              type="button"
              className="ann-show-more"
              onClick={() => setCatsExpanded((v) => !v)}
            >
              {catsExpanded ? "Show less ▴" : `Show more (${keywords.length}) ▾`}
            </button>
          </div>
        ) : null}
      </div>

      {progress ? (
        <div
          className={`ann-progress ${progress.error ? "is-error" : ""} ${progress.warn ? "is-warn" : ""} ${progress.done ? "is-done" : ""}`}
          role="status"
        >
          <div className="ann-progress-track">
            <div
              className="ann-progress-fill"
              style={{ width: `${progress.pct}%` }}
            />
          </div>
          <div className="ann-progress-meta">
            <strong>{progress.label}</strong>
            <span>{progress.detail}</span>
          </div>
        </div>
      ) : null}

      {error ? <p className="ann-error">{error}</p> : null}

      <div className="ann-table-shell">
        <div className="ann-table-head">
          <span>Company</span>
          <span>Details</span>
          <span>Category</span>
          <span>Sentiment</span>
          <span>Download</span>
          <span>Impact</span>
          <span />
        </div>

        {loading && !rows.length ? (
          <div className="ann-loading">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="ann-loading">No matching announcements.</div>
        ) : (
          <div className="ann-table-body">
            {visible.map((e) => {
              const r = e.row;
              const open = expanded === r.ticker;
              const busy = busyTicker === r.ticker;
              const concall = r.extracted?.concall;
              return (
                <article
                  key={r.ticker}
                  className={`ann-row ${open ? "is-open" : ""}`}
                >
                  <div className="ann-row-main">
                    <div className="ann-co">
                      <strong>{r.name}</strong>
                      <div className="ann-co-sub">
                        <span className="ann-ticker">{r.ticker}</span>
                        <span
                          className="ann-date"
                          title={
                            r.concall_date || r.concall_period
                              ? "Concall date"
                              : r.document_date || r.document_url
                                ? "NSE board filing date"
                                : "No filing date found"
                          }
                        >
                          <span className="ann-cal" aria-hidden />
                          {eventDateLabel(r)}
                        </span>
                      </div>
                    </div>

                    <div className="ann-details">
                      <div className="ann-headline">{e.headline}</div>
                      <p className="ann-snip">{e.snippet}</p>
                      <button
                        type="button"
                        className="ann-readmore"
                        onClick={() =>
                          setExpanded(open ? null : r.ticker)
                        }
                      >
                        {open ? "Show less" : "Read more"}
                      </button>
                    </div>

                    <div className="ann-cat">
                      <span className="ann-cat-pill">{e.category}</span>
                    </div>

                    <div className="ann-sent">
                      {e.sentiment ? (
                        <span
                          className={`ann-sent-pill ann-sent-pill--${e.sentiment.toLowerCase()}`}
                          title={concall?.sentiment_why || undefined}
                        >
                          <span aria-hidden>
                            {e.sentiment === "Bullish"
                              ? "↗"
                              : e.sentiment === "Bearish"
                                ? "↘"
                                : "→"}
                          </span>
                          {e.sentiment}
                        </span>
                      ) : (
                        <span className="ann-muted">—</span>
                      )}
                    </div>

                    <div className="ann-dl">
                      {e.downloadUrl ? (
                        <a
                          href={e.downloadUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ann-dl-btn"
                          title="Download / open document"
                        >
                          ↓
                        </a>
                      ) : (
                        <span className="ann-muted">—</span>
                      )}
                    </div>

                    <div className="ann-impact">
                      <span className="ann-impact-badge">{e.impact}</span>
                    </div>

                    <div className="ann-actions">
                      <button
                        type="button"
                        className="ann-run"
                        disabled={batchBusy || busy}
                        onClick={() => void runOne(r)}
                        title="Scan board PDF + concall"
                      >
                        {busy ? "…" : "Run"}
                      </button>
                      <a
                        href={r.tv}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ann-ext"
                        title="TradingView"
                      >
                        ↗
                      </a>
                    </div>
                  </div>

                  {open ? (
                    <div className="ann-expand">
                      <PersonTable
                        title="Extracted directors"
                        people={(r.extracted?.directors || []) as Person[]}
                        empty="Not extracted yet — use Run"
                      />
                      <PersonTable
                        title="Expected (governance)"
                        people={(r.expected?.directors || []) as Person[]}
                        empty="No DIN seats in governance.db"
                      />
                      {concall ? (
                        <div className="ann-detail-block ann-detail-block--wide">
                          <div className="ann-detail-label">
                            Concall
                            {r.concall_date || concall.period || r.concall_period
                              ? ` · ${r.concall_date || concall.period || r.concall_period}`
                              : ""}
                            {e.sentiment ? (
                              <span
                                className={`ann-sent-pill ann-sent-pill--${e.sentiment.toLowerCase()}`}
                              >
                                {e.sentiment}
                                {concall.sentiment_score != null
                                  ? ` (${concall.sentiment_score > 0 ? "+" : ""}${concall.sentiment_score})`
                                  : ""}
                              </span>
                            ) : null}
                          </div>
                          <div className="ann-call-grid">
                            {(
                              [
                                ["Why", concall.sentiment_why],
                                ["Summary", concall.summary],
                                ["Guidance", concall.guidance],
                                ["Margins", concall.margins],
                                ["Capex", concall.capex],
                                ["Orders", concall.orders],
                                ["Risks", concall.risks],
                              ] as const
                            )
                              .filter(([, v]) => v)
                              .map(([k, v]) => (
                                <div key={k} className="ann-call-row">
                                  <span>{k}</span>
                                  <p>{v}</p>
                                </div>
                              ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="ann-footer-meta">
        <span>
          Showing {visible.length} of {rows.length} · DIN match{" "}
          {gapsRollup.dinOk}/{rows.length}
        </span>
        <button
          type="button"
          className="ann-din-missing-btn"
          onClick={() => setShowDinMissing((v) => !v)}
        >
          Need DIN work {dinMissing.count}
          {dinOffBoard.count ? ` · new DIN ${dinOffBoard.count}` : ""}
          {showDinMissing ? " ▴" : " ▾"}
        </button>
      </div>
      {showDinMissing ? (
        <div className="ann-din-missing">
          {dinMissing.count > 0 ? (
            <p>
              <strong>{dinMissing.count}</strong> need better DIN extract
              (empty / names without DIN): {dinMissing.tickers.join(", ")}
            </p>
          ) : (
            <p>No empty / names-without-DIN rows.</p>
          )}
          {dinOffBoard.count > 0 ? (
            <p>
              <strong>{dinOffBoard.count}</strong> extracted DIN not yet on
              Expected — use <em>Push DINs to gov</em> (additive; does not wipe
              seats): {dinOffBoard.tickers.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
