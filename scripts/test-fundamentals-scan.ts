/**
 * Banding helpers for Scan PEAD chips (no issuer facts).
 */
import {
  bandGrowth,
  bandMarginBps,
  bandPead,
  bandRoceDelta,
  techFromSmaStack,
} from "../src/lib/fundamentals-scan";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(bandGrowth(87.4) === "High", "sales 87 High");
assert(bandGrowth(10) === "Med", "sales 10 Med");
assert(bandGrowth(2) === "Low", "sales 2 Low");
assert(bandMarginBps(500) === "High", "OPM +5pp High");
assert(bandMarginBps(10) === "Med", "OPM +10bps Med");
assert(bandMarginBps(-20) === "Low", "OPM down Low");
assert(bandRoceDelta(5) === "High", "ROCE +5 High");
assert(bandRoceDelta(0) === "Low", "ROCE flat Low");
assert(bandPead(95) === "High", "PEAD 95 High");
assert(bandPead(50) === "Med", "PEAD 50 Med");

const vs = techFromSmaStack({
  price: 100,
  sma20: 90,
  sma50: 80,
  sma200: 70,
});
assert(vs?.strength === "Very Strong", "full SMA stack");
assert(vs?.change === "Improved", "Very Strong ↑");

const strong = techFromSmaStack({
  price: 100,
  sma20: 105,
  sma50: 90,
  sma200: 70,
});
assert(strong?.strength === "Strong", "above 50+200 not stacked");
assert(strong?.change === "Stable", "Strong →");

const weak = techFromSmaStack({
  price: 60,
  sma20: 90,
  sma50: 80,
  sma200: 70,
});
assert(weak?.strength === "Weak", "below 200");
assert(techFromSmaStack({ price: null, sma20: 1, sma50: 1, sma200: 1 }) === null, "no price");
console.log("ok");
