"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentCardsGrid } from "@/components/AgentCardsGrid";
import { type CapFilter } from "@/components/CapMarketFilters";
import { PaperMockPanel } from "@/components/PaperMockPanel";
import {
  useQuantNewsdesk,
  type QuantNewsStats,
} from "@/components/QuantNewsdesk";
import { ScanFilters, type SignalMode } from "@/components/ScanFilters";
import { VerdictRowCard } from "@/components/VerdictRowCard";
import { QUANT_NEWS_LIMIT } from "@/lib/agents/newsdesk-types";
import type { AgentRunState } from "@/lib/agents/types";
import { QUANT_AGENT_DEFS } from "@/lib/agents/types";
import type { QuantListMarket } from "@/lib/agents/quant-shortlist";
import type { Company } from "@/lib/types";

type ApiResponse = {
  rows: Company[];
  total: number;
  page: number;
  pages: number;
  markets: Record<string, number>;
  sectors: string[];
  signals?: { bb: number; tq: number; hold?: number; edge?: number; note?: number };
  session?: { bb: string | null; tq: string | null };
};

function scanPool(
  market: QuantListMarket,
  markets: Record<string, number>,
): number {
  if (market === "All") {
    return Object.values(markets).reduce((a, b) => a + b, 0);
  }
  if (market === "NSE") {
    return (markets["NSE"] ?? 0) + (markets["NSE SME"] ?? 0);
  }
  return markets[market] ?? 0;
}

