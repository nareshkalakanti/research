"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { TickerSuggest, type TickerSuggestHit } from "@/components/TickerSuggest";
import { WatchButton } from "@/components/WatchButton";
import { listWatchedTickers } from "@/lib/user-watchlist";
import {
  VALUATION_ROWS,
  buildValuationColumns,
  computeValuationGrid,
  emptyEstimateInput,
  fmtValNum,
  fmtValPct,
  loadScenarioEstimates,
  pushRecentValuationTicker,
  recentValuationTickers,
  revenueCagr,
  saveScenarioEstimates,
  type ValuationColumn,
  type ValuationComputedYear,
  type ValuationEstimateInput,
  type ValuationHistSeries,
  type ValuationRowId,
  type ValuationScenario,
} from "@/lib/valuation-model";

type ValuationPayload = {
  ok: boolean;
  ticker: string;
  name: string;
  market: string | null;
  price: number | null;
  pe: number | null;
  mcap_cr: number | null;
  change_pct: number | null;
  series: ValuationHistSeries;
  error?: string;
};

const SCENARIOS: { id: ValuationScenario; label: string }[] = [
  { id: "base", label: "Base Case" },
  { id: "bull", label: "Bull Case" },
  { id: "bear", label: "Bear Case" },
];

function fmtPrice(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtMcap(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
}

function cellValue(
  year: ValuationComputedYear,
  id: ValuationRowId,
): number | null {
  return year[id] ?? null;
}

function inputKeyForRow(
  id: ValuationRowId,
): keyof ValuationEstimateInput | null {
  if (id === "revenue_growth") return "revenue_growth_pct";
  if (id === "opm") return "opm_pct";
  if (id === "other_income") return "other_income";
  if (id === "interest") return "interest";
  if (id === "depreciation") return "depreciation";
  if (id === "tax_pct") return "tax_pct";
  if (id === "shares_cr") return "shares_cr";
  if (id === "revenue") return "revenue";
  return null;
}

export function ValuationPanel() {
  const [query, setQuery] = useState("");
  const [ticker, setTicker] = useState<string | null>(null);
  const [data, setData] = useState<ValuationPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<ValuationScenario>("base");
  const [estimates, setEstimates] = useState<
    Record<string, ValuationEstimateInput>
  >({});
  const [chips, setChips] = useState<string[]>([]);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    const watched = listWatchedTickers().slice(0, 8);
    const recent = recentValuationTickers(12);
    const merged = [...new Set([...recent, ...watched])].slice(0, 14);
    setChips(merged);
  }, [ticker]);

  const load = useCallback(async (sym: string, force = false) => {
    const t = sym.trim().toUpperCase();
    if (!t) return;
    setLoading(true);
    setError(null);
    setTicker(t);
    pushRecentValuationTicker(t);
    try {
      const res = await fetch(
        `/api/valuation?ticker=${encodeURIComponent(t)}${force ? "&force=1" : ""}`,
        { signal: AbortSignal.timeout(90_000) },
      );
      const json = (await res.json()) as ValuationPayload;
      if (!res.ok || json.ok === false) {
        setData(null);
        setError(json.error || "Could not load valuation data");
        return;
      }
      setData(json);
      setEstimates(loadScenarioEstimates(t, scenario));
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [scenario]);

  useEffect(() => {
    if (!ticker) return;
    setEstimates(loadScenarioEstimates(ticker, scenario));
  }, [ticker, scenario]);

  const columns: ValuationColumn[] = useMemo(() => {
    if (!data?.series?.dates?.length) return [];
    return buildValuationColumns(data.series.dates, 4, 5);
  }, [data]);

  const grid = useMemo(() => {
    if (!data?.series || !columns.length) return [];
    return computeValuationGrid({
      series: data.series,
      columns,
      estimates,
      price: data.price,
    });
  }, [data, columns, estimates]);

  const cagr = useMemo(() => revenueCagr(grid), [grid]);

  const persist = useCallback(
    (next: Record<string, ValuationEstimateInput>) => {
      setEstimates(next);
      if (ticker) {
        saveScenarioEstimates(ticker, scenario, next);
        setSavedFlash(true);
        window.setTimeout(() => setSavedFlash(false), 1200);
      }
    },
    [ticker, scenario],
  );

  const onEdit = (
    colKey: string,
    field: keyof ValuationEstimateInput,
    raw: string,
  ) => {
    const trimmed = raw.trim();
    const num =
      trimmed === "" || trimmed === "—"
        ? null
        : Number(trimmed.replace(/,/g, ""));
    const value =
      num != null && Number.isFinite(num) ? num : null;
    const prev = estimates[colKey] || emptyEstimateInput();
    persist({
      ...estimates,
      [colKey]: { ...prev, [field]: value },
    });
  };

  const clearEstimates = () => {
    persist({});
  };

  const selectHit = (hit: TickerSuggestHit) => {
    setQuery(hit.ticker);
    void load(hit.ticker);
  };

  if (!ticker) {
    return (
      <section className="panel viq-panel">
        <div className="viq-landing">
          <h1 className="viq-hero-title">Valuation Tool</h1>
          <p className="viq-hero-sub">Estimate Revenues &amp; PAT · Compute CAGR</p>
          <div className="viq-hero-search">
            <TickerSuggest
              value={query}
              onChange={setQuery}
              onSelect={selectHit}
              onSubmit={(t) => void load(t)}
              placeholder="Search for stocks…"
              className="viq-suggest-input"
            />
          </div>
          <p className="viq-hero-hint">
            Search for a company to view P&amp;L, fill in future estimates, and
            compute potential CAGR
          </p>
          {chips.length ? (
            <div className="viq-chips" aria-label="Recent and watched">
              {chips.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="viq-chip"
                  onClick={() => void load(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="panel viq-panel">
      <div className="viq-company">
        <div className="viq-company-head">
          <button
            type="button"
            className="viq-back"
            onClick={() => {
              setTicker(null);
              setData(null);
              setQuery("");
              setError(null);
            }}
            title="Back to search"
          >
            ←
          </button>
          <div className="viq-company-titles">
            <h2 className="viq-company-name">
              {data?.name || ticker}
            </h2>
            <p className="viq-company-meta">
              {ticker}
              {data?.market ? ` · ${data.market}` : ""}
            </p>
          </div>
          <div className="viq-company-actions">
            <span
              className={`viq-saved-pill${savedFlash ? " is-on" : ""}`}
              aria-live="polite"
            >
              {savedFlash ? "Saved" : "Local"}
            </span>
            <button
              type="button"
              className="viq-btn"
              disabled={loading}
              onClick={() => void load(ticker, true)}
              title="Re-fetch Screener annuals"
            >
              {loading ? "…" : "Fetch"}
            </button>
            <WatchButton
              ticker={ticker}
              className="viq-watch"
              offLabel="Watchlist"
              onLabel="Watchlist"
            />
          </div>
        </div>

        <div className="viq-metrics">
          <div className="viq-metric">
            <span className="viq-metric-label">Current price</span>
            <span className="viq-metric-value">
              {fmtPrice(data?.price ?? null)}
              {data?.change_pct != null ? (
                <em
                  className={
                    data.change_pct >= 0 ? "viq-chg up" : "viq-chg down"
                  }
                >
                  {data.change_pct >= 0 ? "+" : ""}
                  {data.change_pct.toFixed(1)}%
                </em>
              ) : null}
            </span>
          </div>
          <div className="viq-metric">
            <span className="viq-metric-label">PE ratio</span>
            <span className="viq-metric-value">
              {data?.pe != null ? data.pe.toFixed(1) : "—"}
            </span>
          </div>
          <div className="viq-metric">
            <span className="viq-metric-label">Market cap</span>
            <span className="viq-metric-value">
              {fmtMcap(data?.mcap_cr ?? null)}
            </span>
          </div>
          {cagr != null ? (
            <div className="viq-metric">
              <span className="viq-metric-label">Revenue CAGR</span>
              <span className="viq-metric-value">{fmtValPct(cagr)}</span>
            </div>
          ) : null}
        </div>

        {error ? <p className="viq-error">{error}</p> : null}
        {loading && !data ? (
          <p className="viq-loading">Loading annual P&amp;L…</p>
        ) : null}

        <div className="viq-model-head">
          <div>
            <h3 className="viq-model-title">
              Financial Modelling — {data?.name || ticker}{" "}
              <span className="viq-case-pill">
                [{SCENARIOS.find((s) => s.id === scenario)?.label}]
              </span>
            </h3>
            <p className="viq-model-sub">Consolidated · Annual</p>
          </div>
          <button
            type="button"
            className="viq-btn viq-btn-ghost"
            onClick={clearEstimates}
            title="Clear estimate inputs for this case"
          >
            Clear Data
          </button>
        </div>

        <div className="viq-cases" role="tablist">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={scenario === s.id}
              className={`viq-case${scenario === s.id ? " on" : ""}`}
              onClick={() => setScenario(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {columns.length && grid.length ? (
          <div className="viq-table-wrap">
            <table className="viq-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      className={c.kind === "est" ? "viq-est" : undefined}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {VALUATION_ROWS.map((row) => (
                  <tr
                    key={row.id}
                    className={[
                      row.bold ? "is-bold" : "",
                      row.accent === "opm" ? "is-opm" : "",
                      row.accent === "pe" ? "is-pe" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <td className="viq-row-label">{row.label}</td>
                    {columns.map((col, ci) => {
                      const year = grid[ci]!;
                      const v = cellValue(year, row.id);
                      const field = inputKeyForRow(row.id);
                      const editable =
                        col.kind === "est" &&
                        row.editableEst &&
                        field != null;
                      const isPct =
                        row.id === "revenue_growth" ||
                        row.id === "pat_growth" ||
                        row.id === "opm" ||
                        row.id === "tax_pct";
                      const tone =
                        isPct && v != null
                          ? v > 0
                            ? "up"
                            : v < 0
                              ? "down"
                              : ""
                          : "";

                      if (editable && field) {
                        const stored =
                          estimates[col.key]?.[field] ??
                          (field === "revenue_growth_pct"
                            ? year.revenue_growth
                            : field === "opm_pct"
                              ? year.opm
                              : field === "tax_pct"
                                ? year.tax_pct
                                : field === "other_income"
                                  ? year.other_income
                                  : field === "interest"
                                    ? year.interest
                                    : field === "depreciation"
                                      ? year.depreciation
                                      : field === "shares_cr"
                                        ? year.shares_cr
                                        : null);
                        return (
                          <td key={col.key} className="viq-est">
                            <input
                              className="viq-cell-input"
                              inputMode="decimal"
                              defaultValue={
                                stored == null ? "" : String(stored)
                              }
                              key={`${col.key}:${field}:${scenario}:${stored ?? ""}`}
                              onBlur={(e) =>
                                onEdit(col.key, field, e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  (e.target as HTMLInputElement).blur();
                                }
                              }}
                            />
                          </td>
                        );
                      }

                      return (
                        <td
                          key={col.key}
                          className={[
                            col.kind === "est" ? "viq-est" : "",
                            tone === "up" ? "viq-up" : "",
                            tone === "down" ? "viq-down" : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined}
                        >
                          {isPct
                            ? fmtValPct(v)
                            : row.id === "eps" || row.id === "forward_pe"
                              ? fmtValNum(v, 1)
                              : fmtValNum(v, 0)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !loading ? (
          <p className="viq-empty">
            No annual P&amp;L yet — try Fetch (Screener), or check the ticker.
          </p>
        ) : null}
      </div>
    </section>
  );
}
