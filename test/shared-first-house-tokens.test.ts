import assert from "node:assert/strict";
import {
  nameBrandForcedMergeAllowed,
  sharedFirstHouseTokens,
} from "../src/lib/governance-map";

const brands = sharedFirstHouseTokens([
  "Northwind Limited",
  "Northwind Steels Limited",
  "Northwind Coatings Ltd",
  "Northwind Aluminium Company Limited",
  "Solo Holdings Limited",
]);
assert.equal(brands.has("Northwind"), true);
assert.equal(brands.has("Solo"), false);
assert.equal(
  sharedFirstHouseTokens(["Bajaj Auto Limited", "Bajaj Finance Limited"]).has(
    "Bajaj",
  ),
  false,
);

const one = sharedFirstHouseTokens(["Northwind Limited"]);
assert.equal(one.has("Northwind"), false);

assert.equal(
  nameBrandForcedMergeAllowed(
    "Agarwal",
    [
      {
        label: "Dr. Agarwals Healthcare Group",
        add: ["HOSP"],
        remove: ["GLASS"],
      },
    ],
    (t) => (t === "GLASS" || t === "HOSP" ? "Agarwal" : undefined),
  ),
  false,
);
assert.equal(
  nameBrandForcedMergeAllowed("Northwind", [], () => "Northwind"),
  true,
);

console.log("ok");
