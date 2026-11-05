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
  it("scores rising sales YoY/QoQ as Growing with positive mean", () => {
    const r = quarterRankFromPanel(
      panel({
        labels: ["Sep 2024", "Dec 2024", "Mar 2025", "Jun 2025", "Sep 2025"],
        sales: [100, 110, 120, 130, 150],
        np: [10, 12, 14, 16, 20],
      }),
    );
    assert.ok(r);
    assert.equal(r!.signal, "Growing");
    assert.equal(r!.ratingLabel, "Growing");
    assert.ok(r!.score > 0);
    assert.ok(r!.metrics.some((m) => m.id === "sales_yoy"));
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
