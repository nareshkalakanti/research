import assert from "node:assert/strict";
import {
  isPlaceholderWatch,
  usableWatchText,
  dropPlaceholderLines,
} from "../src/lib/brief-placeholder";

assert.equal(isPlaceholderWatch("No specific risks mentioned"), true);
assert.equal(
  isPlaceholderWatch("Company name (current): Example Ltd"),
  true,
);
assert.equal(usableWatchText("No specific risks mentioned"), "");
assert.equal(
  dropPlaceholderLines(
    "No specific risks mentioned\nCompany name (current): Example Ltd\nAPI mix shift",
  ),
  "API mix shift",
);
assert.equal(isPlaceholderWatch("Working-capital cycle vs API prices"), false);
console.log("ok");
