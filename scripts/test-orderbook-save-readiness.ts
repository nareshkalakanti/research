/**
 * Order book pre-save checklist + repair step (no issuer hardcoding).
 *
 *   npm run test:orderbook-save-readiness
 */
import {
  orderbookSaveReadiness,
  repairOrderbookGaps,
  type OrderbookExtract,
} from "../src/lib/orderbook-screen";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function baseExtract(over: Partial<OrderbookExtract> = {}): OrderbookExtract {
  return {
    ticker: "SAMPLE",
    company: "Sample Company Limited",
    subject: null,
    order_date: null,
    orders: [],
    awarding_entity: "Not disclosed",
    order_size: "Not disclosed",
    execution: "Not specified",
    order_size_cr: null,
    order_size_note: null,
    execution_period: null,
    nature: null,
    domestic_or_international: null,
    related_party: null,
    promoter_interest: null,
    order_book_cr: null,
    as_of: null,
    sales_cr: null,
    sales_year: null,
    order_to_sales_pct: null,
    ltp: null,
    baseline_close: null,
    drift_pct: null,
    confidence: 0,
    ...over,
  };
}

async function main() {
  const empty = baseExtract();
  const before = orderbookSaveReadiness(empty);
  console.log("Empty gaps:", before.gaps.map((g) => g.field));
  assert(!before.ready, "expected gaps on empty extract");
  assert(
    before.gaps.some((g) => g.field === "execution"),
    "blank execution wording should count as missing",
  );
  assert(
    before.gaps.some((g) => g.field === "order_date"),
    "expected order_date gap",
  );

  const day = "10 September 2026";
  const iso = "2026-09-10";
  const text =
    `Date: ${day}\nSubject: Receipt of Order\n` +
    "Awarded by Example Client for Rs. 218.3 Crore. Execution period: 4 years.";

  const repaired = await repairOrderbookGaps(empty, text, {
    announced_at: `${iso}T10:00:00.000Z`,
    alreadyUsedLlm: true,
  });
  console.log("Fixed:", repaired.fixed);
  console.log("After gaps:", repaired.gaps_after.map((g) => g.field));
  assert(
    repaired.extract.order_date === iso,
    "expected order_date filled from text or announced_at",
  );
  assert(
    repaired.fixed.some((f) => f.startsWith("order_date")),
    "expected order_date repair",
  );

  const withSize = baseExtract({
    awarding_entity: "Example Client",
    order_size: "Rs.218.3 Crore",
    execution: "4 years",
    order_date: iso,
  });
  const sizeRepair = await repairOrderbookGaps(withSize, text, {
    alreadyUsedLlm: true,
  });
  assert(
    sizeRepair.extract.order_size_cr != null &&
      sizeRepair.extract.order_size_cr > 200,
    `expected order_size_cr from parse, got ${sizeRepair.extract.order_size_cr}`,
  );
  assert(
    orderbookSaveReadiness(sizeRepair.extract).ready,
    "expected ready after core fields + ₹ Cr",
  );

  console.log("OK · orderbook save readiness");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
