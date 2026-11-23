import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listingDisplaySymbol, tradingviewSymbol } from "../src/lib/links";
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

  it("keeps NSE SME", () => {
    assert.equal(
      napkinExchangeFromStock({
        listing_market: "NSE SME",
        yf_symbol: "NEOCHEM-SM.NS",
      }),
      "NSE SME",
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

describe("listingDisplaySymbol", () => {
  it("shows NSE SME in the UI label", () => {
    assert.equal(listingDisplaySymbol("NEOCHEM", "NSE SME"), "NSE SME:NEOCHEM");
  });

  it("keeps TradingView chart symbol on main board NSE", () => {
    assert.equal(tradingviewSymbol("NEOCHEM", "NSE SME"), "NSE:NEOCHEM");
  });
});
