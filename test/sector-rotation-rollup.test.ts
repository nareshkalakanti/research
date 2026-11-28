import assert from "node:assert/strict";
import {
  isRollupSectorId,
  membersForStockscansSector,
  resolveRotationSector,
  rollupSectorLabel,
} from "../src/lib/sector-rotation-board";
import { listRotationSectors } from "../src/lib/sector-rotation";
import { masterLabels } from "../src/lib/stock-master";

assert.equal(isRollupSectorId("rollup:Power Infrastructure"), true);
assert.equal(isRollupSectorId("sec-abc"), false);
assert.equal(rollupSectorLabel("rollup:Power Infrastructure"), "Power Infrastructure");

const industries = listRotationSectors();
assert.ok(industries.length > 0, "expected rotation industry baskets");

const solar = industries.find((s) => s.label === "Solar EPC");
if (solar && solar.members.length > 0) {
  const labels = masterLabels();
  const bySec = new Map<string, number>();
  for (const m of solar.members) {
    const sec = labels.get(m.ticker.toUpperCase())?.sector?.trim() || "(none)";
    bySec.set(sec, (bySec.get(sec) ?? 0) + 1);
  }
  // Industry spans multiple StockScans sectors — the overlap case we fixed.
  if (bySec.size > 1) {
    const power = membersForStockscansSector("Power Infrastructure");
    const powerSet = new Set(power.map((m) => m.ticker.toUpperCase()));
    for (const m of solar.members) {
      const t = m.ticker.toUpperCase();
      const trueSec = labels.get(t)?.sector?.trim();
      if (trueSec === "Power Infrastructure") {
        assert.ok(powerSet.has(t), `${t} should be in Power Infrastructure rollup`);
      } else if (trueSec) {
        assert.ok(
          !powerSet.has(t),
          `${t} (${trueSec}) must not leak into Power Infrastructure via Solar EPC`,
        );
      }
    }
  }
}

const rollup = resolveRotationSector("rollup:Power Infrastructure");
if (rollup) {
  assert.equal(rollup.id, "rollup:Power Infrastructure");
  assert.ok(rollup.members.length >= 1);
  const labels = masterLabels();
  for (const m of rollup.members) {
    const sec = labels.get(m.ticker.toUpperCase())?.sector?.trim();
    assert.equal(
      sec,
      "Power Infrastructure",
      `${m.ticker} in rollup has sector ${sec}`,
    );
  }
}

console.log("sector-rotation-rollup.test.ts: ok");
