import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  impliedShares,
  liveMcapCr,
  mcapDisagrees,
  MCAP_STALE_TOL,
  normalisedTrailingPe,
  PE_MATCH_TOL,
  qoqCellTone,
  qoqChangePct,
  quarterUnusual,
  trailingPeFromTtm,
  ttmEps,
  withinTol,
} from "../src/lib/stock-detail-metrics";

describe("stock-detail-metrics", () => {
  it("mcap = price × shares within 0.5%", () => {
    const price = 2267.1;
    const storedMcapCr = 7633;
    const shares = impliedShares(storedMcapCr, 2153); // stale price implied
    assert.ok(shares != null && shares > 0);
    const live = liveMcapCr(price, shares);
    assert.ok(live != null);
    // live must equal price * shares / 1e7 exactly (identity)
    assert.ok(withinTol(live!, (price * shares!) / 1e7, MCAP_STALE_TOL));
    assert.equal(mcapDisagrees(storedMcapCr, live!, MCAP_STALE_TOL), true);
    // same price as stored basis → no stale
    const same = liveMcapCr(2153, shares);
    assert.equal(mcapDisagrees(storedMcapCr, same!, MCAP_STALE_TOL), false);
  });

  it("PE = price / TTM EPS within 1%", () => {
    const eps = [18.75, 16.63, 17.61, 46.8];
    const ttm = ttmEps(eps);
    assert.ok(ttm != null);
    assert.ok(withinTol(ttm!, 99.79, 0.001));
    const price = 2267.1;
    const pe = trailingPeFromTtm(price, ttm);
    assert.ok(pe != null);
    const expected = price / ttm!;
    assert.ok(withinTol(pe!, expected, PE_MATCH_TOL));
    assert.ok(withinTol(pe!, 22.7, 0.02));
  });

  it("normalised PE replaces unusual tip EPS with prior-3 avg", () => {
    const eps = [18.75, 16.63, 17.61, 46.8];
    const np = [66, 59, 62, 166];
    assert.equal(quarterUnusual(np), true);
    const pe = normalisedTrailingPe(2267.1, eps);
    assert.ok(pe != null);
    // ~32 as in the detail card note
    assert.ok(withinTol(pe!, 32.1, 0.05));
  });

  it("colour matches the sign of the QoQ change; first col neutral", () => {
    assert.equal(qoqCellTone(66, null, 0), "");
    assert.equal(qoqCellTone(59, 66, 1), "q-down"); // down → red for good_up
    assert.equal(qoqCellTone(62, 59, 2), "q-up"); // up → green
    assert.equal(qoqCellTone(166, 62, 3), "q-up");
    const pct = qoqChangePct(62, 59);
    assert.ok(pct != null && pct > 0);
    assert.equal(qoqCellTone(62, 59, 2), pct! > 0 ? "q-up" : "q-down");
  });
});
