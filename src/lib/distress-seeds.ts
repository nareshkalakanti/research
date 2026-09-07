/** Fixed distress-turnaround seed tickers shown as the “distress” tag. */
export const DISTRESS_SEED_TICKERS = [
  "GPTINFRA",
  "HMT",
  "LOKESHMACH",
  "ATAM",
  "CORDSCABLE",
  "ONIDA", // formerly MIRCELECTR
  "TEAMGTY",
  "DGCONTENT",
  "BPL",
] as const;

export function distressSeedSet(): Set<string> {
  return new Set(DISTRESS_SEED_TICKERS.map((t) => t.toUpperCase()));
}
