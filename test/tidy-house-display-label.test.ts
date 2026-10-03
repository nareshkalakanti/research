import assert from "node:assert/strict";
import { tidyHouseDisplayLabel } from "../src/lib/governance-map";

assert.equal(
  tidyHouseDisplayLabel(
    "Northwind Group (Ada North / Beau North Family)",
    ["Northwind Steels Limited", "Northwind Coatings Limited"],
  ),
  "Northwind Group",
);
assert.equal(
  tidyHouseDisplayLabel(
    "The Northwind Hotels & Allied Cluster",
    ["Northwind Hotels Limited", "Northwind Green Energy Limited"],
  ),
  "Northwind Hotels",
);
assert.equal(
  tidyHouseDisplayLabel("Northwind Cook MIC", [
    "Northwind Cook (India) Limited",
    "Quess Partner Limited",
  ]),
  "Northwind Cook",
);
assert.equal(
  tidyHouseDisplayLabel(
    "Birch",
    ["Cedar Amman Sugars Limited", "Cedar Amman Spinning Mills Limited"],
  ),
  "Cedar Group",
);
assert.equal(
  tidyHouseDisplayLabel(
    "The Northwind Group (Birch Family)",
    ["NOCIL Limited", "Mafatlal Industries Limited"],
    { otherMemberFirsts: ["Northwind"] },
  ),
  "Mafatlal Group",
);

assert.equal(
  tidyHouseDisplayLabel("Murugappa Group", [
    "Cholamandalam Investment and Finance Company Limited",
    "Coromandel International Limited",
  ]),
  "Murugappa Group",
);
