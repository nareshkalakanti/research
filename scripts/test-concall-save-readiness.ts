/**
 * Pre-save checklist for Concall PASS persist.
 * Catches cases like RAMRAT: exec snapshot has revenue but reported_financials
 * was never mapped — must fail readiness until snapshot is applied.
 *
 *   npm run test:concall-save-readiness
 */
import fs from "fs";
import path from "path";
import {
  concallSaveReadiness,
  ensureFinancialsFromQuantSnapshot,
  type ConcallExtract,
} from "../src/lib/concall-screen";
import { applyExecutiveSnapshotToFinancials } from "../src/lib/concall-quant-extract";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function main() {
  const fixturePath = path.join(
    process.cwd(),
    "test",
    "concall-save-readiness.ramrat.json",
  );
  const extract = JSON.parse(
    fs.readFileSync(fixturePath, "utf8"),
  ) as ConcallExtract;

  const before = concallSaveReadiness(extract);
  console.log("Before map:", {
    ready: before.ready,
    gaps: before.gaps,
  });
  assert(!before.ready, "expected not ready with empty reported_financials");
  assert(
    before.gaps.some((g) => g.field === "revenue_cr"),
    "expected revenue_cr gap when snapshot exists but revenue not mapped",
  );

  const exec = (
    extract.quant as { executive_summary?: Record<string, unknown> }
  )?.executive_summary;
  applyExecutiveSnapshotToFinancials(extract, exec);
  const rev = (
    extract.reported_financials as { revenue?: { current_qtr?: number } }
  )?.revenue;
  console.log("After map revenue:", rev);
  assert(
    typeof rev?.current_qtr === "number" && rev.current_qtr > 0,
    "expected reported_financials.revenue.current_qtr from snapshot",
  );

  const after = concallSaveReadiness(extract);
  console.log("After map:", {
    ready: after.ready,
    gaps: after.gaps,
  });
  assert(after.ready, "expected ready after mapping executive snapshot");
  assert(
    !after.gaps.some((g) => g.field === "revenue_cr"),
    "revenue_cr gap should clear after map",
  );

  // PASS-list backfill helper (stale DB row shape)
  const stale = JSON.parse(
    fs.readFileSync(fixturePath, "utf8"),
  ) as ConcallExtract;
  assert(
    ensureFinancialsFromQuantSnapshot(stale) === true,
    "ensureFinancialsFromQuantSnapshot should mutate empty financials",
  );
  assert(
    concallSaveReadiness(stale).ready,
    "stale row should become ready after ensureFinancialsFromQuantSnapshot",
  );
  assert(
    ensureFinancialsFromQuantSnapshot(stale) === false,
    "second ensure should be no-op",
  );

  // Missing tone still blocks
  const noTone = structuredClone(extract) as ConcallExtract;
  (noTone.management_tone as { overall_tone?: string | null }).overall_tone =
    null;
  const toneGaps = concallSaveReadiness(noTone);
  assert(
    toneGaps.gaps.some((g) => g.field === "tone"),
    "expected tone gap when overall_tone missing",
  );

  const unlabeled: ConcallExtract = {
    metadata: {
      company_name: "Example Industrials Limited",
      nse_symbol: "EXIND",
      quarter: "Q2",
      fiscal_year: "FY27",
    },
    management_tone: { overall_tone: "neutral" },
    reported_financials: {},
    card: {
      highlights: [{ text: "Capacity Addition", polarity: "positive" }],
    },
    quant: {
      executive_summary: {
        financial_snapshot: {
          revenue: { q2_fy27: 210.5 },
        },
      },
    },
    corporate_actions: [],
    key_catalysts: [],
  };
  applyExecutiveSnapshotToFinancials(
    unlabeled,
    (
      unlabeled.quant as {
        executive_summary?: Record<string, unknown>;
      }
    ).executive_summary,
  );

  const invented: ConcallExtract = {
    ...unlabeled,
    docs: {
      combined:
        "Moderator: Welcome to the earnings conference call. Gross margin was 11.3% to 20.3%.",
    },
    quant: {
      executive_summary: {
        financial_snapshot: {
          revenue: { current_qtr_inr_cr: 83.03 },
          ebitda: { margin_pct: 15.48 },
        },
      },
    },
    reported_financials: {},
  };
  applyExecutiveSnapshotToFinancials(
    invented,
    (
      invented.quant as {
        executive_summary?: Record<string, unknown>;
      }
    ).executive_summary,
    "Moderator: Welcome to the earnings conference call. Gross margin was 11.3% to 20.3%.",
  );
  const inventedRev = (
    invented.reported_financials as { revenue?: { current_qtr?: number } }
  )?.revenue;
  assert(
    inventedRev?.current_qtr == null,
    "spoken call without printed ₹ cr must not take invented snapshot revenue",
  );

  const lacsGround: ConcallExtract = {
    ...unlabeled,
    docs: { combined: "" },
    reported_financials: {},
    quant: {
      executive_summary: {
        financial_snapshot: {
          revenue: { current_qtr_inr_cr: 83.03 },
        },
      },
    },
  };
  applyExecutiveSnapshotToFinancials(
    lacsGround,
    (
      lacsGround.quant as {
        executive_summary?: Record<string, unknown>;
      }
    ).executive_summary,
    "STATEMENT OF FINANCIAL RESULTS (Amount in Rs. Lacs) Total Income 8,303.05",
  );
  const lacsRev = (
    lacsGround.reported_financials as { revenue?: { current_qtr?: number } }
  )?.revenue;
  assert(
    lacsRev?.current_qtr === 83.03,
    "lacs print must ground snapshot ₹ Cr (÷100)",
  );
  const unlabeledRev = (
    unlabeled.reported_financials as {
      revenue?: { current_qtr?: number };
    }
  )?.revenue;
  assert(
    unlabeledRev?.current_qtr === 210.5,
    "period keys without ₹cr must still map to current_qtr",
  );
  assert(
    !concallSaveReadiness(unlabeled).gaps.some((g) => g.field === "revenue_cr"),
    "revenue_cr gap should clear for unlabeled snapshot keys",
  );

  console.log("OK · concall save readiness");
}

main();
