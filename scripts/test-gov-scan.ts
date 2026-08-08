import { pendingGovernanceJobs } from "../src/lib/governance-scan";
import { createNseSession, fetchBoardFromNse } from "../src/lib/nse-governance";
import {
  diffIdentities,
  saveCompanyBoard,
  snapshotIdentities,
} from "../src/lib/governance-write";

async function main() {
  const p = pendingGovernanceJobs({ market: "NSE", missingOnly: true });
  console.log("pending", p.length, "first", p[0]?.ticker);

  const jar = await createNseSession();
  const board = await fetchBoardFromNse("TCS", "NSE", jar);
  console.log(
    "TCS seats",
    board?.seats?.length,
    "source",
    board?.source,
    "sample",
    board?.seats?.slice(0, 2),
  );

  if (board?.seats?.length) {
    const before = snapshotIdentities();
    const saved = saveCompanyBoard({
      ticker: "TCS",
      name: board.name,
      market: "NSE",
      seats: board.seats,
      notes: board.source,
      replaceSeats: true,
      protectDinBoard: false,
    });
    const diff = diffIdentities(before);
    console.log(
      "save",
      saved,
      "newDins",
      diff.newDins.length,
      "newDirs",
      diff.newDirectors.length,
      "newSeats",
      diff.newSeats,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
