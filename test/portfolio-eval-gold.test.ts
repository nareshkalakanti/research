/**
 * Portfolio evaluation gold — structural rules always; live score vs latest
 * screenshot snapshot when LIVE_SCORE=1.
 *
 *   npx tsx test/portfolio-eval-gold.test.ts
 *   LIVE_SCORE=1 npx tsx test/portfolio-eval-gold.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RATING, scoreReviewTicker } from "../src/lib/portfolio-review";

const gold = JSON.parse(
  readFileSync(join(__dirname, "portfolio-review/eval-table.gold.json"), "utf8"),
) as {
  snapshots: Array<{
    id: string;
    rows: Array<{
      t: string;
      fundamental: number;
      management: number;
      quality: number;
      valuation: number;
      total: number;
      rating: string;
    }>;
  }>;
};

function ratingFor(total: number, hasData: boolean): string {
  if (!hasData) return "No data";
  if (total >= RATING.excellent) return "Excellent";
  if (total >= RATING.good) return "Good";
  if (total >= RATING.average) return "Average";
  return "Poor";
}

// --- Fixture sanity (no network) ---
for (const snap of gold.snapshots) {
  for (const r of snap.rows) {
    assert.equal(
      r.quality,
      r.fundamental + r.management,
      `${snap.id} ${r.t}: quality must be F+M`,
    );
    assert.equal(
      r.total,
      r.quality + r.valuation,
      `${snap.id} ${r.t}: total must be quality+valuation`,
    );
    assert.equal(
      r.rating,
      ratingFor(r.total, true),
      `${snap.id} ${r.t}: rating vs total ${r.total}`,
    );
  }
}

/** Every gold row for a ticker (screenshots can differ across the day). */
const byTicker = new Map<string, Array<(typeof gold.snapshots)[0]["rows"][0] & { snap: string }>>();
for (const snap of gold.snapshots) {
  for (const r of snap.rows) {
    const list = byTicker.get(r.t) ?? [];
    list.push({ ...r, snap: snap.id });
    byTicker.set(r.t, list);
  }
}

async function liveCheck(): Promise<void> {
  for (const [t, golds] of byTicker) {
    const row = await scoreReviewTicker(t);
    assert.equal(row.quality, row.fundamental + row.management, `${t} live Q=F+M`);
    assert.equal(row.total, row.quality + row.valuation, `${t} live T=Q+V`);
    // Prefer a gold row within ±1 on F and M; otherwise warn (mid-score UI
    // captures and peer/price moves are expected).
    const hit = golds.find(
      (g) =>
        Math.abs(row.fundamental - g.fundamental) <= 1 &&
        Math.abs(row.management - g.management) <= 1,
    );
    const nearest = hit ?? golds[golds.length - 1]!;
    if (!hit) {
      console.warn(
        `[warn] ${t} F${row.fundamental}/M${row.management} not near gold ` +
          golds.map((g) => `${g.snap}:F${g.fundamental}/M${g.management}`).join(", "),
      );
    }
    if (row.valuation !== nearest.valuation) {
      console.warn(
        `[warn] ${t} valuation ${row.valuation} vs gold ${nearest.valuation} (${nearest.snap}) — peers/price drift`,
      );
    }
  }
}

void (async () => {
  if (process.env.LIVE_SCORE === "1") await liveCheck();
  console.log(
    `ok · ${gold.snapshots.length} snapshots · ${byTicker.size} tickers` +
      (process.env.LIVE_SCORE === "1" ? " · live checked" : " · set LIVE_SCORE=1 for live"),
  );
})();
