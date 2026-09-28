"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MarketCapRangeBar,
  MCAP_RANGE_STEPS,
  mcapIndicesToBounds,
} from "@/components/MarketCapRangeBar";
import {
  formatMcap,
} from "@/lib/types";
import {
  formatResultDate,
  pead2ScoreClass,
} from "@/lib/pead-score";
import type { Pead2Row } from "@/lib/pead2-types";

const MCAP_DEFAULT_MAX = MCAP_RANGE_STEPS.length - 1;
const PEAD_HIGH_MIN = 40;

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
  { id: "pead_score", label: "PEAD Score", title: "Sales YoY/QoQ mean + cheap Fwd PE bonus" },
  { id: "result_date", label: "Result Date", title: "NSE financial-result announcement date" },
  { id: "pe_ratio", label: "Current PE", extra: true, title: "Trailing P/E from TTM EPS" },
  { id: "forward_pe", label: "Forward PE", title: "Price ÷ latest quarter EPS × 4" },
  { id: "returns_pct", label: "Returns", title: "Price change since first close after result date" },
  { id: "daily_ret_pct", label: "Daily Ret", title: "Largest single-day % move after result (capped)" },
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
  total: number;
  page: number;
  pages: number;
  rows: Pead2Row[];
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

export function PeadPanel() {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [showExtra, setShowExtra] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("result_date");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [mcapMinIndex, setMcapMinIndex] = useState(0);
  const [mcapMaxIndex, setMcapMaxIndex] = useState(MCAP_DEFAULT_MAX);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshingReturns, setRefreshingReturns] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, mcapMinIndex, mcapMaxIndex, sort, dir]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      q: debouncedQ,
      page: String(page),
      pageSize: "40",
      sort,
      dir,
    });
    const { minCr, maxCr } = mcapIndicesToBounds(mcapMinIndex, mcapMaxIndex);
    if (minCr != null && minCr > 0) params.set("mcapMin", String(minCr));
    if (maxCr != null) params.set("mcapMax", String(maxCr));
    try {
      const res = await fetch(`/api/pead?${params}`);
      const json = (await res.json()) as ApiResponse & { error?: string };
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
  }, [debouncedQ, page, sort, dir, mcapMinIndex, mcapMaxIndex]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshReturns = useCallback(async () => {
    if (!data?.rows.length) return;
    setRefreshingReturns(true);
    const params = new URLSearchParams({
      q: debouncedQ,
      page: String(page),
      pageSize: "40",
      sort,
      dir,
    });
    const { minCr, maxCr } = mcapIndicesToBounds(mcapMinIndex, mcapMaxIndex);
    if (minCr != null && minCr > 0) params.set("mcapMin", String(minCr));
    if (maxCr != null) params.set("mcapMax", String(maxCr));
    try {
      const res = await fetch(`/api/pead?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: data.rows.map((r) => r.ticker) }),
      });
      const json = (await res.json()) as ApiResponse & { error?: string };
      if (!res.ok || json.error) {
        setLoadError(json.error || `Returns refresh failed (${res.status})`);
        return;
      }
      setLoadError(null);
      setData(json);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Returns refresh failed");
    } finally {
      setRefreshingReturns(false);
    }
  }, [data, debouncedQ, page, sort, dir, mcapMinIndex, mcapMaxIndex]);

  const cols = useMemo(
    () => COLS.filter((c) => showExtra || !c.extra),
    [showExtra],
  );
  const extraTotal = COLS.filter((c) => c.extra).length;
  const extraVisible = showExtra ? extraTotal : 0;
  const mcapNarrowed = mcapMinIndex > 0 || mcapMaxIndex < MCAP_DEFAULT_MAX;
  const filtersActive =
    q.trim().length > 0 || mcapNarrowed;

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
            <a
              className="pead2-name"
              href={row.tv}
              target="_blank"
              rel="noreferrer"
              title={`${row.name} — TradingView`}
            >
              {row.name}
            </a>
            <div className="pead2-co-meta">
              <span className="mono">{row.ticker}</span>
              {row.cap_code ? (
                <span className={`result-tag tag-cap-${row.cap_code.toLowerCase()}`}>
                  {row.cap_code}
                </span>
              ) : null}
              {row.mcap_cr != null ? (
                <span className="muted">₹{formatMcap(row.mcap_cr)}</span>
              ) : null}
            </div>
          </div>
        );
      case "pead_score":
        return (
          <span className={`pead2-score ${pead2ScoreClass(row.pead_score, PEAD_HIGH_MIN)}`}>
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
        return <span className={pctClass(row.returns_pct)}>{fmtPct(row.returns_pct)}</span>;
      case "daily_ret_pct":
        return (
          <span className={pctClass(row.daily_ret_pct)}>{fmtPct(row.daily_ret_pct)}</span>
        );
      case "sales_yoy":
        return <span className={pctClass(row.sales_yoy)}>{fmtPct(row.sales_yoy)}</span>;
      case "sales_qoq":
        return <span className={pctClass(row.sales_qoq)}>{fmtPct(row.sales_qoq)}</span>;
      case "np_yoy":
        return <span className={pctClass(row.np_yoy)}>{fmtPct(row.np_yoy)}</span>;
      case "np_qoq":
        return <span className={pctClass(row.np_qoq)}>{fmtPct(row.np_qoq)}</span>;
      case "ebidt_yoy":
        return <span className={pctClass(row.ebidt_yoy)}>{fmtPct(row.ebidt_yoy)}</span>;
      case "ebidt_qoq":
        return <span className={pctClass(row.ebidt_qoq)}>{fmtPct(row.ebidt_qoq)}</span>;
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
            Post-earnings drift — high PEAD, sensible Fwd PE, cooperating returns.
            Result date is the announcement, not the quarter-end.
          </p>
        </div>
        <label className="field grow">
          <span>Search</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ticker, company, sector…"
            aria-label="Search PEAD universe"
          />
        </label>
        <button type="button" className="btn-ghost" disabled={loading} onClick={() => void load()}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      <div className="gov-focus-bar">
        <button
          type="button"
          className="btn-fill"
          disabled={loading || refreshingReturns || !data?.rows.length}
          onClick={() => void refreshReturns()}
          title="Fill Groww/Tickertape PE & quarters, NSE result dates, then returns"
        >
          {refreshingReturns ? "Returns…" : "Refresh Returns"}
        </button>
        <button
          type="button"
          className={`btn-ghost ${showExtra ? "on" : ""}`}
          onClick={() => setShowExtra((v) => !v)}
          title="Show growth / CF columns"
        >
          Columns ({COLS.filter((c) => !c.extra).length + extraVisible}/{COLS.length})
        </button>
      </div>

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
            {data.total.toLocaleString()} · ranked by PEAD score
          </span>
        ) : null}
      </div>

      <div className="table-card">
        <div className="table-wrap">
          <table className="data-table pead2-table">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th
                    key={c.id}
                    className={c.id === "company" ? "col-company" : "col-num"}
                    title={c.title}
                  >
                    <button type="button" className="pead2-th" onClick={() => toggleSort(c.id)}>
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
              {(data?.rows ?? []).map((row) => (
                <tr key={row.ticker}>
                  {cols.map((c) => (
                    <td
                      key={c.id}
                      className={c.id === "company" ? "col-company" : "col-num"}
                    >
                      {cell(row, c.id)}
                    </td>
                  ))}
                </tr>
              ))}
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
