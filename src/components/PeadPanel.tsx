"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MarketCapRangeBar,
  MCAP_RANGE_STEPS,
  mcapIndicesToBounds,
} from "@/components/MarketCapRangeBar";
import { ExpandQuarters } from "@/components/ExpandQuarters";
import { QuoteTapeCard } from "@/components/QuoteTapeCard";
import { SevenRuleScoreCard } from "@/components/SevenRuleScoreCard";
import { formatMcap } from "@/lib/types";
import { formatResultDate, pead2ScoreClass } from "@/lib/pead-score";
import type { Pead2Row } from "@/lib/pead2-types";
import { sevenRuleFromPanel } from "@/lib/seven-rule-score";
import { useExpandQuarters } from "@/lib/use-expand-quarters";
/** Exchange universes only — same List as Scan / Themes. */
const PEAD_LISTS = ["All", "NSE", "NSE SME", "BSE SME"] as const;
type PeadList = (typeof PEAD_LISTS)[number];

const MCAP_DEFAULT_MAX = MCAP_RANGE_STEPS.length - 1;
const PEAD_HIGH_MIN = 40;

type PeadCoverage = {
  universe: number;
  scored: number;
  incomplete: number;
  missing: number;
  pending: number;
};

type ScanProgress = {
  label: string;
  detail: string;
  pct: number;
  done?: boolean;
  error?: boolean;
};

type ColId =
  | "company"
  | "pead_score"
  | "result_date"
  | "pe_ratio"
  | "forward_pe"
  | "returns_pct"
  | "daily_ret_pct"
  | "sales_yoy"
  | "sales_qoq"
  | "np_yoy"
  | "np_qoq"
  | "ebidt_yoy"
  | "ebidt_qoq"
  | "cf_profit";

const COLS: Array<{
  id: ColId;
  label: string;
  extra?: boolean;
  title?: string;
}> = [
  { id: "company", label: "Company" },
  {
    id: "pead_score",
    label: "PEAD Score",
    title: "Sales YoY/QoQ mean + cheap Fwd PE bonus",
  },
  {
    id: "result_date",
    label: "Result Date",
    title: "NSE financial-result announcement date",
  },
  {
    id: "pe_ratio",
    label: "Current PE",
    extra: true,
    title: "Trailing P/E from TTM EPS",
  },
  {
    id: "forward_pe",
    label: "Forward PE",
    title: "Price ÷ latest quarter EPS × 4",
  },
  {
    id: "returns_pct",
    label: "Returns",
    title:
      "From first close after NSE result announcement → latest price (not quarter-end)",
  },
  {
    id: "daily_ret_pct",
    label: "Daily Ret",
    title: "Largest single-day % move on/after announcement (capped ~20%)",
  },
  { id: "sales_yoy", label: "Sales YoY", extra: true },
  { id: "sales_qoq", label: "Sales QoQ", extra: true },
  { id: "np_yoy", label: "NP YoY", extra: true },
  { id: "np_qoq", label: "NP QoQ", extra: true },
  { id: "ebidt_yoy", label: "EBIDT YoY", extra: true },
  { id: "ebidt_qoq", label: "EBIDT QoQ", extra: true },
  { id: "cf_profit", label: "CF/Profit", extra: true },
];

type ApiResponse = {
  stats: { scored: number };
  coverage?: PeadCoverage;
  total: number;
  page: number;
  pages: number;
  rows: Pead2Row[];
  updated?: number;
  tried?: number;
  saved?: number;
  failed?: number;
  remaining?: number;
  message?: string;
  error?: string;
};

function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const n = Math.round(v * 10 ** digits) / 10 ** digits;
  const body = n.toLocaleString("en-IN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
  return n > 0 ? `+${body}%` : `${body}%`;
}

function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-IN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function pctClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "pead2-na";
  if (v > 0) return "pead2-up";
  if (v < 0) return "pead2-down";
  return "pead2-na";
}

function peClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "pead2-na";
  if (v < 0 || v > 40) return "pead2-down";
  if (v <= 20) return "pead2-up";
  return "pead2-warn";
}

function fpeClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return "pead2-na";
  if (v >= 500) return "pead2-down";
  if (v > 40) return "pead2-down";
  if (v > 20) return "pead2-warn";
  return "pead2-up";
}

