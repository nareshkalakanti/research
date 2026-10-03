import assert from "node:assert/strict";
import {
  isBareGenericHouseLabel,
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

assert.equal(
  sharedFirstHouseTokens([
    "Bharat Electronics Limited",
    "LG Electronics India Limited",
    "Electronics Mart India Limited",
  ]).has("Electronics"),
  false,
);
assert.equal(
  sharedFirstHouseTokens([
    "Premier Energies Limited",
    "Premier Explosives Limited",
    "Premier Polyfilm Limited",
  ]).has("Premier"),
  false,
);

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

assert.equal(isBareGenericHouseLabel("Electronics"), true);
assert.equal(isBareGenericHouseLabel("Premier Group"), true);
assert.equal(isBareGenericHouseLabel("Tata Group"), false);
assert.equal(isBareGenericHouseLabel("Premier Energies"), false);

console.log("ok");
