import assert from "node:assert/strict";
import { localOcrLooksUseful } from "../src/lib/ocr-fast";

assert.equal(localOcrLooksUseful(""), false);
assert.equal(localOcrLooksUseful("abc"), false);
assert.equal(
  localOcrLooksUseful(
    "Directors of NAPEROL INVESTMENTS\n00422067 MINNIE AARASP BODHANWALA Director 2016-08-11\n08730235 RAJIV ARORA Director 2020-08-25",
  ),
  true,
);
assert.equal(localOcrLooksUseful("@@@ ### $$$ %%% *** ??? !!!"), false);
console.log("ok");