function PeadOpenDetail({
  row,
  open,
  colSpan,
}: {
  row: Pead2Row;
  open: boolean;
  colSpan: number;
}) {
  const qtr = useExpandQuarters(row.ticker, row.market, row.price, open);
  const [roe, setRoe] = useState<number | null>(null);
  const [roce, setRoce] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let dead = false;
    const t = row.ticker.trim().toUpperCase();
    void fetch(
      `/api/seven-rule-fill?scores=1&tickers=${encodeURIComponent(t)}`,
      { cache: "no-store", signal: AbortSignal.timeout(20_000) },
    )
      .then(async (res) => {
        const json = (await res.json()) as {
          rows?: Array<{
            ticker: string;
            roe?: number | null;
            roce?: number | null;
          }>;
        };
        const hit = json.rows?.find((r) => r.ticker.toUpperCase() === t);
        if (dead) return;
        setRoe(hit?.roe ?? null);
        setRoce(hit?.roce ?? null);
      })
      .catch(() => {
        if (!dead) {
          setRoe(null);
          setRoce(null);
        }
      });
    return () => {
      dead = true;
    };
  }, [open, row.ticker]);

  const sevenRule = useMemo(
    () =>
      qtr.panel ? sevenRuleFromPanel(qtr.panel, { roe, roce }) : null,
    [qtr.panel, roe, roce],
  );

  if (!open) return null;

  return (
    <tr className="pead2-expand-row">
      <td colSpan={colSpan}>
        <div className="pead2-expand">
          <aside className="pead2-expand-left">
            <p className="pead2-expand-meta">
              <span className="mono">{row.ticker}</span>
              {row.sector ? <span>{row.sector}</span> : null}
              {row.mcap_cr != null ? (
                <span>₹{formatMcap(row.mcap_cr)} Cr</span>
              ) : null}
            </p>
            <QuoteTapeCard
              ticker={row.ticker}
              market={row.market}
              active={open}
              periods={[20, 50, 200]}
            />
            <div className="pead2-expand-7r">
              {qtr.loading && !sevenRule ? (
                <p className="table-meta">Loading 7R…</p>
              ) : sevenRule ? (
                <SevenRuleScoreCard result={sevenRule} compact />
              ) : (
                <p className="table-meta">No 7R yet</p>
              )}
            </div>
          </aside>
          <div className="pead2-expand-qtr">
            <ExpandQuarters data={qtr} price={row.price} compact />
          </div>
        </div>
      </td>
    </tr>
  );
}

