import assert from "node:assert/strict";
import { napkinDocumentCollection } from "../src/lib/napkin/doc-collection";
import {
  classifyFiling,
  dedupeNapkinFilings,
  pickConcallTranscripts,
  pickNapkinFilings,
} from "../src/lib/napkin/filings";

const outcome =
  "https://nsearchives.nseindia.com/corporate/CORDSCABLE_13082026142100_S_Outcome.pdf";
assert.equal(classifyFiling("", outcome), "RESULT");
assert.equal(classifyFiling("Outcome of Board Meeting", outcome), "RESULT");
assert.equal(
  classifyFiling(
    "Earnings call transcript",
    "https://nsearchives.nseindia.com/corporate/FOO_transcript.pdf",
  ),
  "CONCALL_TRANSCRIPT",
);
assert.equal(
  classifyFiling(
    "Investor Presentation",
    "https://nsearchives.nseindia.com/corporate/FOO_IP.pdf",
  ),
  "INVESTOR_PRESENTATION",
);
assert.equal(
  classifyFiling(
    "Annual Report FY25",
    "https://nsearchives.nseindia.com/corporate/FOO_AR.pdf",
  ),
  "ANNUAL_REPORT",
);
assert.equal(
  pickNapkinFilings([
    {
      document_title: "Covering letter",
      document_type: "CORPORATE_ANNOUNCEMENT",
      date: "2026-08-14",
      source: "NSE",
      url: "https://nsearchives.nseindia.com/corporate/FOO_cover.pdf",
    },
    {
      document_title: "Outcome of Board Meeting",
      document_type: "RESULT",
      date: "2026-08-13",
      source: "NSE",
      url: outcome,
    },
    {
      document_title: "Investor Presentation",
      document_type: "INVESTOR_PRESENTATION",
      date: "2026-08-12",
      source: "NSE",
      url: "https://nsearchives.nseindia.com/corporate/FOO_IP.pdf",
    },
  ]).map((r) => r.document_type).join(","),
  "RESULT,INVESTOR_PRESENTATION",
);
assert.equal(
  pickNapkinFilings([
    {
      document_title: "Q1",
      document_type: "RESULT",
      date: "2026-08-13",
      source: "NSE",
      url: "https://nsearchives.nseindia.com/corporate/FOO_q1.pdf",
    },
    {
      document_title: "FY",
      document_type: "RESULT",
      date: "2026-05-28",
      source: "NSE",
      url: "https://nsearchives.nseindia.com/corporate/FOO_fy.pdf",
    },
    {
      document_title: "AR",
      document_type: "ANNUAL_REPORT",
      date: "2026-07-01",
      source: "NSE",
      url: "https://nsearchives.nseindia.com/corporate/FOO_AR.pdf",
    },
  ]).map((r) => r.document_title).join(","),
  "Q1,FY,AR",
);
const pack = napkinDocumentCollection([
  {
    title: "Q1 Results",
    period: "2026-08-13",
    kind: "RESULT",
    url: "https://nsearchives.nseindia.com/corporate/FOO_q1.pdf",
    picked: true,
  },
  {
    title: "Investor Presentation",
    period: "2026-06-01",
    kind: "INVESTOR_PRESENTATION",
    url: "https://nsearchives.nseindia.com/corporate/FOO_IP.pdf",
    picked: true,
  },
]);
assert.equal(pack.map((r) => `${r.label}:${r.found ? "yes" : "no"}`).join(","),
  "Results:yes,Investor Presentation:yes,Annual Report:no,Concall Transcript:no");
assert.equal(pack.find((r) => r.kind === "CONCALL_TRANSCRIPT")?.title, "Concall Transcript");
assert.equal(
  pickNapkinFilings([
    {
      document_title: "Covering letter",
      document_type: "CORPORATE_ANNOUNCEMENT",
      date: "2026-08-14",
      source: "NSE",
      url: "https://nsearchives.nseindia.com/corporate/FOO_cover.pdf",
    },
  ]).length,
  0,
);
assert.equal(
  dedupeNapkinFilings([
    [
      {
        document_title: "NSE copy",
        document_type: "RESULT",
        date: "2026-08-13",
        source: "NSE",
        url: "https://nsearchives.nseindia.com/corporate/FOO_q1.pdf",
      },
    ],
    [
      {
        document_title: "BSE copy",
        document_type: "RESULT",
        date: "2026-08-13",
        source: "BSE",
        url: "https://www.bseindia.com/xml-data/corpfiling/AttachHis/FOO_q1.pdf",
      },
    ],
  ]).map((r) => r.source).join(","),
  "NSE",
);
assert.equal(
  pickConcallTranscripts([
    {
      document_title: "t1",
      document_type: "CONCALL_TRANSCRIPT",
      date: "2024-01-01",
      source: "NSE",
      url: "https://nsearchives.nseindia.com/corporate/t1.pdf",
    },
    {
      document_title: "t2",
      document_type: "CONCALL_TRANSCRIPT",
      date: "2025-01-01",
      source: "NSE",
      url: "https://nsearchives.nseindia.com/corporate/t2.pdf",
    },
    {
      document_title: "out",
      document_type: "RESULT",
      date: "2026-01-01",
      source: "NSE",
      url: outcome,
    },
  ]).map((r) => r.document_title).join(","),
  "t2,t1",
);
console.log("ok");
