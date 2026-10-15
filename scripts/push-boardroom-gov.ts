/**
 * Push DINs from boardroomiq.db history into governance.db (additive).
 * Same action as BoardRoomIQ UI "Push DINs → Gov".
 *
 *   npm run push:boardroom-gov
 *   npm run push:boardroom-gov -- --limit 200
 *   npm run push:boardroom-gov -- --unclassified-only
 *
 * Then refresh Dashboard People / Groups / Holdings to see new seats on nodes.
 */
import { pushBoardRoomHistoryToGovernance } from "../src/lib/boardroom-screen";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`Usage:
  npm run push:boardroom-gov
  npm run push:boardroom-gov -- --limit 200
  npm run push:boardroom-gov -- --unclassified-only

Writes additive seats to governance.db (source: boardroomiq_pdf).
Refresh Dashboard People / Groups / Holdings to see updated nodes.`);
    return;
  }

  const limit = Math.min(
    2000,
    Math.max(1, Number(argValue("--limit") || "200") || 200),
  );
  const unclassifiedOnly = hasFlag("--unclassified-only");

  console.log(
    `push:boardroom-gov · limit=${limit} unclassifiedOnly=${unclassifiedOnly}`,
  );

  const result = pushBoardRoomHistoryToGovernance({
    limit,
    unclassifiedOnly,
  });

  console.log(
    `done · attempted ${result.attempted} · rows ${result.pushed_rows} · seats ${result.pushed_seats} · skipped ${result.skipped}`,
  );
  console.log(
    "Refresh Dashboard → People / Groups / Holdings to see updated board nodes.",
  );
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
