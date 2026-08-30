"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type CapFilter,
} from "@/components/CapMarketFilters";
import { RefreshButton } from "@/components/RefreshButton";
import {
  StrategyBuybackRow,
  type StrategyBuybackRowData,
} from "@/components/StrategyBuybackRow";
import {
  StrategyLiquidityRow,
  type StrategyLiquidityRowData,
} from "@/components/StrategyLiquidityRow";
import type { StrategyExpandPanel } from "@/components/StrategyExpandDetail";
import { WatchlistFilterBar } from "@/components/WatchlistFilterBar";
import {
  appendFundParams,
  type FundCountState,
  type FundFilterState,
  type FundWatchlistKey,
} from "@/lib/fund-watchlist-meta";

const STRATEGY_FUND_KEYS: FundWatchlistKey[] = ["niveshaay", "negen"];

const EMPTY_STRATEGY_FUNDS = Object.fromEntries(
  STRATEGY_FUND_KEYS.map((k) => [k, false]),
) as FundFilterState;

type StrategyKind = "buyback" | "liquidity";

type ApiResponse = {
  kind: StrategyKind;
  stats: Record<string, number>;
  pending: number;
  cap_counts?: Partial<Record<CapFilter, number>>;
  tag_counts?: Partial<Record<string, number>>;
  open_count?: number;
  tender_count?: number;
  spread8_count?: number;
  buy_count?: number;
  history_count?: number;
  all_count?: number;
  rows: StrategyBuybackRowData[] | StrategyLiquidityRowData[];
};

type ScanJson = {
  tried?: number;
  saved?: number;
  failed?: number;
  remaining?: number;
  done?: boolean;
  message?: string;
  error?: string;
};

