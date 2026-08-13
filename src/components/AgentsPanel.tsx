"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExpandQuarters } from "@/components/ExpandQuarters";
import { PaperMockPanel } from "@/components/PaperMockPanel";
import type {
  AgentRunState,
  ListMarket,
  RunMode,
  VerdictLabel,
  VerdictRow,
} from "@/lib/agents/types";
import { AGENT_DEFS } from "@/lib/agents/types";
import { researchLinks } from "@/lib/links";

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

function fmtPrice(n: number | null): string {
  if (n == null) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtChange(n: number | null): string {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtRvol(n: number | null): string {
  if (n == null) return "—";
  return `${n.toFixed(2)}×`;
}

function rvolClass(n: number | null): string {
  if (n == null) return "ag-rvol";
  if (n >= 3) return "ag-rvol hot";
  if (n >= 1.5) return "ag-rvol warm";
  if (n < 1) return "ag-rvol thin";
  return "ag-rvol";
}

function verdictClass(v: VerdictLabel): string {
  if (v === "BUY") return "ag-verdict-buy";
  if (v === "AVOID") return "ag-verdict-avoid";
  return "ag-verdict-watch";
}

/** Strip breadcrumb / nav junk from scraped about copy. */
function cleanAbout(raw: string): string {
  return raw
    .replace(/^(About Us\s*)+/gi, "")
    .replace(/Home\s*\/\s*About Us\s*/gi, "")
    .replace(/^About Company\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function istNow(): string {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function VerdictLinks({
  web,
  sc,
  tv,
}: {
  web: string | null;
  sc: string;
  tv: string;
}) {
  return (
    <div className="ag-verdict-links" onClick={(e) => e.stopPropagation()}>
      {web ? (
        <a
          href={web}
          target="_blank"
          rel="noopener noreferrer"
          className="ag-link-chip"
        >
          Web
        </a>
      ) : (
        <span className="ag-link-chip disabled">Web</span>
      )}
      <a
        href={sc}
        target="_blank"
        rel="noopener noreferrer"
        className="ag-link-chip"
      >
        SC
      </a>
      <a
        href={tv}
        target="_blank"
        rel="noopener noreferrer"
        className="ag-link-chip"
      >
        TV
      </a>
    </div>
  );
}

type VerdictPanel = "about" | "qtr";

function VerdictRowCard({
  row,
  open,
  onToggle,
}: {
  row: VerdictRow;
  open: boolean;
  onToggle: () => void;
}) {
  const [panel, setPanel] = useState<VerdictPanel>("about");
  const [showMore, setShowMore] = useState(false);
  const about = cleanAbout(row.about?.trim() || "");
  const short = about.length > 320 && !showMore;
  const text = short ? `${about.slice(0, 320).trim()}…` : about;
  const links = row.sc
    ? { web: row.web, sc: row.sc, tv: row.tv }
    : researchLinks(row.symbol, row.market);
  const up = row.day_change_pct != null && row.day_change_pct >= 0;
  const vClass = verdictClass(row.verdict);

  return (
    <li className={`ag-verdict-item ${vClass}${open ? " open" : ""}`}>
      <div className="ag-verdict-row">
        <button type="button" className="ag-verdict-toggle" onClick={onToggle}>
          <span className="ag-chevron" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          <div className="ag-verdict-main">
            <div className="ag-verdict-head">
              <div className="ag-verdict-identity">
                <strong>{row.symbol}</strong>
                <span className="ag-name" title={row.name}>
                  {row.name}
                </span>
                <span className="ag-cap-pill">{row.cap_segment}</span>
                {row.market === "NSE SME" ? (
                  <span className="ag-mkt">SME</span>
                ) : null}
                {row.fired ? <span className="ag-fired">Signal</span> : null}
              </div>
            </div>
            <div className="ag-verdict-summary">
              <span className={`ag-verdict-pill ${vClass}`}>{row.verdict}</span>
              <span className="ag-conf">{row.confidence}/10</span>
              {row.rvol != null ? (
                <span className={rvolClass(row.rvol)} title="Relative volume">
                  RVOL {fmtRvol(row.rvol)}
                </span>
              ) : null}
              {row.trend ? (
                <span className={`ag-trend ag-trend-${row.trend}`}>
                  {row.trend}
                </span>
              ) : null}
              <p className="ag-why">{row.why}</p>
            </div>
            {row.key_catalyst ? (
              <p className="ag-catalyst">{row.key_catalyst}</p>
            ) : null}
          </div>
        </button>
        <div className="ag-verdict-aside">
          <div className="ag-verdict-quote">
            <span className="ag-price">{fmtPrice(row.price)}</span>
            <span className={up ? "ag-up" : "ag-down"}>
              {fmtChange(row.day_change_pct)}
            </span>
          </div>
          <VerdictLinks {...links} />
        </div>
      </div>
      {open ? (
        <div className="ag-verdict-detail">
          <div className="ag-detail-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={panel === "about"}
              className={`ag-detail-tab${panel === "about" ? " on" : ""}`}
              onClick={() => setPanel("about")}
            >
              About
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === "qtr"}
              className={`ag-detail-tab${panel === "qtr" ? " on" : ""}`}
              onClick={() => setPanel("qtr")}
            >
              Qtr
            </button>
          </div>
          {panel === "about" ? (
            <div className="ag-detail-body">
              {row.headquarters ? (
                <div className="ag-detail-meta">
                  <span className="ag-detail-meta-label">HQ</span>
                  <span>{row.headquarters}</span>
                </div>
              ) : null}
              {text ? (
                <p className="ag-detail-text">{text}</p>
              ) : (
                <p className="ag-muted">No about text available.</p>
              )}
              {about.length > 320 ? (
                <button
                  type="button"
                  className="ag-detail-more"
                  onClick={() => setShowMore((v) => !v)}
                >
                  {showMore ? "Show less" : "Show more"}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="ag-detail-body">
              <ExpandQuarters ticker={row.symbol} market={row.market} />
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function AgentsPanel() {
  const [config, setConfig] = useState<AgentConfigResponse | null>(null);
  const [state, setState] = useState<AgentRunState | null>(null);
  const [mode, setMode] = useState<RunMode>("demo");
  const [list, setList] = useState<ListMarket>("NSE");
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
              <option value="NSE">NSE ({nseCount.toLocaleString()})</option>
              <option value="NSE SME">
                NSE SME ({smeCount.toLocaleString()})
              </option>
              <option value="All">All ({allCount.toLocaleString()})</option>
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
