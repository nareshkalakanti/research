/** Quick ATH / 52W check for one ticker. Run: npx tsx scripts/check-ticker-signals.ts KANPRPLA */
import { fetchDailyBars } from "../src/lib/ohlc";
import {
  analyzeAthNew,
  analyzeHigh52New,
  loadBreakoutMap,
} from "../src/lib/signals";

const ticker = (process.argv[2] || "KANPRPLA").toUpperCase();
const market = process.argv[3] || "NSE";

async function main() {
  const map = loadBreakoutMap("weekly");
  const flags = map.get(ticker);
  console.log("cached flags:", flags?.has_ath, flags?.has_high52);

  const bars = await fetchDailyBars(ticker, market, 25);
  if (!bars.length) {
    console.log("no daily bars");
    return;
  }
  const last = bars[bars.length - 1]!;
  console.log("last bar:", last.date.slice(0, 10), "close", last.close, "high", last.high);

  let priorAth = -Infinity;
  for (let j = 0; j < bars.length - 1; j++) {
    priorAth = Math.max(priorAth, bars[j]!.high);
  }
  const lookback = 252;
  const i = bars.length - 1;
  const start = Math.max(0, i - lookback);
  let prior52 = -Infinity;
  for (let j = start; j < i; j++) {
    prior52 = Math.max(prior52, bars[j]!.high);
  }
  console.log("prior ATH high:", priorAth, "| prior 52W high:", prior52);
  console.log("close vs ATH:", last.close >= priorAth ? "AT/above prior ATH" : "below");
  console.log("close vs 52W:", last.close >= prior52 ? "AT/above prior 52W" : "below");

  const ath = analyzeAthNew(bars);
  const h52 = analyzeHigh52New(bars);
  console.log("NEW ATH signal today:", ath ?? "no");
  console.log("NEW 52W signal today:", h52 ?? "no");

  console.log("\nrecent NEW signals (last 15 sessions):");
  for (let k = Math.max(60, bars.length - 15); k < bars.length; k++) {
    const slice = bars.slice(0, k + 1);
    const h = analyzeHigh52New(slice);
    const a = analyzeAthNew(slice);
    const b = bars[k]!;
    if (h || a) {
      console.log(
        b.date.slice(0, 10),
        "close",
        b.close.toFixed(2),
        "high",
        b.high.toFixed(2),
        h ? `52W@${h.high_52w}` : "",
        a ? `ATH@${a.ath}` : "",
      );
    }
  }

  console.log("\nrecent bars:");
  for (const b of bars.slice(-8)) {
    console.log(b.date.slice(0, 10), "C", b.close.toFixed(2), "H", b.high.toFixed(2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