async function scanOnce(body: Record<string, unknown>): Promise<ScanJson> {
  const res = await fetch("/api/strategy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as ScanJson;
  if (!res.ok) throw new Error(json.error || "Scan failed");
  return json;
}

function StrategyScanBar({
  kind,
  market,
  pending,
  busy,
  onRefresh,
}: {
  kind: StrategyKind;
  market: string;
  pending: number;
  busy: boolean;
  onRefresh: () => void | Promise<void>;
}) {
  const [scanBusy, setScanBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const scanDone = pending <= 0;

  const run = useCallback(async () => {
    if (scanBusy || busy || scanDone) return;
    setScanBusy(true);
    setProgress("Starting…");
    try {
      let round = 0;
      let totalSaved = 0;
      let totalFailed = 0;
      for (;;) {
        round += 1;
        setProgress(
          kind === "buyback"
            ? `Fetching buyback details · batch ${round}…`
            : `Scoring liquidity · batch ${round}…`,
        );
        const json = await scanOnce({
          kind,
          market,
          limit: kind === "buyback" ? 8 : 10,
          syncActions: round === 1 && kind === "buyback",
        });

        const tried = json.tried ?? 0;
        const remaining = json.remaining ?? 0;
        totalSaved += json.saved ?? 0;
        totalFailed += json.failed ?? 0;

        if (tried === 0 || json.done || remaining <= 0) {
          setProgress(
            remaining <= 0
              ? `Complete · ${totalSaved} checked${totalFailed ? ` · ${totalFailed} errors` : ""}`
              : json.message || "Nothing left to scan",
          );
          break;
        }

        setProgress(
          kind === "buyback"
            ? `Buybacks · ${remaining.toLocaleString()} left · batch ${round}`
            : `Liquidity · ${remaining.toLocaleString()} left · batch ${round}`,
        );
        await onRefresh();
      }
      await onRefresh();
    } catch (e) {
      setProgress(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanBusy(false);
      setTimeout(() => setProgress(null), 5000);
    }
  }, [busy, kind, market, onRefresh, scanBusy, scanDone]);

  const label =
    kind === "buyback"
      ? scanDone
        ? "All enriched"
        : scanBusy
          ? "Scanning…"
          : "Enrich buybacks"
      : scanDone
        ? "All scanned"
        : scanBusy
          ? "Scanning…"
          : "Scan liquidity";

  return (
    <div className="filter-bar strategy-scan-bar">
      <div className="filter-bar-main">
        <button
          type="button"
          className={`chip chip-scan ${scanBusy ? "busy" : ""}`}
          disabled={scanBusy || busy || scanDone}
          title={
            scanDone
              ? "All tickers checked for this list — use Refresh for new NSE actions"
              : `${pending.toLocaleString()} pending`
          }
          onClick={() => void run()}
        >
          {label}
          {!scanDone && pending > 0 ? (
            <span className="chip-count">{pending.toLocaleString()}</span>
          ) : null}
        </button>
      </div>
      {progress ? <span className="filter-progress-text">{progress}</span> : null}
    </div>
  );
}

export function StrategyPanel() {
  const [kind, setKind] = useState<StrategyKind>("buyback");
  const [market, setMarket] = useState("All");
  const [cap, setCap] = useState<CapFilter>("All");
  const [onlyMatches, setOnlyMatches] = useState(true);
  const [filterHold, setFilterHold] = useState(false);
  const [filterEdge, setFilterEdge] = useState(false);
  const [filterSme, setFilterSme] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterTender, setFilterTender] = useState(false);
  const [filterSpread8, setFilterSpread8] = useState(false);
  const [filterBuy, setFilterBuy] = useState(false);
  const [fundFilters, setFundFilters] =
    useState<FundFilterState>(EMPTY_STRATEGY_FUNDS);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandPanel, setExpandPanel] = useState<StrategyExpandPanel>("qtr");

  const rowIdentity = useMemo(
    () => (data?.rows ?? []).map((r) => `${r.market}:${r.ticker}`).join("|"),
    [data?.rows],
  );

  useEffect(() => {
    setExpanded(null);
    setExpandPanel("qtr");
  }, [kind, rowIdentity]);

  const setFund = useCallback((key: FundWatchlistKey, on: boolean) => {
    setFundFilters((prev) => ({ ...prev, [key]: on }));
  }, []);

  const load = useCallback(async (opts?: { refresh?: boolean }) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        kind,
        market,
        cap,
      });
      if (kind === "liquidity" && onlyMatches) params.set("onlyMatches", "1");
      if (filterHold) params.set("hold", "1");
      if (filterEdge) params.set("edge", "1");
      if (filterSme) params.set("sme", "1");
      if (kind === "buyback" && filterOpen) params.set("open", "1");
      if (kind === "buyback" && filterTender) params.set("tender", "1");
      if (kind === "buyback" && filterSpread8) params.set("spread8", "1");
      if (kind === "buyback" && filterBuy) params.set("buy", "1");
      appendFundParams(params, fundFilters);
      if (opts?.refresh) params.set("refresh", "1");
      const res = await fetch(`/api/strategy?${params}`);
      const json = (await res.json()) as ApiResponse;
      setData(json);
    } finally {
      setLoading(false);
    }
  }, [
    kind,
    market,
    cap,
    onlyMatches,
    filterHold,
    filterEdge,
    filterSme,
    filterOpen,
    filterTender,
    filterSpread8,
    filterBuy,
    fundFilters,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = data?.stats ?? {};
  const rows = data?.rows ?? [];
  const pending = data?.pending ?? 0;
  const tagCounts = data?.tag_counts ?? {};
  const fundCounts = Object.fromEntries(
    STRATEGY_FUND_KEYS.map((k) => [k, tagCounts[k] ?? 0]),
  ) as FundCountState;

  return (
    <div className="panel strategy-panel">
      <div className="missing-head">
        <div>
          <h2>Strategy</h2>
          <p className="missing-sub">
            Micro-monopoly signals — buyback history and low-liquidity ramps
            {data && kind === "buyback" && typeof data.history_count === "number" ? (
              <>
                {" "}
                · <strong>{data.history_count.toLocaleString()}</strong> with buyback
                history
              </>
            ) : null}
            {data ? (
              <>
                {" "}
                · <strong>{rows.length.toLocaleString()}</strong> shown
                {typeof pending === "number" ? (
                  <>
                    {" "}
                    · <strong>{pending.toLocaleString()}</strong> pending scan
                  </>
                ) : null}
              </>
            ) : null}
          </p>
        </div>
        <div className="missing-head-actions">
          <RefreshButton busy={loading} onRefresh={() => load({ refresh: true })} />
        </div>
      </div>

      <div className="toolbar strategy-toolbar">
        <label className="field">
          <span>Signal</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as StrategyKind)}
          >
            <option value="buyback">Buybacks</option>
            <option value="liquidity">Liquidity ramp</option>
          </select>
        </label>
        <label className="field">
          <span>List</span>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="All">All</option>
            <option value="NSE">NSE</option>
            <option value="NSE SME">NSE SME</option>
            <option value="BSE SME">BSE SME</option>
          </select>
        </label>
        {kind === "liquidity" ? (
          <label className="field strategy-check">
            <input
              type="checkbox"
              checked={onlyMatches}
              onChange={(e) => setOnlyMatches(e.target.checked)}
            />
            <span>Low + ramping only</span>
          </label>
        ) : null}
      </div>

      <WatchlistFilterBar
        cap={cap}
        onCap={setCap}
        capCounts={data?.cap_counts}
        allCount={data?.all_count}
        hold={filterHold}
        onHold={setFilterHold}
        holdCount={tagCounts.hold}
        edge={filterEdge}
        onEdge={setFilterEdge}
        edgeCount={tagCounts.edge}
        funds={fundFilters}
        onFund={setFund}
        fundKeys={STRATEGY_FUND_KEYS}
        fundCounts={fundCounts}
        sme={filterSme}
        onSme={setFilterSme}
        smeCount={tagCounts.sme}
        buyableOnly={filterBuy}
        onBuyableOnly={kind === "buyback" ? setFilterBuy : undefined}
        buyCount={data?.buy_count}
        openOnly={filterOpen}
        onOpenOnly={kind === "buyback" ? setFilterOpen : undefined}
        openCount={data?.open_count}
        tenderOnly={filterTender}
        onTenderOnly={kind === "buyback" ? setFilterTender : undefined}
        tenderCount={data?.tender_count}
        spread8Only={filterSpread8}
        onSpread8Only={kind === "buyback" ? setFilterSpread8 : undefined}
        spread8Count={data?.spread8_count}
      />

      <StrategyScanBar
        kind={kind}
        market={market}
        pending={pending}
        busy={loading}
        onRefresh={load}
      />

      {kind === "buyback" ? (
        <p className="hint tight">
          Use <strong>Can buy</strong> for tender offers you can still purchase (
          announced or open, with max ₹ from filings). Add <strong>≥8%</strong>{" "}
          for spread. Expand a row for Qtr / Business.
        </p>
      ) : (
        <p className="hint tight">
          Low avg daily value (₹ lakh) with 20d/60d turnover ramp — thin float
          where attention may be building.
        </p>
      )}

      {loading && !data ? <div className="loading">Loading…</div> : null}

      {!loading && rows.length === 0 ? (
        <div className="empty-state">
          No cached rows — run sync/scan above.
          {kind === "buyback" && typeof stats.events === "number" ? (
            <> ({stats.events} action events in DB)</>
          ) : null}
        </div>
      ) : null}

      {kind === "buyback" && rows.length > 0 ? (
        <div className="table-card strategy-table-card">
          <div className="table-wrap">
            <table className="data-table strategy-data-table">
              <thead>
                <tr>
                  <th className="col-name">Ticker</th>
                  <th className="num col-mcap_cr">Mcap</th>
                  <th className="num">Score</th>
                  <th>Type</th>
                  <th>Latest</th>
                  <th className="num col-price">CMP</th>
                  <th className="num">Max ₹</th>
                  <th className="num">Spread</th>
                  <th className="num">% eq</th>
                  <th>Status</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
              {(rows as StrategyBuybackRowData[]).map((r) => {
                const key = `${r.market}:${r.ticker}`;
                const open = expanded === key;
                return (
                  <StrategyBuybackRow
                    key={key}
                    row={r}
                    open={open}
                    panel={expandPanel}
                    onToggle={() =>
                      setExpanded((cur) => (cur === key ? null : key))
                    }
                    onPanel={setExpandPanel}
                  />
                );
              })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {kind === "liquidity" && rows.length > 0 ? (
        <div className="table-card strategy-table-card">
          <div className="table-wrap">
            <table className="data-table strategy-data-table">
              <thead>
                <tr>
                  <th className="col-name">Ticker</th>
                  <th className="num col-mcap_cr">Mcap</th>
                  <th className="num">Score</th>
                  <th className="num col-price">Price</th>
                  <th className="num">20d ₹L</th>
                  <th className="num">60d ₹L</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
              {(rows as StrategyLiquidityRowData[]).map((r) => {
                const key = `${r.market}:${r.ticker}`;
                const open = expanded === key;
                return (
                  <StrategyLiquidityRow
                    key={key}
                    row={r}
                    open={open}
                    panel={expandPanel}
                    onToggle={() =>
                      setExpanded((cur) => (cur === key ? null : key))
                    }
                    onPanel={setExpandPanel}
                  />
                );
              })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
