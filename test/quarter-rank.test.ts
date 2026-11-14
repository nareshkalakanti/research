import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quarterRankFromPanel } from "../src/lib/quarter-rank";
import type { QuarterPanel } from "../src/lib/quarter-panel";

function panel(partial: {
  labels: string[];
  sales: Array<number | null>;
  np: Array<number | null>;
}): QuarterPanel {
  return {
    labels: partial.labels,
    rows: [
      { label: "Sales", values: partial.sales, good_up: true, decimals: 0 },
      {
        label: "Net Profit",
        values: partial.np,
        good_up: true,
        decimals: 0,
      },
      {
        label: "Operating Profit",
        values: partial.sales.map((v) => (v == null ? null : v * 0.1)),
        good_up: true,
        decimals: 0,
      },
    ],
  };
}

describe("quarterRankFromPanel", () => {
  it("scores strong sales + profit growth high on the 0–10 scale", () => {
    const r = quarterRankFromPanel(
      panel({
        labels: ["Sep 2024", "Dec 2024", "Mar 2025", "Jun 2025", "Sep 2025"],
        sales: [100, 110, 120, 130, 150],
        np: [10, 12, 14, 16, 20],
      }),
    );
    assert.ok(r);
    assert.equal(r!.band, "Strong");
    assert.equal(r!.ratingLabel, "Strong");
    assert.ok(r!.score >= 7 && r!.score <= 10);
    assert.ok(r!.metrics.some((m) => m.id === "sales_yoy"));
  });

  it("penalises a profit drop even when sales grow (not 'Growing')", () => {
    // Mirrors Dec 2025 → Sep 2026 panel: sales +6.5% YoY, NP −28.4% YoY.
    const r = quarterRankFromPanel(
      panel({
        labels: ["Sep 2025", "Dec 2025", "Mar 2026", "Jun 2026", "Sep 2026"],
        sales: [1588, 1617, 1711, 1675, 1691],
        np: [169, 133, 163, 116, 121],
      }),
    );
    assert.ok(r);
    assert.ok(r!.score < 5.5, `score ${r!.score}`);
    assert.notEqual(r!.band, "Growing");
    assert.match(r!.summary, /Profit −?-?28/);
  });

  it("returns null when panel has no growth pairs", () => {
    const r = quarterRankFromPanel(
      panel({
        labels: ["Sep 2025"],
        sales: [100],
        np: [10],
      }),
    );
    assert.equal(r, null);
  });
});
