import { loadAgentConfig } from "./config";
import {
  countUniverseEntries,
  loadDemoBundles,
  scoutShortlistLive,
} from "./evidence";
import { evaluateWithEngine, llmEngineLabel, resolveLlmEngine } from "./llm";
import { finishRun, saveVerdict, startRun } from "./store";
import { loadAllCompanies } from "@/lib/db";
import { isEdge } from "@/lib/edge";
import { isHolding } from "@/lib/holdings";
import { researchLinks } from "@/lib/links";
import {
  AGENT_DEFS,
  type AgentCardState,
  type AgentRunState,
  type ListMarket,
  type RunMode,
  type VerdictRow,
} from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

function freshAgents(): AgentCardState[] {
  return AGENT_DEFS.map((d) => ({
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

let state: AgentRunState = cloneState();
let runPromise: Promise<void> | null = null;

function setAgent(id: string, patch: Partial<AgentCardState>) {
  state.agents = state.agents.map((a) =>
    a.id === id ? { ...a, ...patch } : a,
  );
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

export function getAgentRunState(): AgentRunState {
  return structuredClone(state);
}

export function isAgentRunBusy(): boolean {
  return state.running;
}

export async function startAgentRun(
  mode: RunMode,
  list: ListMarket = "NSE",
): Promise<void> {
  if (state.running) return;
  if (runPromise) await runPromise;

  const cfg = loadAgentConfig();
  state = cloneState();
  state.running = true;
  state.mode = mode;
  state.list = list;
  state.started_at = new Date().toISOString();

  runPromise = (async () => {
    try {
      const engineKind = await resolveLlmEngine(cfg);
      const engineLabel = await llmEngineLabel(cfg);
      state.engine = engineKind;

      let bundles: ReturnType<typeof loadDemoBundles>;
      let universeCount: number;
      let scanned: number;

      await runAgentPhase("scout", cfg.agentDelayMs, async () => {
        if (mode === "demo") {
          bundles = loadDemoBundles(list);
          universeCount = countUniverseEntries(list);
          scanned = bundles.length;
        } else {
          universeCount = countUniverseEntries(list);
          const live = await scoutShortlistLive(cfg.shortlistPerBucket, list);
          bundles = live.bundles;
          scanned = live.scanned;
        }
        setAgent("scout", {
          stat1: scanned,
          stat2: bundles!.length,
          status: "done",
        });
      });

      state.kpis.universe = universeCount!;
      state.kpis.in_debate = bundles!.length;

      const runId = startRun({
        mode,
        engine: engineLabel,
        universeCount: universeCount!,
      });
      state.run_id = runId;

      const verdictRows: VerdictRow[] = [];
      let buyCount = 0;
      let techN = 0;
      let rvolSum = 0;
      let rvolCount = 0;
      let upSum = 0;
      let upN = 0;
      let headSum = 0;
      let toneSum = 0;
      let bullSum = 0;
      let bullN = 0;
      let bearSum = 0;
      let bearN = 0;
      let judgeBuy = 0;

      for (let i = 0; i < bundles!.length; i += 1) {
        const ev = bundles![i]!;

        setAgent("technician", { status: "working" });
        setAgent("fundamentalist", { status: "working" });
        setAgent("newsdesk", { status: "working" });
        await sleep(Math.floor(cfg.agentDelayMs / 2));

        const evaluation = await evaluateWithEngine(ev, cfg, engineKind);

        techN += 1;
        if (ev.technicals.rvol != null) {
          rvolSum += ev.technicals.rvol;
          rvolCount += 1;
        }
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
          stat1: techN,
          stat2:
            rvolCount > 0
              ? `${Math.round((rvolSum / rvolCount) * 10) / 10}×`
              : "—",
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
        await sleep(Math.floor(cfg.agentDelayMs / 3));
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
        await sleep(Math.floor(cfg.agentDelayMs / 3));

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
        state.kpis.top_pick =
          verdictRows.length > 0
            ? {
                symbol: [...verdictRows].sort(
                  (a, b) => b.confidence - a.confidence,
                )[0]!.symbol,
                confidence: [...verdictRows].sort(
                  (a, b) => b.confidence - a.confidence,
                )[0]!.confidence,
              }
            : null;
      }

      await runAgentPhase("messenger", cfg.agentDelayMs, () => {
        setAgent("messenger", {
          stat1: buyCount,
          stat2: engineLabel,
          status: "done",
        });
      });

      finishRun(runId, { debateCount: bundles!.length, buyCount });

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
    } catch (err) {
      state.error =
        err instanceof Error ? err.message.slice(0, 200) : "Agent run failed";
      for (const a of state.agents) {
        if (a.status === "working") setAgent(a.id, { status: "offline" });
      }
    } finally {
      state.running = false;
      runPromise = null;
    }
  })();

  await runPromise;
}

export function markAgentsOffline() {
  state.agents = freshAgents();
}