export function PeadPanel() {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [market, setMarket] = useState<PeadList>("All");
  const [showExtra, setShowExtra] = useState(false);
  const [incompleteOnly, setIncompleteOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("result_date");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [mcapMinIndex, setMcapMinIndex] = useState(0);
  const [mcapMaxIndex, setMcapMaxIndex] = useState(MCAP_DEFAULT_MAX);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshingReturns, setRefreshingReturns] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [markets, setMarkets] = useState<Record<string, number>>({});
  const [openTicker, setOpenTicker] = useState<string | null>(null);
  const scanCancel = useRef<{ cancelled: boolean } | null>(null);
  const scanTotalRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    void fetch("/api/companies?market=All&pageSize=1")
      .then((r) => r.json())
      .then((j: { markets?: Record<string, number> }) => {
        if (j.markets) setMarkets(j.markets);
      })
      .catch(() => {
        /* keep empty counts */
      });
  }, []);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, mcapMinIndex, mcapMaxIndex, sort, dir, market, incompleteOnly]);

  const buildParams = useCallback(() => {
    const params = new URLSearchParams({
      q: debouncedQ,
      page: String(page),
      pageSize: "40",
      sort,
      dir,
      market,
    });
    if (incompleteOnly) params.set("incomplete", "1");
    const { minCr, maxCr } = mcapIndicesToBounds(mcapMinIndex, mcapMaxIndex);
    if (minCr != null && minCr > 0) params.set("mcapMin", String(minCr));
    if (maxCr != null) params.set("mcapMax", String(maxCr));
    return params;
  }, [
    debouncedQ,
    page,
    sort,
    dir,
    market,
    incompleteOnly,
    mcapMinIndex,
    mcapMaxIndex,
  ]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = buildParams();
    try {
      const res = await fetch(`/api/pead?${params}`);
      const json = (await res.json()) as ApiResponse;
      if (!res.ok || json.error) {
        setLoadError(json.error || `PEAD failed (${res.status})`);
        setData(null);
        return;
      }
      setLoadError(null);
      setData(json);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "PEAD request failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (scanCancel.current) scanCancel.current.cancelled = true;
    };
  }, []);

  const refreshReturns = useCallback(async () => {
    if (!data?.rows.length) return;
    setRefreshingReturns(true);
    const params = buildParams();
    try {
      const res = await fetch(`/api/pead?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "returns",
          market,
          tickers: data.rows.map((r) => r.ticker),
        }),
      });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok || json.error) {
        setLoadError(json.error || `Returns refresh failed (${res.status})`);
        return;
      }
      setLoadError(null);
      setData(json);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Returns refresh failed",
      );
    } finally {
      setRefreshingReturns(false);
    }
  }, [buildParams, data, market]);

  const scanIncomplete = useCallback(async () => {
    if (scanning) {
      if (scanCancel.current) scanCancel.current.cancelled = true;
      return;
    }
    const token = { cancelled: false };
    scanCancel.current = token;
    setScanning(true);
    setLoadError(null);
    let saved = 0;
    let failed = 0;
    let remaining = Math.max(1, data?.coverage?.pending ?? 1);
    let stoppedEarly = false;
    let errored = false;
    const listLabel = market;
    const initialPending = Math.max(
      remaining,
      data?.coverage?.pending ?? remaining,
    );
    scanTotalRef.current = initialPending;

    const setProg = (
      label: string,
      detail: string,
      rem: number,
      opts?: { done?: boolean; error?: boolean },
    ) => {
      const total = Math.max(scanTotalRef.current, rem + saved + failed, 1);
      scanTotalRef.current = total;
      const doneCount = Math.min(total, saved + failed);
      const pct = opts?.done
        ? 100
        : Math.min(99, Math.max(4, Math.round((doneCount / total) * 100)));
      setScanProgress({
        label,
        detail,
        pct,
        done: opts?.done,
        error: opts?.error,
      });
    };

    setProg("Scan PEAD", `${listLabel} · ${remaining.toLocaleString()} incomplete…`, remaining);

    try {
      for (let round = 1; round <= 120; round += 1) {
        if (token.cancelled) {
          stoppedEarly = true;
          break;
        }
        setProg(
          "Scan PEAD",
          `${listLabel} · 10 workers · +${saved} · ${remaining.toLocaleString()} left…`,
          remaining,
        );
        const params = buildParams();
        params.set("page", "1");
        const res = await fetch(`/api/pead?${params}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "scan",
            market,
            limit: 40,
            concurrency: 10,
          }),
        });
        const json = (await res.json()) as ApiResponse;
        if (!res.ok || json.error) {
          const msg = json.error || `PEAD scan failed (${res.status})`;
          setLoadError(msg);
          setProg("Scan failed", msg, remaining, { error: true });
          stoppedEarly = true;
          errored = true;
          break;
        }
        saved += json.saved ?? 0;
        failed += json.failed ?? 0;
        remaining = json.remaining ?? 0;
        if (
          json.coverage?.pending != null &&
          json.coverage.pending > scanTotalRef.current
        ) {
          scanTotalRef.current = json.coverage.pending + saved + failed;
        }
        if (json.rows) setData(json);
        else if (json.coverage) {
          setData((prev) =>
            prev
              ? {
                  ...prev,
                  coverage: json.coverage,
                  stats: json.stats ?? prev.stats,
                }
              : prev,
          );
        }
        const workers =
          (json as ApiResponse & { workers?: number }).workers ?? 10;
        setProg(
          remaining <= 0 ? "Done" : "Scan PEAD",
          `${listLabel} · ${workers} workers · +${saved}${failed ? ` · ${failed} miss` : ""} · ${remaining.toLocaleString()} left`,
          remaining,
          remaining <= 0 ? { done: true } : undefined,
        );
        if ((json.tried ?? 0) === 0 || remaining <= 0) break;
        if (round < 120) {
          await new Promise((r) => setTimeout(r, 80 + Math.random() * 80));
        }
      }
      if (stoppedEarly && !errored && remaining > 0) {
        setProg(
          "Stopped",
          `${listLabel} · +${saved} · ${failed} fail · ${remaining.toLocaleString()} left`,
          remaining,
        );
      } else if (!errored && remaining <= 0) {
        setProg(
          "Done",
          `${listLabel} · +${saved}${failed ? ` · ${failed} fail` : ""}`,
          0,
          { done: true },
        );
      }
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "PEAD scan failed";
      setLoadError(msg);
      setProg("Scan failed", msg, remaining, { error: true });
    } finally {
      setScanning(false);
      scanCancel.current = null;
    }
  }, [scanning, market, buildParams, load, data?.coverage?.pending]);

  const cols = useMemo(
    () => COLS.filter((c) => showExtra || !c.extra),
    [showExtra],
  );
  const colWidths = useMemo(() => {
    const n = Math.max(1, cols.length - 1);
    const companyPct = Math.max(28, Math.min(40, 52 - n * 2));
    const numPct = (100 - companyPct) / n;
    return Object.fromEntries(
      cols.map((c) => [
        c.id,
        c.id === "company" ? `${companyPct}%` : `${numPct}%`,
      ]),
    ) as Record<ColId, string>;
  }, [cols]);
  const extraTotal = COLS.filter((c) => c.extra).length;
  const extraVisible = showExtra ? extraTotal : 0;
  const mcapNarrowed = mcapMinIndex > 0 || mcapMaxIndex < MCAP_DEFAULT_MAX;
  const filtersActive =
    q.trim().length > 0 ||
    mcapNarrowed ||
    incompleteOnly ||
    market !== "All";
  const coverage = data?.coverage;
  const nseCount = markets["NSE"] ?? 0;
  const smeCount = markets["NSE SME"] ?? 0;
  const bseSmeCount = markets["BSE SME"] ?? 0;
  const allCount = Object.values(markets).reduce((a, b) => a + b, 0);
  const listCount = (list: PeadList): number => {
    if (list === "All") return allCount;
    if (list === "NSE") return nseCount;
    if (list === "NSE SME") return smeCount;
    return bseSmeCount;
  };

  function toggleSort(id: ColId) {
    const key = id === "company" ? "name" : id;
    if (sort === key) setDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSort(key);
      setDir("desc");
    }
  }

  function cell(row: Pead2Row, id: ColId) {
    switch (id) {
      case "company":
        return (
          <div className="pead2-co">
            <button
              type="button"
              className="pead2-name pead2-name-btn"
              title={
                openTicker === row.ticker
                  ? "Hide 7R & quarters"
                  : "Open 7R & quarters"
              }
              onClick={(e) => {
                e.stopPropagation();
                setOpenTicker((cur) =>
                  cur === row.ticker ? null : row.ticker,
                );
              }}
            >
              {row.name}
            </button>
            <div className="pead2-co-meta">
              <span className="mono">{row.ticker}</span>
              {row.cap_code ? (
                <span
                  className={`result-tag tag-cap-${row.cap_code.toLowerCase()}`}
                >
                  {row.cap_code}
                </span>
              ) : null}
              {row.mcap_cr != null ? (
                <span className="muted">₹{formatMcap(row.mcap_cr)}</span>
              ) : null}
              {row.tv ? (
                <a
                  className="pead2-link"
                  href={row.tv}
                  target="_blank"
                  rel="noreferrer"
                >
                  TV
                </a>
              ) : null}
              {row.web ? (
                <a
                  className="pead2-link"
                  href={row.web}
                  target="_blank"
                  rel="noreferrer"
                >
                  Web
                </a>
              ) : null}
              {row.sc ? (
                <a
                  className="pead2-link"
                  href={row.sc}
                  target="_blank"
                  rel="noreferrer"
                >
                  Screener
                </a>
              ) : null}
            </div>
          </div>
        );
      case "pead_score":
        return (
          <span
            className={`pead2-score ${pead2ScoreClass(row.pead_score, PEAD_HIGH_MIN)}`}
          >
            {fmtNum(row.pead_score, 1)}
          </span>
        );
      case "result_date":
        return formatResultDate(row.result_date);
      case "pe_ratio":
        return (
          <span className={peClass(row.pe_ratio)}>
            {row.pe_ratio != null && Number.isFinite(row.pe_ratio)
              ? row.pe_ratio.toFixed(1)
              : "—"}
          </span>
        );
      case "forward_pe":
        return (
          <span className={fpeClass(row.forward_pe)}>
            {row.forward_pe != null && Number.isFinite(row.forward_pe)
              ? row.forward_pe.toFixed(1)
              : "—"}
          </span>
        );
      case "returns_pct":
        return (
          <span className={pctClass(row.returns_pct)}>
            {fmtPct(row.returns_pct)}
          </span>
        );
      case "daily_ret_pct":
        return (
          <span className={pctClass(row.daily_ret_pct)}>
            {fmtPct(row.daily_ret_pct)}
          </span>
        );
      case "sales_yoy":
        return (
          <span className={pctClass(row.sales_yoy)}>
            {fmtPct(row.sales_yoy)}
          </span>
        );
      case "sales_qoq":
        return (
          <span className={pctClass(row.sales_qoq)}>
            {fmtPct(row.sales_qoq)}
          </span>
        );
      case "np_yoy":
        return (
          <span className={pctClass(row.np_yoy)}>{fmtPct(row.np_yoy)}</span>
        );
      case "np_qoq":
        return (
          <span className={pctClass(row.np_qoq)}>{fmtPct(row.np_qoq)}</span>
        );
      case "ebidt_yoy":
        return (
          <span className={pctClass(row.ebidt_yoy)}>
            {fmtPct(row.ebidt_yoy)}
          </span>
        );
      case "ebidt_qoq":
        return (
          <span className={pctClass(row.ebidt_qoq)}>
            {fmtPct(row.ebidt_qoq)}
          </span>
        );
      case "cf_profit":
        return fmtNum(row.cf_profit, 2);
      default:
        return "—";
    }
  }

  const start = data ? (data.page - 1) * 40 + 1 : 0;
  const end = data ? Math.min(data.page * 40, data.total) : 0;

  return (
    <div className="panel pead2-panel">
      <div className="toolbar gov-toolbar">
        <div className="pead2-title">
          <h2>PEAD</h2>
          <p>
            Post-earnings drift — high PEAD, sensible Fwd PE, cooperating
            returns. Result date = NSE announcement (not quarter-end). Returns =
            first close after that date → latest. Click a company for 7R +
            quarters.
          </p>
        </div>
        <label className="field">
          <span>List</span>
          <select
            value={market}
            onChange={(e) => setMarket(e.target.value as PeadList)}
            aria-label="PEAD list"
            disabled={scanning}
          >
            {PEAD_LISTS.map((list) => (
              <option key={list} value={list}>
                {list} ({listCount(list).toLocaleString() || "…"})
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Search</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ticker, company, sector…"
            aria-label="Search PEAD universe"
          />
        </label>
        <button
          type="button"
          className="btn-ghost"
          disabled={loading || scanning}
          onClick={() => void load()}
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      <div className="gov-focus-bar">
        <button
          type="button"
          className={`btn-fill ${scanning ? "on" : ""}`}
          disabled={loading || refreshingReturns}
          onClick={() => void scanIncomplete()}
          title={
            scanning
              ? "Stop PEAD scan"
              : `Fill unscored / missing Fwd PE & growth on ${market} (announce/returns → Refresh Returns)`
          }
        >
          {scanning
            ? "Stop Scan"
            : coverage?.pending
              ? `Scan Incomplete (${coverage.pending.toLocaleString()})`
              : "Scan Incomplete"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={loading || refreshingReturns || scanning || !data?.rows.length}
          onClick={() => void refreshReturns()}
          title="Fill Groww/Tickertape PE & quarters, NSE result dates, then returns for visible rows"
        >
          {refreshingReturns ? "Returns…" : "Refresh Returns"}
        </button>
        <button
          type="button"
          className={`btn-ghost ${incompleteOnly ? "on" : ""}`}
          disabled={scanning}
          onClick={() => setIncompleteOnly((v) => !v)}
          title="Show only boards missing result date, returns, Fwd PE, or growth"
        >
          Incomplete
        </button>
        <button
          type="button"
          className={`btn-ghost ${showExtra ? "on" : ""}`}
          onClick={() => setShowExtra((v) => !v)}
          title="Show growth / CF columns"
        >
          Columns (
          {COLS.filter((c) => !c.extra).length + extraVisible}/{COLS.length})
        </button>
      </div>

      {scanning || scanProgress ? (
        <div
          className={`filter-progress pead2-scan-progress ${scanProgress?.error ? "is-error" : ""} ${scanProgress?.done ? "is-done" : ""}`}
          role="status"
          aria-live="polite"
        >
          <div className="filter-progress-track">
            <div
              className="filter-progress-fill"
              style={{
                width: `${scanProgress?.pct ?? (scanning ? 8 : 0)}%`,
              }}
            />
          </div>
          <span className="filter-progress-text">
            <strong>{scanProgress?.label ?? "Scan PEAD"}</strong>
            {scanProgress?.detail ? ` · ${scanProgress.detail}` : null}
            {scanProgress && !scanProgress.error ? (
              <span className="muted"> · {Math.round(scanProgress.pct)}%</span>
            ) : null}
          </span>
        </div>
      ) : null}

      <div className="gov-cap-filters">
        <div className="scan-filter-row">
          <span className="scan-filter-label">Mcap</span>
          <MarketCapRangeBar
            minIndex={mcapMinIndex}
            maxIndex={mcapMaxIndex}
            onChange={(lo, hi) => {
              setMcapMinIndex(lo);
              setMcapMaxIndex(hi);
            }}
            onClear={
              mcapNarrowed
                ? () => {
                    setMcapMinIndex(0);
                    setMcapMaxIndex(MCAP_DEFAULT_MAX);
                  }
                : undefined
            }
          />
        </div>
        {filtersActive ? (
          <button
            type="button"
            className="clear-filter"
            onClick={() => {
              setQ("");
              setDebouncedQ("");
              setIncompleteOnly(false);
              setMarket("All");
              setMcapMinIndex(0);
              setMcapMaxIndex(MCAP_DEFAULT_MAX);
            }}
          >
            Clear
          </button>
        ) : null}
      </div>

      <div className="table-meta">
        {loading && !data ? (
          <span>Loading PEAD…</span>
        ) : loadError ? (
          <span className="gov-load-error" role="alert">
            {loadError}
          </span>
        ) : data ? (
          <span>
            Showing {start.toLocaleString()}–{end.toLocaleString()} of{" "}
            {data.total.toLocaleString()}
            {coverage
              ? ` · ${market} ${coverage.scored.toLocaleString()}/${coverage.universe.toLocaleString()} scored · ${coverage.incomplete.toLocaleString()} need metrics · ${coverage.missing.toLocaleString()} missing`
              : data.stats?.scored != null
                ? ` · ${data.stats.scored.toLocaleString()} scored`
                : ""}
          </span>
        ) : null}
      </div>

      <div className="table-card">
        <div className="table-wrap">
          <table className="data-table pead2-table">
            <colgroup>
              {cols.map((c) => (
                <col
                  key={c.id}
                  className={
                    c.id === "company" ? "pead2-col-company" : "pead2-col-num"
                  }
                  style={{ width: colWidths[c.id] }}
                />
              ))}
            </colgroup>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th
                    key={c.id}
                    className={
                      c.id === "company"
                        ? "col-company pead2-col-company"
                        : `col-num pead2-col-${c.id}`
                    }
                    title={c.title}
                  >
                    <button
                      type="button"
                      className="pead2-th"
                      onClick={() => toggleSort(c.id)}
                    >
                      {c.label}
                      {sort === (c.id === "company" ? "name" : c.id)
                        ? dir === "desc"
                          ? " ↓"
                          : " ↑"
                        : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((row) => {
                const open = openTicker === row.ticker;
                return (
                  <Fragment key={row.ticker}>
                    <tr className={open ? "pead2-row-open" : undefined}>
                      {cols.map((c) => (
                        <td
                          key={c.id}
                          className={
                            c.id === "company"
                              ? "col-company pead2-col-company"
                              : `col-num pead2-col-${c.id}`
                          }
                        >
                          {cell(row, c.id)}
                        </td>
                      ))}
                    </tr>
                    <PeadOpenDetail
                      row={row}
                      open={open}
                      colSpan={cols.length}
                    />
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {data && data.rows.length === 0 && !loading ? (
            <div className="table-meta">No boards match these PEAD filters.</div>
          ) : null}
        </div>
      </div>

      {data && data.pages > 1 ? (
        <div className="pager">
          <button
            type="button"
            className="btn-ghost"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <span>
            Page {data.page} / {data.pages}
          </span>
          <button
            type="button"
            className="btn-ghost"
            disabled={page >= data.pages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
