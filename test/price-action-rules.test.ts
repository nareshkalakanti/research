import assert from "node:assert/strict";
import { dayMetrics, screenBits } from "../src/lib/price-action-rules";
import type { Close } from "../src/lib/rotation-bars";

// 100 flat days at 100, volume 1,000, then a breakout day.
function series(lastClose: number, lastVol: number, base = 100): Close[] {
  const bars: Close[] = [];
  const d = new Date("2026-06-01T12:00:00Z");
  for (let i = 0; i < 100; i++) {
    bars.push({ date: d.toISOString().slice(0, 10), close: base, volume: 1000 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  bars.push({ date: d.toISOString().slice(0, 10), close: lastClose, volume: lastVol });
  return bars;
}

// +25% day on 3x volume: 3M ≥ 19%, day ≥ 8% and ≥ 4.7% → S1, S2 (1M ≥ 10%), S3, S4.
let b: Close[] = series(125, 3000);
let m = dayMetrics(b, b.length - 1);
assert.ok(Math.abs((m.day_pct ?? 0) - 25) < 1e-9);
assert.equal(m.vol_x, 3);
assert.equal(screenBits(m), 1 | 2 | 4 | 8);

// +5% on 3x volume, but 3M only +5%: no S3, no S4, no S2.
b = series(105, 3000);
assert.equal(screenBits(dayMetrics(b, b.length - 1)), 0);

// +9% on normal volume: S4 only (S3 needs volume).
b = series(109, 1000);
assert.equal(screenBits(dayMetrics(b, b.length - 1)), 8);

// NRB-like: volume 1.998x still passes the volume test.
b = series(125, 1998);
assert.equal(screenBits(dayMetrics(b, b.length - 1)) & 4, 4);

// No volume stored (old cache): S3 can't pass, S4 still can.
b = series(125, 3000).map(({ date, close }) => ({ date, close }));
m = dayMetrics(b, b.length - 1);
assert.equal(m.vol_x, null);
assert.equal(screenBits(m) & 4, 0);
assert.equal(screenBits(m) & 8, 8);

console.log("ok");

// ---- Rockets ----
import { priceHighRocket, rpiRocket } from "../src/lib/price-action-rules";

function line(closes: number[]): Close[] {
  const d = new Date("2024-01-01T12:00:00Z");
  return closes.map((close) => {
    const date = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
    return { date, close, volume: 1000 };
  });
}

// High 300 days ago at 200, then flat 100, then a new high 5 days ago, then a 6% dip.
const up = line([...Array(40).fill(200), ...Array(300).fill(100), 210, 205, 200, 199, 198, 197.4]);
assert.equal(priceHighRocket(up, up.length - 1), true);
// Same, but the new high is 15 days ago: no rocket.
const old = line([...Array(40).fill(200), ...Array(290).fill(100), 210, ...Array(15).fill(190)]);
assert.equal(priceHighRocket(old, old.length - 1), false);
// Below a high from within the year: no rocket.
const below = line([...Array(100).fill(100), 300, ...Array(200).fill(150)]);
assert.equal(priceHighRocket(below, below.length - 1), false);

// Flat index: an accelerating stock makes RPI highs; falling stock doesn't.
const idx = (_: string) => 1000;
const rising = line(Array.from({ length: 600 }, (_, i) => 100 * Math.exp(0.00001 * i * i)));
assert.equal(rpiRocket(rising, rising.length - 1, idx).rocket, true);
const falling = line(Array.from({ length: 600 }, (_, i) => 700 - i));
assert.equal(rpiRocket(falling, falling.length - 1, idx).rocket, false);
// Equal index and stock: RPI 100.
const same = line(Array(600).fill(50));
assert.ok(Math.abs((rpiRocket(same, same.length - 1, idx).wrpi ?? 0) - 100) < 1e-9);

console.log("rockets ok");