/** Quant tab — 8 agents; Technician = weekly BB + TQ. */
export function QuantPanel() {
  const [market, setMarket] = useState<QuantListMarket>("NSE");
  const [cap, setCap] = useState<CapFilter>("All");
  const [signal, setSignal] = useState<SignalMode>("either");
  const [filterHold, setFilterHold] = useState(false);
  const [filterEdge, setFilterEdge] = useState(false);
  const [filterNote, setFilterNote] = useState(false);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [runState, setRunState] = useState<AgentRunState | null>(null);
  const [debateMode, setDebateMode] = useState<"demo" | "live">("demo");
  const [startingDebate, setStartingDebate] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const filterBb = signal === "bb" || signal === "both" || signal === "either";
  const filterTq = signal === "tq" || signal === "both" || signal === "either";

  const defaultAgents = useMemo(
    () =>
      QUANT_AGENT_DEFS.map((d) => ({
        id: d.id,
        name: d.name,
        role: d.role,
        stat1Label: d.stat1Label,
        stat2Label: d.stat2Label,
        stat1: "—" as string | number,
        stat2: "—" as string | number,
        status: "offline" as const,
      })),
    [],
  );

  const agents = runState?.agents ?? defaultAgents;
  const running = runState?.running ?? false;

  const applyScanAgents = useCallback(
    (json: ApiResponse) => {
      const pool = scanPool(market, json.markets);
      const hits = json.total;
      const tq = json.signals?.tq ?? 0;
      const bb = json.signals?.bb ?? 0;

      setRunState((prev) => {
        if (prev?.running) return prev;
        if (!prev) return prev;
        const agents = prev.agents.map((a) => {
          if (a.id === "scout") {
            return {
              ...a,
              stat1: pool,
              stat2: hits,
              status:
                hits > 0 || tq + bb > 0 ? ("done" as const) : a.status,
            };
          }
          if (a.id === "technician") {
            return {
              ...a,
              stat1: tq,
              stat2: bb,
              status: tq + bb > 0 ? ("done" as const) : a.status,
            };
          }
          return a;
        });
        return { ...prev, agents };
      });
    },
    [market],
  );

  const pollStatus = useCallback(async () => {
    const res = await fetch("/api/quant/agents/status");
    if (!res.ok) return;
    const next = (await res.json()) as AgentRunState;
    setRunState((prev) => {
      if (next.running) return next;
      if (!prev) return next;
      const scout = prev.agents.find((a) => a.id === "scout");
      const tech = prev.agents.find((a) => a.id === "technician");
      const news = prev.agents.find((a) => a.id === "newsdesk");
      if (!scout && !tech && !news) return next;
      const agents = next.agents.map((a) => {
        if (a.id === "scout" && scout?.status === "done" && a.stat1 === "—") {
          return scout;
        }
        if (
          a.id === "technician" &&
          tech?.status === "done" &&
          a.stat1 === "—"
        ) {
          return tech;
        }
        if (
          a.id === "newsdesk" &&
          news?.status === "done" &&
          a.stat1 === "—"
        ) {
          return news;
        }
        return a;
      });
      return { ...next, agents };
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      market,
      cap,
      page: "1",
      pageSize: "500",
    });
    if (filterBb) params.set("bb", "1");
    if (filterTq) params.set("tq", "1");
    if (filterHold) params.set("hold", "1");
    if (filterEdge) params.set("edge", "1");
    if (filterNote) params.set("note", "1");
    if (signal === "both") params.set("bbAnd", "1");
    try {
      const res = await fetch(`/api/companies?${params}`);
      const json = (await res.json()) as ApiResponse;
      setData(json);
      applyScanAgents(json);
    } finally {
      setLoading(false);
    }
  }, [
    market,
    cap,
    signal,
    filterBb,
    filterTq,
    filterHold,
    filterEdge,
    filterNote,
    applyScanAgents,
  ]);

  useEffect(() => {
    void (async () => {
      await pollStatus();
      await load();
    })();
  }, [pollStatus, load]);

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (running || startingDebate) {
      void pollStatus();
      pollRef.current = setInterval(() => void pollStatus(), 250);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [running, startingDebate, pollStatus]);

  const rows = data?.rows ?? [];
  const hitCount = rows.length;

  const startDebate = useCallback(async () => {
    setStartingDebate(true);
    try {
      const res = await fetch("/api/quant/agents/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: debateMode,
          market,
          cap,
          signal:
            signal === "all"
              ? "either"
              : signal === "both"
                ? "both"
                : signal,
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as { state: AgentRunState };
        setRunState(body.state);
      }
    } finally {
      setStartingDebate(false);
    }
  }, [debateMode, market, cap, signal]);

  const markets = data?.markets ?? {};
  const nseCount = markets["NSE"] ?? 0;
  const smeCount = markets["NSE SME"] ?? 0;
  const bseSmeCount = markets["BSE SME"] ?? 0;
  const allCount = Object.values(markets).reduce((a, b) => a + b, 0);

  const newsCompanies = useMemo(() => {
    const map = new Map<
      string,
      {
        ticker: string;
        name: string;
        market: string;
        has_tq?: boolean;
        has_bb?: boolean;
      }
    >();
    for (const r of rows) {
      const k = r.ticker.toUpperCase();
      const have = map.get(k);
      if (!have) {
        map.set(k, {
          ticker: k,
          name: r.name,
          market: r.market,
          has_tq: Boolean(r.has_tq),
          has_bb: Boolean(r.has_bb),
        });
        continue;
      }
      have.has_tq = have.has_tq || Boolean(r.has_tq);
      have.has_bb = have.has_bb || Boolean(r.has_bb);
    }
    return [...map.values()].slice(0, QUANT_NEWS_LIMIT);
  }, [rows]);

  const onNewsStats = useCallback(
    (stats: QuantNewsStats | null, fetching: boolean) => {
      setRunState((prev) => {
        if (prev?.running) return prev;
        const base = prev ?? {
          running: false,
          mode: null,
          list: null,
          started_at: null,
          finished_at: null,
          engine: null,
          error: null,
          progress: null,
          kpis: {
            universe: 0,
            in_debate: 0,
            buy_signals: 0,
            top_pick: null,
          },
          agents: defaultAgents,
          verdicts: [],
          run_id: null,
        };
        const agents = base.agents.map((a) => {
          if (a.id !== "newsdesk") return a;
          if (fetching) {
            return { ...a, stat1: "…", stat2: "…", status: "working" as const };
          }
          if (!stats) {
            return {
              ...a,
              stat1: "—",
              stat2: "—",
              status: "offline" as const,
            };
          }
          const tone =
            stats.netTone >= 0 ? `+${stats.netTone}` : String(stats.netTone);
          return {
            ...a,
            stat1: stats.headlines,
            stat2: tone,
            status: stats.headlines > 0 ? ("done" as const) : ("offline" as const),
          };
        });
        return { ...base, agents };
      });
    },
    [defaultAgents],
  );

  const scanned = Boolean(data?.session?.bb || data?.session?.tq);
  const { byTicker: newsByTicker } = useQuantNewsdesk(
    newsCompanies,
    scanned,
    onNewsStats,
  );

  const progress = runState?.progress;
  const showDebateProgress =
    running || startingDebate || Boolean(progress && !progress.error);

  return (
    <div className="panel quant-panel">
      <div className="quant-head">
        <h2 className="quant-title">Quant scan</h2>
        <p className="panel-lead">
          Weekly <strong>TQ</strong> &amp; <strong>BB</strong> — run{" "}
          <strong>Scan</strong>, then <strong>Run debate</strong>. Hits show as
          TQ / BB / News tags on verdicts. (Agents tab is separate — RVOL
          movers debate.)
        </p>
      </div>

      <div className="quant-toolbar">
        <label className="field quant-market">
          <span>Market</span>
          <select
            value={market}
            disabled={running || startingDebate}
            onChange={(e) => setMarket(e.target.value as QuantListMarket)}
          >
            <option value="NSE">NSE ({nseCount.toLocaleString()})</option>
            <option value="NSE SME">NSE SME ({smeCount.toLocaleString()})</option>
            <option value="BSE SME">
              BSE SME ({bseSmeCount.toLocaleString()})
            </option>
            <option value="All">All ({allCount.toLocaleString()})</option>
          </select>
        </label>

        <ScanFilters
          cap={cap}
          onCap={setCap}
          signal={signal}
          onSignal={setSignal}
          bb={filterBb}
          tq={filterTq}
          onBb={() => {}}
          onTq={() => {}}
          bbCount={data?.signals?.bb}
          tqCount={data?.signals?.tq}
          holdCount={data?.signals?.hold}
          edgeCount={data?.signals?.edge}
          noteCount={data?.signals?.note}
          hold={filterHold}
          edge={filterEdge}
          note={filterNote}
          onHold={setFilterHold}
          onEdge={setFilterEdge}
          onNote={setFilterNote}
          bbDate={data?.session?.bb ?? null}
          tqDate={data?.session?.tq ?? null}
          market={market}
          quantMode
          onBatch={() => void load()}
          onDone={() => void load()}
        />

        <div className="quant-debate">
          <label className="field">
            <span>Debate</span>
            <select
              value={debateMode}
              disabled={running || startingDebate}
              onChange={(e) =>
                setDebateMode(e.target.value as "demo" | "live")
              }
            >
              <option value="demo">Demo</option>
              <option value="live">Live</option>
            </select>
          </label>
          <button
            type="button"
            className="chip chip-scan quant-debate-btn"
            disabled={running || startingDebate || hitCount === 0}
            onClick={() => void startDebate()}
          >
            {running
              ? "Debate running…"
              : startingDebate
                ? "Starting…"
                : "Run debate"}
          </button>
        </div>
      </div>

      {runState?.error ? (
        <div className="ag-banner err quant-banner">{runState.error}</div>
      ) : null}

      <section className="quant-agents-block" aria-label="Quant agent status">
        <h3 className="quant-agents-label">Quant agents · BB/TQ pipeline</h3>
        <AgentCardsGrid agents={agents} className="quant-ag-grid" />
      </section>

      {showDebateProgress ? (
        <div
          className={`filter-progress quant-debate-progress ${progress?.done ? "is-done" : ""} ${progress?.error || runState?.error ? "is-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          <div className="filter-progress-track">
            <div
              className="filter-progress-fill"
              style={{
                width: `${progress?.pct ?? (startingDebate ? 2 : 5)}%`,
              }}
            />
          </div>
          <span className="filter-progress-text">
            <strong>
              {progress?.label ??
                (startingDebate ? "Starting debate" : "Debate running")}
            </strong>
            {progress?.detail ? ` · ${progress.detail}` : null}
            {running && runState?.kpis.in_debate
              ? ` · ${runState.verdicts.length}/${runState.kpis.in_debate} verdicts`
              : null}
          </span>
        </div>
      ) : null}

      {running || runState?.verdicts.length ? (
        <div className="quant-kpis">
          <div className="quant-kpi">
            <span>In debate</span>
            <strong>{runState?.kpis.in_debate || "—"}</strong>
          </div>
          <div className="quant-kpi">
            <span>Verdicts</span>
            <strong>{runState?.verdicts.length ?? 0}</strong>
          </div>
          <div className="quant-kpi accent">
            <span>Buy signals</span>
            <strong>{runState?.kpis.buy_signals ?? "—"}</strong>
          </div>
          <div className="quant-kpi">
            <span>Top pick</span>
            <strong>
              {runState?.kpis.top_pick
                ? `${runState.kpis.top_pick.symbol} · ${runState.kpis.top_pick.confidence}/10`
                : running
                  ? "…"
                  : "—"}
            </strong>
          </div>
        </div>
      ) : null}

      <PaperMockPanel
        emptyHint="Run debate after Scan to get a top pick"
        topPick={
          runState?.kpis.top_pick
            ? (() => {
                const pick = runState.kpis.top_pick!;
                const row = runState.verdicts?.find(
                  (v) => v.symbol === pick.symbol,
                );
                return {
                  symbol: pick.symbol,
                  confidence: pick.confidence,
                  name: row?.name ?? null,
                  market: row?.market ?? null,
                  price: row?.price ?? null,
                  has_hold: row?.has_hold,
                  has_edge: row?.has_edge,
                };
              })()
            : null
        }
      />

      {loading && !data ? <div className="loading">Loading…</div> : null}

      {!loading && !scanned && hitCount === 0 ? (
        <p className="quant-empty">
          No scan yet. Click <strong>Scan</strong> to stamp weekly TQ &amp; BB.
        </p>
      ) : null}

      <section className="ag-verdicts quant-verdicts">
        <div className="ag-verdicts-head">
          <h3>7 · Judge — verdicts</h3>
          {runState?.finished_at ? (
            <span className="ag-mode-badge">
              {runState.mode} · {runState.list}
            </span>
          ) : null}
        </div>
        {!runState?.verdicts?.length ? (
          <p className="ag-empty">
            Run debate after Scan — agents 3–8 score fundamentals, news, bull/bear
            cases on TQ/BB hits; Judge issues BUY / WATCH / AVOID.
          </p>
        ) : (
          <ul className="ag-verdict-list quant-verdict-list">
            {runState.verdicts.map((row) => (
              <VerdictRowCard
                key={row.symbol}
                row={row}
                news={newsByTicker[row.symbol]}
                open={expanded === row.symbol}
                onToggle={() =>
                  setExpanded((cur) =>
                    cur === row.symbol ? null : row.symbol,
                  )
                }
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
