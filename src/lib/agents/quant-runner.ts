import { loadAgentConfig } from "./config";
import {
  attachWeeklySignals,
  countQuantSignals,
  countQuantUniverse,
  listQuantShortlist,
  type QuantListMarket,
} from "./quant-shortlist";
import {
  buildLiveEvidence,
  buildQuantEvidenceLocal,
  loadDemoEvidence,
} from "./evidence";
import { evaluateQuant } from "./scoring";
import { llmEngineLabel, resolveLlmEngine } from "./llm";
import { finishRun, saveVerdict, startRun, lastQuantRun, listVerdictsForRun } from "./store";
import { loadAllCompanies } from "@/lib/db";
import { loadBreakoutMap } from "@/lib/signals";
import { isEdge } from "@/lib/edge";
import { isHolding } from "@/lib/holdings";
import { researchLinks } from "@/lib/links";
import type { CapTier } from "@/lib/types";
import {
  QUANT_AGENT_DEFS,
  type AgentCardState,
  type AgentRunState,
  type RunMode,
  type VerdictRow,
} from "./types";

type QuantSignalMode = "tq" | "bb" | "either" | "both";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function freshAgents(): AgentCardState[] {
  return QUANT_AGENT_DEFS.map((d) => ({
    id: d.id,
    name: d.name,
    role: d.role,
    stat1Label: d.stat1Label,
    stat2Label: d.stat2Label,
    stat1: "—",
    stat2: "—",
    status: "offline" as const,
  }));
}

function cloneState(): AgentRunState {
  return {
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
    agents: freshAgents(),
    verdicts: [],
    run_id: null,
  };
}

function verdictMeta(symbol: string, market: string) {
  const row = loadAllCompanies().find(
    (c) => c.ticker.toUpperCase() === symbol.toUpperCase(),
  );
  const links = researchLinks(symbol, row?.market ?? market, row?.website ?? null);
  return {
    ...links,
    about: row?.about?.trim() || null,
    headquarters: row?.headquarters?.trim() || null,
  };
}

let state: AgentRunState = cloneState();
let runPromise: Promise<void> | null = null;

function setAgent(id: string, patch: Partial<AgentCardState>) {
  state.agents = state.agents.map((a) =>
    a.id === id ? { ...a, ...patch } : a,
  );
}

function setProgress(progress: AgentRunState["progress"]) {
  state.progress = progress;
}

function workingAgentLabel(): string {
  const w = state.agents.find((a) => a.status === "working");
  return w?.name ?? "Agents";
}

async function runAgentPhase(
  id: string,
  delayMs: number,
  work: () => Promise<void> | void,
): Promise<void> {
  setAgent(id, { status: "working" });
  await work();
  await sleep(delayMs);
}

export function getQuantRunState(): AgentRunState {
  if (!state.running && state.verdicts.length === 0) {
    hydrateQuantStateFromDb();
  }
  return structuredClone(state);
}

function hydrateQuantStateFromDb(): void {
  const run = lastQuantRun();
  if (!run) return;

  const stored = listVerdictsForRun(run.id);
  if (!stored.length) return;

  const breakout = loadBreakoutMap();
  const verdictRows: VerdictRow[] = stored.map((v) => {
    const meta = verdictMeta(v.symbol, "NSE");
    const row = loadAllCompanies().find(
      (c) => c.ticker.toUpperCase() === v.symbol.toUpperCase(),
    );
    const flags = breakout.get(v.symbol.toUpperCase());
    return {
      symbol: v.symbol,
      name: v.name,
      cap_segment: v.cap_segment ?? "small",
      market: row?.market ?? "NSE",
      verdict: v.verdict,
      confidence: v.confidence,
      why: v.rationale ?? "",
      key_catalyst: v.key_catalyst ?? "",
      winner: v.winner ?? "",
      price: v.price,
      day_change_pct: v.day_change_pct,
      rvol: null,
      trend: null,
      fired: v.fired,
      engine: v.engine,
      web: meta.web,
      sc: meta.sc,
      tv: meta.tv,
      about: meta.about,
      headquarters: meta.headquarters,
      has_hold: isHolding(v.symbol),
      has_edge: isEdge(v.symbol),
      has_tq: !!flags?.has_tq,
      has_bb: !!flags?.has_bb,
    };
  });

  state.verdicts = verdictRows;
  state.run_id = run.id;
  state.mode = run.mode as RunMode;
  state.finished_at = run.finished_at;
  state.engine = run.engine.includes("llm") ? "llm" : "deterministic";
  state.kpis = {
    universe: run.universe_count,
    in_debate: run.debate_count,
    buy_signals: run.buy_count,
    top_pick:
      verdictRows.length > 0
        ? {
            symbol: verdictRows[0]!.symbol,
            confidence: verdictRows[0]!.confidence,
          }
        : null,
  };

  const n = verdictRows.length;
  const bullN = n;
  const judgeBuy = verdictRows.filter((v) => v.verdict === "BUY").length;
  state.agents = freshAgents().map((a) => {
    if (a.id === "fundamentalist") {
      return { ...a, stat1: n, stat2: "—", status: "done" as const };
    }
    if (a.id === "newsdesk") {
      return { ...a, stat1: "—", stat2: "—", status: "done" as const };
    }
    if (a.id === "bull" || a.id === "bear") {
      return { ...a, stat1: bullN, stat2: "—", status: "done" as const };
    }
    if (a.id === "judge") {
      return { ...a, stat1: n, stat2: judgeBuy, status: "done" as const };
    }
    if (a.id === "messenger") {
      return {
        ...a,
        stat1: run.buy_count,
        stat2: run.engine.replace(/^quant · /, ""),
        status: "done" as const,
      };
    }
    return a;
  });
}

