/**
 * Assert PVRINOX Letter of Offer extract fields (tender card):
 * Issue Type, Shares, Amount, Buyback Price, Face Value, Listing.
 *
 *   npm run test:buyback-screen
 *   npm run test:buyback-screen -- --live   # download PDF + full screen
 */
import {
  detectMethodLexical,
  enrichExtractLexical,
  PVRINOX_TENDER_SAMPLE,
  screenBuybackPdf,
  type BuybackExtract,
} from "../src/lib/buyback-screen";

const COVER = `
Subject: Proposed buyback by PVR INOX Limited ("Company") of up to 20,68,965 (Twenty Lakh Sixty Eight
Thousand Nine Hundred Sixty Five) fully paid-up equity shares of face value of ₹ 10 each ("Equity
Shares") of the Company at a price of ₹ 1,450/- per Equity Share (the "Buy-back").
(Symbol: PVRINOX)
The Company is undertaking a Buy-back through the tender offer process, in accordance with the Companies Act, 2013.
LETTER OF OFFER
OFFER TO BUYBACK UP TO 20,68,965 FULLY PAID-UP EQUITY SHARES OF THE FACE VALUE OF INR 10/-
AT A PRICE OF ₹ 1,450/- PER EQUITY SHARE, PAYABLE IN CASH, FOR AN AGGREGATE MAXIMUM AMOUNT
NOT EXCEEDING ₹ 300,00,00,000/- (INDIAN RUPEES THREE HUNDRED CRORES ONLY)
BSE Limited and National Stock Exchange of India Limited
Record Date, being Friday, September 4, 2026
BUYBACK OPENS ON Thursday, September 10, 2026
BUYBACK CLOSES ON Thursday, September 17, 2026
`;

function assertEq(label: string, got: unknown, want: unknown) {
  if (got !== want) {
    throw new Error(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
}

function checkExtract(ex: BuybackExtract, liveCmp: boolean) {
  const s = PVRINOX_TENDER_SAMPLE;
  assertEq("method", ex.method, s.method);
  assertEq("offer_price", ex.offer_price, s.offer_price);
  assertEq("issue_shares", ex.issue_shares, s.issue_shares);
  assertEq("issue_amount_cr", ex.issue_amount_cr, s.issue_amount_cr);
  assertEq("face_value", ex.face_value, s.face_value);
  assertEq("listing", ex.listing, s.listing);
  if (!liveCmp) {
    assertEq("record_date", ex.record_date, s.record_date);
    assertEq("tender_open", ex.tender_open, s.tender_open);
    assertEq("tender_close", ex.tender_close, s.tender_close);
  }
  console.log("ok fields", {
    IssueType: "Tender Offer",
    IssueSizeShares: ex.issue_shares,
    IssueSizeAmountCr: ex.issue_amount_cr,
    BuybackPrice: ex.offer_price,
    FaceValue: ex.face_value,
    ListingAt: ex.listing,
  });
}

async function main() {
  const live = process.argv.includes("--live");

  const lexical = detectMethodLexical(COVER);
  assertEq("lexical.method", lexical.method, "tender");

  let ex: BuybackExtract = {
    ticker: null,
    company: null,
    subject: null,
    method: "unknown",
    method_evidence: null,
    offer_price: null,
    max_buyback_price: null,
    issue_shares: null,
    issue_amount_cr: null,
    face_value: null,
    listing: null,
    record_date: null,
    tender_open: null,
    tender_close: null,
    filing_kind: "other",
    confidence: 0,
  };
  ex.method = lexical.method;
  ex = enrichExtractLexical(COVER, ex);
  checkExtract(ex, false);

  if (live) {
    console.log("live", PVRINOX_TENDER_SAMPLE.url);
    const r = await screenBuybackPdf({ url: PVRINOX_TENDER_SAMPLE.url });
    checkExtract(r.extract, true);
    assertEq("ticker", r.extract.ticker, PVRINOX_TENDER_SAMPLE.ticker);
    if (r.decision !== "pass_tender" && r.decision !== "skip_low_upside") {
      throw new Error(`unexpected decision ${r.decision}: ${r.why}`);
    }
    console.log("live decision", r.decision, r.why);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
