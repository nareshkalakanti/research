/**
 * Pairing invariants for Post-Concall Announcement Drift.
 * Synthetic events only — no issuer gold numbers.
 * Run: npx tsx scripts/test-concall-drift-pair.ts
 */
import assert from "node:assert/strict";
import type { NseCorpEvent } from "../src/lib/nse-corp-events";
import {
  isPrimaryBoardEarn,
  pairEarnConcall,
} from "../src/lib/strategy/concall-drift-pair";

function ev(
  partial: Pick<NseCorpEvent, "kind" | "announced_at" | "subject"> & {
    title?: string;
  },
): NseCorpEvent {
  return {
    ticker: "TESTCO",
    seq_id: null,
    title: partial.title ?? partial.subject,
    url: null,
    ...partial,
  };
}

function main() {
  const clarification = ev({
    kind: "earn",
    announced_at: "2026-09-03T11:00:00.000Z",
    subject: "Clarification - Financial Results",
  });
  assert.equal(isPrimaryBoardEarn(clarification), false);

  const outcome = ev({
    kind: "earn",
    announced_at: "2026-08-01T19:00:00.000Z",
    subject: "Outcome of Board Meeting",
  });
  assert.equal(isPrimaryBoardEarn(outcome), true);

  const pre = ev({
    kind: "concall",
    announced_at: "2026-07-29T12:00:00.000Z",
    subject: "Analysts/Institutional Investor Meet/Con. Call Updates",
  });
  const post = ev({
    kind: "concall",
    announced_at: "2026-08-06T13:00:00.000Z",
    subject: "Analysts/Institutional Investor Meet/Con. Call Updates",
  });

  const pairs = pairEarnConcall([clarification, outcome, pre, post]);
  assert.equal(pairs.length, 1, "clarification earn skipped");
  assert.equal(pairs[0]!.earn.announced_at, outcome.announced_at);
  assert.equal(
    pairs[0]!.concall?.announced_at,
    post.announced_at,
    "post-earn concall preferred; pre-earn ignored when post exists",
  );

  const onlyPre = pairEarnConcall([outcome, pre]);
  assert.equal(onlyPre.length, 1);
  assert.equal(
    onlyPre[0]!.concall,
    null,
    "pre-earn schedule alone does not fill Concall column",
  );

  console.log("ok — concall drift pairing");
}

main();
