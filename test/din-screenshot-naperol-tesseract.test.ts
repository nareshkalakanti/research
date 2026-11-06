import assert from "node:assert/strict";
import {
  cleanCompanyLabel,
  parseScreenshotBoard,
} from "../src/lib/din-screenshot-parse";

// Exact Tesseract output shape from a Zauba "Current Directors" screenshot.
const ocr = `
Directors & Key Managerial Personnel of NAPEROL INVESTMENTS A
Current Directors & Key Managerial Personnel of NAPEROL INVESTMENTS

DIN Director Name Designation Appointment Date

00422067 MINNIE AARASP BODHANWALA Director 2016-08-11

08730235 RAJIV ARORA Director 2020-08-25

02874749 PARVATHI MENON Director 2023-05-07

00352598 VIRAF RUSTOM MEHTA Director 2019-08-06

00020764 RAJESH KUMAR BATRA Director 2019-08-11

00036049 NESS NUSLI WADIA Director 1997-03-18
`;

assert.equal(cleanCompanyLabel("NAPEROL INVESTMENTS A"), "NAPEROL INVESTMENTS");

const parsed = parseScreenshotBoard(ocr);
assert.equal(parsed.company, "NAPEROL INVESTMENTS");
assert.equal(parsed.seats.length, 6);
assert.equal(parsed.seats[0]?.din, "00422067");
assert.equal(parsed.seats[0]?.name, "Minnie Aarasp Bodhanwala");
assert.match(parsed.seats[0]?.designation || "", /^Director$/i);
assert.equal(parsed.seats[0]?.as_of, "2016-08-11");
assert.equal(parsed.seats[5]?.din, "00036049");
assert.equal(parsed.seats[5]?.name, "Ness Nusli Wadia");
assert.equal(parsed.seats[5]?.as_of, "1997-03-18");
console.log("ok");
