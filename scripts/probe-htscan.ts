/**
 * Probe NSE sources for High Trade Scan fields.
 * Usage: npx tsx scripts/probe-htscan.ts IFCI
 */
import { createNseBuybackSession, nseFetch } from "../src/lib/nse-buybacks";
import { fetchDailyBars } from "../src/lib/ohlc";
import { ema, rsi } from "../src/lib/indicators";

const ticker = (process.argv[2] || "IFCI").toUpperCase();
const QUOTE = "https://www.nseindia.com/api/quote-equity";
const QUOTE_PAGE = "https://www.nseindia.com/get-quotes/equity";
const HIST =
  "https://www.nseindia.com/api/historical/cm/equity";

function pick(obj: unknown, depth = 0, path = ""): void {
  if (depth > 3 || obj == null) return;
  if (typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      pick(v, depth + 1, p);
    } else if (
      /trade|deliv|qty|volume|rsi|ema|ffmc|mcap|issued/i.test(k)
    ) {
      console.log(`  ${p}=${JSON.stringify(v).slice(0, 180)}`);
    }
  }
}

async function main() {
  const jar = await createNseBuybackSession();
  console.log("session cookies", jar.cookie ? "yes" : "no");

  await nseFetch(QUOTE_PAGE, jar, {
    params: { symbol: ticker },
    referer: "https://www.nseindia.com/",
  });

  const quote = await nseFetch(QUOTE, jar, {
    params: { symbol: ticker },
    referer: `${QUOTE_PAGE}?symbol=${ticker}`,
  });
  console.log("\n== quote-equity", quote.status, quote.headers.get("content-type"));
  if (quote.ok) {
    const j = await quote.json();
    console.log("top keys", Object.keys(j));
    pick(j);
    console.log("priceInfo", JSON.stringify(j.priceInfo, null, 2)?.slice(0, 800));
  } else {
    console.log(await quote.text().then((t) => t.slice(0, 200)));
  }

  const trade = await nseFetch(QUOTE, jar, {
    params: { symbol: ticker, section: "trade_info" },
    referer: `${QUOTE_PAGE}?symbol=${ticker}`,
  });
  console.log(
    "\n== trade_info",
    trade.status,
    trade.headers.get("content-type"),
  );
  if (trade.ok) {
    const j = await trade.json();
    console.log(JSON.stringify(j, null, 2).slice(0, 4000));
  } else {
    console.log(await trade.text().then((t) => t.slice(0, 300)));
  }

  const from = "01-08-2026";
  const to = "03-09-2026";
  const hist = await nseFetch(HIST, jar, {
    params: {
      symbol: ticker,
      series: '["EQ"]',
      from,
      to,
    },
    referer: `https://www.nseindia.com/get-quotes/equity?symbol=${ticker}`,
  });
  console.log("\n== historical", hist.status, hist.headers.get("content-type"));
  if (hist.ok) {
    const j = (await hist.json()) as { data?: unknown[] };
    const rows = Array.isArray(j.data) ? j.data : [];
    console.log("hist rows", rows.length);
    if (rows[0]) console.log("hist keys", Object.keys(rows[0] as object));
    console.log("last 3", JSON.stringify(rows.slice(-3), null, 2).slice(0, 2500));
  } else {
    console.log(await hist.text().then((t) => t.slice(0, 400)));
  }

  const ymd = "02092026";
  const bhavUrl = `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${ymd}.csv`;
  const bhav = await fetch(bhavUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Referer: "https://www.nseindia.com/",
    },
  });
  console.log("\n== bhavdata", bhav.status, bhavUrl);
  if (bhav.ok) {
    const text = await bhav.text();
    const lines = text.split(/\r?\n/);
    console.log("header", lines[0]);
    const hit = lines.find((l) => l.startsWith(`${ticker},`) || l.includes(`,${ticker},`));
    console.log("IFCI line", hit?.slice(0, 400) || "not found");
    console.log("sample", lines[1]?.slice(0, 300));
  } else {
    console.log(await bhav.text().then((t) => t.slice(0, 200)));
  }

  const bars = await fetchDailyBars(ticker, "NSE", 1);
  const closes = bars.map((b) => b.close);
  const r = rsi(closes, 14);
  const e = ema(closes, 20);
  const last = bars.at(-1);
  const prev5 = bars.at(-6);
  const prev22 = bars.at(-23);
  const prev66 = bars.at(-67);
  const ret = (a?: number, b?: number) =>
    a && b ? (((a - b) / b) * 100).toFixed(2) : "—";
  console.log("\n== yahoo daily", {
    n: bars.length,
    last: last && { date: last.date, close: last.close, vol: last.volume },
    rsi14: r.at(-1),
    ema20: e.at(-1),
    d5: ret(last?.close, prev5?.close),
    d22: ret(last?.close, prev22?.close),
    d66: ret(last?.close, prev66?.close),
    high52: Math.max(...closes.slice(-252)),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
