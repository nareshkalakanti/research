/**
 *   npm run test:holdings-mv
 */
import assert from "node:assert/strict";
import {
  capWeights,
  covMatrix,
  gradient,
  meanVec,
  optimalWeights,
  projectSimplex,
  shrinkAlpha,
  utility,
} from "../src/lib/holdings-mv-math";

const series = [
  [0.01, 0.0],
  [0.012, -0.002],
  [0.008, 0.001],
  [0.011, -0.001],
  [0.009, 0.0],
];
const mu = meanVec(series);
const F = covMatrix(series);
assert.ok(mu[0]! > mu[1]!);
const Peq = [0.5, 0.5];
const lam = 0.5;
const g = gradient(mu, Peq, F, lam);
assert.ok(g[0]! > g[1]!);
const Pstar = optimalWeights(mu, F, lam);
assert.ok(Pstar);
assert.ok(Math.abs(Pstar.reduce((s, x) => s + x, 0) - 1) < 1e-8);
const L0 = utility(mu, Peq, F, lam);
const L1 = utility(mu, Pstar, F, lam);
assert.ok(L1 + 1e-9 >= L0);
assert.deepEqual(projectSimplex([-1, 3]), [0, 1]);
const capped = capWeights([0.9, 0.1, 0], 0.4);
assert.ok(capped.every((w) => w <= 0.4 + 1e-9));
assert.ok(Math.abs(capped.reduce((s, x) => s + x, 0) - 1) < 1e-8);
const shrunk = shrinkAlpha([3, 0, 0]);
assert.ok(shrunk[0]! < 3);

console.log("test:holdings-mv: ok");
