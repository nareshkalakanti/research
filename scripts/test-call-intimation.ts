import assert from "node:assert/strict";
import {
  isCallIntimationBlob,
  isCallIntimationHit,
  isFinancialResultsBlob,
  isFinancialResultsHit,
  followPdfUrlFromIntimation,
  looksLikeEnclosedEarningsDeck,
} from "../src/lib/call-intimation";
import { classifyConcallDocument } from "../src/lib/concall-screen";

const cover = `Date: 24.08.2026
Sub: Audio Recording of Earnings Conference Call
Pursuant to Regulation 30 of the Securities and Exchange Board of India
this is to inform that the audio recording of the Earnings Conference Call
held today i.e., August 24, 2026
https://example.com/audio.mp3
Thanking you`;

assert.equal(isCallIntimationBlob(cover), true);
assert.equal(
  isCallIntimationHit({
    url: "https://nsearchives.nseindia.com/corporate/EXAMPLE_24082026_Covering_letter.pdf",
    title: "Concall transcript",
    kind: "concall",
  }),
  true,
);
assert.equal(classifyConcallDocument(cover).label, "Call intimation");
assert.equal(
  isCallIntimationBlob(
    "Moderator: Ladies and gentlemen, welcome to the earnings conference call. Revenue was 210.5 cr.",
  ),
  false,
);

const resultsHead = `Sub: Regulation 30 and 33 — Outcome of Board Meeting
considered and approved the Audited Financial Results (Standalone and Consolidated)
STATEMENT OF CONSOLIDATED AUDITED FINANCIAL RESULTS
(Amount in Rs. Lacs)
Revenue from Operations 3,721.95`;
assert.equal(isFinancialResultsBlob(resultsHead), true);
assert.equal(isCallIntimationBlob(resultsHead), false);
assert.equal(
  isFinancialResultsHit({
    title: "Financial results",
    url: "https://nsearchives.nseindia.com/corporate/EXAMPLE_24052025_Outcome.pdf",
    kind: "other",
  }),
  true,
);
assert.equal(classifyConcallDocument(resultsHead).label, "Financial results");

const txLetter = `Subject: Transcript of Q1 FY27 Earnings Conference Call
Pursuant to Regulation 30 of the Listing Regulations
the transcript of the Earnings Conference Call held on July 22, 2026
has been uploaded on the Company's website.
The transcript can also be accessed through the following link:
https://www.example.com/pdf/others/Issuer_Q1FY27_EarningsCall_
Transcript-270726.pdf
Thanking you`;
assert.equal(isCallIntimationBlob(txLetter), true);
assert.equal(
  followPdfUrlFromIntimation(txLetter, "transcript"),
  "https://www.example.com/pdf/others/Issuer_Q1FY27_EarningsCall_Transcript-270726.pdf",
);

const pptLetter = `Subject: Investor Presentation
Please find attached the Investor Presentation on the Unaudited Financial Results
of the Company for the quarter ended June 30, 2026.
Kindly take the same on record.
Thanking you`;
assert.equal(isCallIntimationBlob(pptLetter), true);
assert.equal(followPdfUrlFromIntimation(pptLetter, "ppt"), null);

const meetOutcome = `Date: 19 May 2026
Sub: Disclosure under Regulation 30 of the Securities and Exchange Board of India
(Listing Obligations and Disclosure Requirements) Regulations, 2015 — Outcome of
Meeting of Analysts / Institutional Investors.
Further to our letter dated 13 May 2026, the meeting with the Analyst or
Institutional Investor was organized on 19 May 2026.
Kindly take the same on record.
Thanking you`;
assert.equal(isCallIntimationBlob(meetOutcome), true);
assert.equal(classifyConcallDocument(meetOutcome).label, "Call intimation");
assert.equal(
  isFinancialResultsHit({
    title: "Outcome Of Board Meeting Held On 12Th August, 2026",
    url: "https://nsearchives.nseindia.com/corporate/EXAMPLE_12082026.pdf",
    kind: "other",
  }),
  false,
);
assert.equal(
  isFinancialResultsHit({
    title: "Financial results",
    url: "https://nsearchives.nseindia.com/corporate/EXAMPLE_24052025_Outcome.pdf",
    kind: "other",
  }),
  true,
);

assert.equal(
  isCallIntimationHit({
    url: "https://nsearchives.nseindia.com/corporate/EXAMPLE_15052026170220_SELtrOutcomeInvconcall15052026CSDSC.pdf",
    title: "Outcome of Meeting - Analysts / Institutional Investors",
    kind: "concall",
  }),
  true,
);
assert.equal(
  isFinancialResultsHit({
    url: "https://nsearchives.nseindia.com/corporate/EXAMPLE_13082026114715_324thBMNewspaper13082026CSDSC.pdf",
    title: "Newspaper Advertisements for Unaudited Financial Results",
    kind: "other",
  }),
  true,
);

const enclosedDeck = `${pptLetter}

Investor Presentation Q1FY27
Disclaimer Safe Harbour
Financial Snapshot (INR Mn)
Particulars Q1FY27
Total Income 1975
Operating EBITDA 105
Profit After Tax 52
`;
assert.equal(looksLikeEnclosedEarningsDeck(enclosedDeck), true);
assert.equal(isCallIntimationBlob(enclosedDeck), false);

console.log("ok");
