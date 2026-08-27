"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PaperMockPanel } from "@/components/PaperMockPanel";
import { VerdictRowCard } from "@/components/VerdictRowCard";
import type {
  AgentRunState,
  ListMarket,
  RunMode,
} from "@/lib/agents/types";
import { AGENT_DEFS } from "@/lib/agents/types";

type AgentConfigResponse = {
  brand: string;
  confidenceThreshold: number;
  agentDelayMs: number;
  shortlistPerBucket: number;
  llmProvider: string;
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  llmModel: string;
  demoSymbols: string[];
  markets: {
    NSE: number;
    "NSE SME": number;
    All: number;
    Hold: number;
    Edge: number;
  };
  universeCounts: {
    large: number;
    mid: number;
    small: number;
    total: number;
    scout: {
      NSE: number;
      "NSE SME": number;
      All: number;
      Hold: number;
      Edge: number;
    };
  };
  disclaimer: string;
};

const AGENT_ICONS: Record<string, string> = {
  scout: "🔭",
  technician: "📈",
  fundamentalist: "⚖️",
  newsdesk: "📰",
  bull: "🐂",
  bear: "🐻",
  judge: "⚖️",
  messenger: "📡",
};

function istNow(): string {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function AgentsPanel() {
  const [config, setConfig] = useState<AgentConfigResponse | null>(null);
  const [state, setState] = useState<AgentRunState | null>(null);
  const [mode, setMode] = useState<RunMode>("demo");
  const [list, setList] = useState<ListMarket>("All");
  const [starting, setStarting] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadConfig = useCallback(async () => {
    const res = await fetch("/api/agents/config");
    if (res.ok) setConfig(await res.json());
  }, []);

  const pollStatus = useCallback(async () => {
    const res = await fetch("/api/agents/status");
    if (res.ok) setState(await res.json());
  }, []);

  useEffect(() => {
    void loadConfig();
    void pollStatus();
  }, [loadConfig, pollStatus]);

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (state?.running) {
      pollRef.current = setInterval(() => void pollStatus(), 500);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [state?.running, pollStatus]);

  const startRun = async () => {
    setStarting(true);
    try {
      const res = await fetch("/api/agents/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, list }),
      });
      if (res.ok) {
        const body = await res.json();
        setState(body.state);
      }
    } finally {
      setStarting(false);
    }
  };

  const brand = config?.brand ?? "Research";
  const agentCount = AGENT_DEFS.length;
  const running = state?.running ?? false;
  const engine =
    state?.engine === "llm"
      ? config?.llmProvider === "claude_code"
        ? "claude CLI"
        : "llm"
      : state?.engine ?? "—";
  const footerTs = state?.finished_at
    ? new Date(state.finished_at).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : istNow();

  const nseCount = config?.markets.NSE ?? 0;
  const smeCount = config?.markets["NSE SME"] ?? 0;
  const allCount = config?.markets.All ?? nseCount + smeCount;
  const holdCount = config?.markets.Hold ?? 0;
  const edgeCount = config?.markets.Edge ?? 0;
  const scoutCount = config?.universeCounts.scout[list] ?? 0;
  const universeLabel = scoutCount;

  return (
    <div className="ag-panel">
      <header className="ag-header">
        <div>
          <h2 className="ag-title">
            {brand} · Indian stock analysis
          </h2>
          <p className="ag-sub">
            {agentCount} agents on duty · multi-agent debate engine
          </p>
        </div>
        <div className="ag-start-block">
          <label className="ag-mode">
            <span>List</span>
            <select
              value={list}
              disabled={running || starting}
              onChange={(e) => setList(e.target.value as ListMarket)}
            >
              <option value="All">All ({allCount.toLocaleString()})</option>
              <option value="NSE">NSE ({nseCount.toLocaleString()})</option>
              <option value="NSE SME">
                NSE SME ({smeCount.toLocaleString()})
              </option>
              <option value="Hold">
                Hold ({holdCount.toLocaleString()})
              </option>
              <option value="Edge">
                Edge ({edgeCount.toLocaleString()})
              </option>
            </select>
          </label>
          <label className="ag-mode">
            <span>Mode</span>
            <select
              value={mode}
              disabled={running || starting}
              onChange={(e) => setMode(e.target.value as RunMode)}
            >
              <option value="demo">Demo (offline bundles)</option>
              <option value="live">Live (NSE via Yahoo)</option>
            </select>
          </label>
          <button
            type="button"
            className="ag-start-btn"
            disabled={running || starting}
            onClick={() => void startRun()}
          >
            {running ? "Agents running…" : starting ? "Starting…" : "Start agents"}
          </button>
        </div>
      </header>

      {state?.error ? (
        <div className="ag-banner err">{state.error}</div>
      ) : null}

      <div className="ag-kpis">
        <div className="ag-kpi">
          <span className="ag-kpi-label">Universe</span>
          <strong>{state?.kpis.universe ?? universeLabel}</strong>
          <em>stocks scanned</em>
        </div>
        <div className="ag-kpi">
          <span className="ag-kpi-label">In debate</span>
          <strong>{state?.kpis.in_debate ?? "—"}</strong>
          <em>shortlisted</em>
        </div>
        <div className="ag-kpi accent">
          <span className="ag-kpi-label">Buy signals</span>
          <strong>{state?.kpis.buy_signals ?? "—"}</strong>
          <em>
            conf ≥ {config?.confidenceThreshold ?? 7}
          </em>
        </div>
        <div className="ag-kpi">
          <span className="ag-kpi-label">Top pick</span>
          <strong>
            {state?.kpis.top_pick
              ? `${state.kpis.top_pick.symbol} · ${state.kpis.top_pick.confidence}/10`
              : "—"}
          </strong>
          <em>confidence</em>
        </div>
      </div>

      <PaperMockPanel
        topPick={
          state?.kpis.top_pick
            ? (() => {
                const pick = state.kpis.top_pick!;
                const row = state.verdicts?.find(
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
                  fund_tags: row?.fund_tags,
                  fund_changes: row?.fund_changes,
                };
              })()
            : null
        }
      />

      <div className="ag-grid">
        {(state?.agents ?? AGENT_DEFS.map((d) => ({
          id: d.id,
          name: d.name,
          role: d.role,
          stat1Label: d.stat1Label,
          stat2Label: d.stat2Label,
          stat1: "—",
          stat2: "—",
          status: "offline" as const,
        }))).map((agent) => (
          <article
            key={agent.id}
            className={`ag-card ag-status-${agent.status}`}
          >
            <div className="ag-card-top">
              <span className="ag-icon" aria-hidden>
                {AGENT_ICONS[agent.id] ?? "🤖"}
              </span>
              <div>
                <h3 className="ag-card-name">{agent.name}</h3>
                <p className="ag-card-role">{agent.role}</p>
              </div>
              <span className={`ag-dot ag-dot-${agent.status}`} title={agent.status} />
            </div>
            <div className="ag-card-stats">
              <div>
                <span>{agent.stat1Label}</span>
                <strong>{agent.stat1}</strong>
              </div>
              <div>
                <span>{agent.stat2Label}</span>
                <strong>{agent.stat2}</strong>
              </div>
            </div>
            {agent.status === "working" ? (
              <div className="ag-bars" aria-hidden>
                <span /><span /><span />
              </div>
            ) : null}
          </article>
        ))}
      </div>

      <section className="ag-verdicts">
        <div className="ag-verdicts-head">
          <h3>Latest verdicts</h3>
          {state?.list ? (
            <span className="ag-mode-badge">
              {state.mode} · {state.list}
            </span>
          ) : null}
        </div>
        {!state?.verdicts?.length ? (
          <p className="ag-empty">
            Click Start agents to run the panel. Demo mode works offline; live
            mode pulls NSE data during market hours (Mon–Fri 09:15–15:30 IST).
          </p>
        ) : (
          <ul className="ag-verdict-list">
            {state.verdicts.map((row) => (
              <VerdictRowCard
                key={row.symbol}
                row={row}
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

      <footer className="ag-footer">
        <span>
          Built from {universeLabel.toLocaleString()} stocks in scout universe
          ({list}) · data pulled {footerTs} IST
        </span>
        <span>engine: {engine}</span>
        <span className="ag-disclaimer">
          {config?.disclaimer ??
            "Analysis only. No trades are placed. Not investment advice."}
        </span>
      </footer>
    </div>
  );
}
