import assert from "node:assert/strict";
import { visionChoiceText } from "../src/lib/corporate-data-extract";

assert.equal(
  visionChoiceText({
    choices: [{ message: { content: "  DIN 00000001 Alice  " } }],
  }),
  "DIN 00000001 Alice",
);
assert.equal(
  visionChoiceText({
    choices: [
      {
        message: {
          content: [{ type: "text", text: "Personnel of Example" }],
        },
      },
    ],
  }),
  "Personnel of Example",
);
assert.equal(
  visionChoiceText({ message: { content: "native ollama" } }),
  "native ollama",
);
assert.equal(visionChoiceText({ choices: [{ message: { content: "" } }] }), "");
console.log("ok");