export function isQuantRunBusy(): boolean {
  return state.running;
}

/** Sync scout + technician cards from current BB/TQ scan (no debate). */
export function syncQuantScanCards(
  market: QuantListMarket,
  cap: CapTier | "All",
): AgentCardState[] {
  const universe = countQuantUniverse(market);
  const { bb, tq, hits } = countQuantSignals(market, cap);
  if (!state.agents.length) {
    state.agents = freshAgents();
  }
  state.agents = state.agents.map((a) => {
    if (a.id === "scout") {
      return {
        ...a,
        stat1: universe,
        stat2: hits,
        status: "done" as const,
      };
    }
    if (a.id === "technician") {
      return {
        ...a,
        stat1: tq,
        stat2: bb,
        status: hits > 0 ? ("done" as const) : ("offline" as const),
      };
    }
    return a;
  });
  return structuredClone(state.agents);
}

export async function startQuantRun(opts: {
  mode: RunMode;
  market: QuantListMarket;
  cap: CapTier | "All";
  signal: QuantSignalMode;
}): Promise<void> {
  if (state.running) return;
  if (runPromise) await runPromise;

  const cfg = loadAgentConfig();
  const bbAnd = opts.signal === "both";
  const shortlist = listQuantShortlist(opts.market, opts.cap, bbAnd);
  const { bb, tq, hits } = countQuantSignals(opts.market, opts.cap);
  const universe = countQuantUniverse(opts.market);

  if (shortlist.length === 0) {
    syncQuantScanCards(opts.market, opts.cap);
    state.error = "No TQ/BB hits — run Scan first, then try again.";
    return;
  }

  state = cloneState();
  state.running = true;
  state.mode = opts.mode;
  state.list = opts.market as AgentRunState["list"];
  state.started_at = new Date().toISOString();
  setProgress({
    pct: 3,
    label: "Starting debate",
    detail: `${shortlist.length} TQ/BB hit${shortlist.length === 1 ? "" : "s"} · ${opts.mode}`,
  });

  runPromise = (async () => {
    try {
      const engineKind = await resolveLlmEngine(cfg);
      const engineLabel = await llmEngineLabel(cfg);
      state.engine = engineKind;
      const tickMs = Math.min(cfg.agentDelayMs, 180);

      setProgress({
        pct: 8,
        label: "Scout",
        detail: `Universe ${universe.toLocaleString()} · ${hits} shortlisted`,
      });
      await runAgentPhase("scout", tickMs, () => {
        setAgent("scout", {
          stat1: universe,
          stat2: hits,
          status: "done",
        });
      });

      setProgress({
        pct: 14,
        label: "Technician",
        detail: `TQ ${tq} · BB ${bb}`,
      });
      await runAgentPhase("technician", tickMs, () => {
        setAgent("technician", {
          stat1: tq,
          stat2: bb,
          status: "done",
        });
      });

      state.kpis.universe = universe;
      state.kpis.in_debate = shortlist.length;

      const runId = startRun({
        mode: opts.mode,
        engine: `quant · ${engineLabel}`,
        universeCount: universe,
      });
      state.run_id = runId;

      const verdictRows: VerdictRow[] = [];
      let buyCount = 0;
      let techN = 0;
      let upSum = 0;
      let upN = 0;
      let headSum = 0;
      let toneSum = 0;
      let bullSum = 0;
      let bullN = 0;
      let bearSum = 0;
      let bearN = 0;
      let judgeBuy = 0;

      for (let i = 0; i < shortlist.length; i += 1) {
        const pick = shortlist[i]!;
        setProgress({
          pct: Math.min(
            92,
            Math.round(18 + ((i + 0.35) / shortlist.length) * 74),
          ),
          label: "Debate",
          detail: `${pick.ticker} · ${i + 1}/${shortlist.length}`,
        });

        let ev =
          loadDemoEvidence(pick.ticker) ??
          buildQuantEvidenceLocal(pick.ticker, pick.market);

        if (!ev && opts.mode === "live") {
          try {
            ev = await buildLiveEvidence(pick.ticker, "small");
          } catch {
            ev = null;
          }
        }
        if (!ev) continue;

        ev = attachWeeklySignals({ ...ev, market: pick.market });

        setAgent("technician", { status: "working" });
        setAgent("fundamentalist", { status: "working" });
        setAgent("newsdesk", { status: "working" });
        setProgress({
          pct: Math.min(
            92,
            Math.round(18 + ((i + 0.55) / shortlist.length) * 74),
          ),
          label: workingAgentLabel(),
          detail: `${pick.ticker} · scoring`,
        });
        await sleep(Math.floor(tickMs / 2));

        const evaluation = evaluateQuant(ev);

        techN += 1;
        if (ev.analyst.upside_pct != null) {
          upSum += ev.analyst.upside_pct;
          upN += 1;
        }
        headSum += ev.news.total;
        toneSum += ev.news.positive - ev.news.negative;
        bullSum += evaluation.scores.bull.score;
        bullN += 1;
        bearSum += evaluation.scores.bear.score;
        bearN += 1;

        setAgent("technician", {
          stat1: tq,
          stat2: bb,
          status: "done",
        });
        setAgent("fundamentalist", {
          stat1: techN,
          stat2: upN ? `${Math.round((upSum / upN) * 10) / 10}%` : "—",
          status: "done",
        });
        setAgent("newsdesk", {
          stat1: headSum,
          stat2: toneSum >= 0 ? `+${toneSum}` : toneSum,
          status: "done",
        });

        setAgent("bull", { status: "working" });
        setAgent("bear", { status: "working" });
        setProgress({
          pct: Math.min(
            92,
            Math.round(18 + ((i + 0.75) / shortlist.length) * 74),
          ),
          label: "Bull / Bear",
          detail: `${pick.ticker} · ${i + 1}/${shortlist.length}`,
        });
        await sleep(Math.floor(tickMs / 3));
        setAgent("bull", {
          stat1: bullN,
          stat2: bullN ? Math.round(bullSum / bullN) : "—",
          status: "done",
        });
        setAgent("bear", {
          stat1: bearN,
          stat2: bearN ? Math.round(bearSum / bearN) : "—",
          status: "done",
        });

        setAgent("judge", { status: "working" });
        setProgress({
          pct: Math.min(
            94,
            Math.round(18 + ((i + 0.9) / shortlist.length) * 74),
          ),
          label: "Judge",
          detail: `${pick.ticker} · verdict`,
        });
        await sleep(Math.floor(tickMs / 3));

        const v = evaluation.verdict;
        const fired =
          v.verdict === "BUY" && v.confidence >= cfg.confidenceThreshold;
        if (fired) buyCount += 1;
        if (v.verdict === "BUY") judgeBuy += 1;

        saveVerdict(runId, {
          symbol: ev.symbol,
          name: ev.name,
          cap_segment: ev.cap_segment,
          evaluation,
          fired,
          price: ev.price.live,
          day_change_pct: ev.price.day_change_pct,
        });

        const meta = verdictMeta(ev.symbol, ev.market);
        const weekly = ev.weekly;
        verdictRows.push({
          symbol: ev.symbol,
          name: ev.name,
          cap_segment: ev.cap_segment,
          market: ev.market,
          verdict: v.verdict,
          confidence: v.confidence,
          why: v.rationale,
          key_catalyst: v.key_catalyst,
          winner: v.winner,
          price: ev.price.live,
          day_change_pct: ev.price.day_change_pct,
          rvol: ev.technicals.rvol,
          trend: ev.technicals.trend,
          fired,
          engine: evaluation.engine,
          web: meta.web,
          sc: meta.sc,
          tv: meta.tv,
          about: meta.about,
          headquarters: meta.headquarters,
          has_hold: isHolding(ev.symbol),
          has_edge: isEdge(ev.symbol),
          has_tq: !!weekly?.has_tq,
          has_bb: !!weekly?.has_bb,
        });

        setAgent("judge", {
          stat1: verdictRows.length,
          stat2: judgeBuy,
          status: "done",
        });

        state.verdicts = [...verdictRows].sort(
          (a, b) => b.confidence - a.confidence,
        );
        state.kpis.buy_signals = buyCount;
      }

      setProgress({ pct: 96, label: "Signals", detail: "Logging BUY signals…" });
      await runAgentPhase("messenger", tickMs, () => {
        setAgent("messenger", {
          stat1: buyCount,
          stat2: engineLabel,
          status: "done",
        });
      });

      finishRun(runId, { debateCount: shortlist.length, buyCount });
      verdictRows.sort((a, b) => b.confidence - a.confidence);
      state.verdicts = verdictRows;
      state.kpis.buy_signals = buyCount;
      state.kpis.top_pick =
        verdictRows.length > 0
          ? {
              symbol: verdictRows[0]!.symbol,
              confidence: verdictRows[0]!.confidence,
            }
          : null;
      state.finished_at = new Date().toISOString();
      setProgress({
        pct: 100,
        label: "Done",
        detail: `${verdictRows.length} verdicts · ${buyCount} BUY signal${buyCount === 1 ? "" : "s"}`,
        done: true,
      });
    } catch (err) {
      state.error =
        err instanceof Error ? err.message.slice(0, 200) : "Quant run failed";
      setProgress({
        pct: 100,
        label: "Failed",
        detail: state.error,
        error: true,
      });
    } finally {
      state.running = false;
      runPromise = null;
    }
  })();

  await runPromise;
}
