import assert from "node:assert/strict";

function spanOrphans(
  inGroup: string[],
  people: Array<{ tickers: string[]; span_tickers?: string[]; control: boolean }>,
) {
  const seated = new Set<string>();
  for (const p of people) for (const t of p.tickers) seated.add(t);
  const anchors = people.filter(
    (p) => p.control && p.tickers.filter((t) => inGroup.includes(t)).length >= 2,
  );
  for (const t of inGroup) {
    if (seated.has(t)) continue;
    for (const p of anchors) {
      p.span_tickers = [...new Set([...(p.span_tickers ?? []), t])];
    }
  }
}

const people = [
  { tickers: ["AAA", "BBB"], control: true, span_tickers: [] as string[] },
  { tickers: ["AAA"], control: false, span_tickers: [] as string[] },
];
spanOrphans(["AAA", "BBB", "CCC"], people);
assert.deepEqual(people[0]!.span_tickers, ["CCC"]);
assert.deepEqual(people[1]!.span_tickers, []);
console.log("group-anchor-span: ok");
