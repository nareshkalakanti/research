import assert from "node:assert/strict";
import { alignHouseLabelToMembers } from "../src/lib/governance-map";

assert.equal(
  alignHouseLabelToMembers("Hdfc Group", [
    "HDFC Bank Limited",
    "HDFC Life Insurance Company Limited",
  ]),
  "HDFC Group",
);
assert.equal(
  alignHouseLabelToMembers("Icici Group", [
    "ICICI Bank Limited",
    "ICICI Prudential Life Insurance Company Limited",
  ]),
  "ICICI Group",
);
assert.equal(
  alignHouseLabelToMembers("Ageis Group", [
    "Aegis Logistics Limited",
    "Aegis Vopak Terminals Limited",
  ]),
  "Aegis Group",
);
assert.equal(
  alignHouseLabelToMembers("Ghcl Group", ["GHCL Limited", "GHCL Textiles Limited"]),
  "GHCL Group",
);
assert.equal(
  alignHouseLabelToMembers("Beml", ["BEML Limited", "BEML Land Assets Limited"]),
  "BEML",
);
assert.equal(
  alignHouseLabelToMembers("Murugappa Group", [
    "Cholamandalam Investment and Finance Company Limited",
    "Coromandel International Limited",
  ]),
  "Murugappa Group",
);

console.log("house-label-align: ok");
