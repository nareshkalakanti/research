/**
 * Multi-agent dashboard smoke test.
 * Run: npm run test:agents
 */
import assert from "node:assert/strict";
import { loadAgentConfig } from "../src/lib/agents/config";
import { loadDemoBundles, countUniverseEntries, listUniverseEntries } from "../src/lib/agents/evidence";
import { evaluateDeterministic } from "../src/lib/agents/scoring";
import { verifyEvaluation } from "../src/lib/agents/verify";
import {
  finishRun,
  listBuySignals,
  listRecentVerdicts,
  saveVerdict,
  startRun,
} from "../src/lib/agents/store";

function main() {
  const cfg = loadAgentConfig();
  assert.ok(cfg.confidenceThreshold >= 1 && cfg.confidenceThreshold <= 10);

  const bundles = loadDemoBundles("All");
  assert.ok(bundles.length >= 1, "demo_agents/*.json required");

  const nseUni = listUniverseEntries("NSE");
  assert.ok(nseUni.length >= 500, "NSE scout universe should use full DB");
  const smeUni = listUniverseEntries("NSE SME");
  assert.ok(smeUni.every((e) => e.market === "NSE SME"));
  const holdUni = listUniverseEntries("Hold");
  assert.ok(holdUni.length >= 1, "Hold scout universe");
  const edgeUni = listUniverseEntries("Edge");
  assert.ok(edgeUni.length >= 1, "Edge scout universe");
  assert.ok(countUniverseEntries("All") >= nseUni.length);

  for (const ev of bundles) {
    assert.ok(ev.symbol, "symbol required");
    assert.ok(Array.isArray(ev.data_gaps), "data_gaps array required");

    const result = evaluateDeterministic(ev);
    assert.ok(["BUY", "WATCH", "AVOID"].includes(result.verdict.verdict));
    assert.ok(
      result.verdict.confidence >= 1 && result.verdict.confidence <= 10,
      `${ev.symbol} confidence`,
    );
    assert.equal(result.engine, "deterministic");

    const warnings = verifyEvaluation(ev, result);
    assert.ok(Array.isArray(warnings));
  }

  const runId = startRun({
    mode: "demo",
    engine: "deterministic",
    universeCount: bundles.length,
  });
  assert.ok(runId > 0);

  let buyCount = 0;
  for (const ev of bundles) {
    const evaluation = evaluateDeterministic(ev);
    const fired =
      evaluation.verdict.verdict === "BUY" &&
      evaluation.verdict.confidence >= cfg.confidenceThreshold;
    if (fired) buyCount += 1;
    saveVerdict(runId, {
      symbol: ev.symbol,
      name: ev.name,
      cap_segment: ev.cap_segment,
      evaluation,
      fired,
      price: ev.price.live,
      day_change_pct: ev.price.day_change_pct,
    });
  }

  finishRun(runId, { debateCount: bundles.length, buyCount });

  const recent = listRecentVerdicts(5);
  assert.ok(recent.length >= 1);
  const signals = listBuySignals(5);
  assert.ok(Array.isArray(signals));

  console.log(
    `OK: ${bundles.length} demo bundles · ${buyCount} BUY signal(s) at threshold ${cfg.confidenceThreshold}`,
  );
}

main();
