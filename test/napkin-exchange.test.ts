import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { napkinExchangeFromStock } from "../src/lib/napkin/map";

describe("napkinExchangeFromStock", () => {
  it("uses listing market when present", () => {
    assert.equal(
      napkinExchangeFromStock({
        listing_market: "BSE SME",
        yf_symbol: "HIGHNESS.BO",
      }),
      "BSE SME",
    );
  });

  it("infers BSE from .BO Yahoo symbol", () => {
    assert.equal(
      napkinExchangeFromStock({
        listing_market: null,
        yf_symbol: "HIGHNESS.BO",
      }),
      "BSE",
    );
  });

  it("defaults to NSE", () => {
    assert.equal(
      napkinExchangeFromStock({ listing_market: null, yf_symbol: "ONIDA.NS" }),
      "NSE",
    );
  });
});
