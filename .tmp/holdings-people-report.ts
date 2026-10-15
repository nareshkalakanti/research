/**
 * List people on personal holdings boards + those shared across 2+ holdings.
 * Usage: npx tsx .tmp/holdings-people-report.ts
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const root = process.cwd();
const govPath = path.join(root, "data/governance.db");
const holdPath = path.join(root, "data/holdings.db");

const gov = new Database(govPath, { readonly: true, fileMustExist: true });
gov.pragma("query_only = ON");
gov.exec(`ATTACH DATABASE '${holdPath.replace(/'/g, "''")}' AS h`);

const holdings = gov
  .prepare(
    `SELECT UPPER(ticker) AS ticker, name, market FROM h.holdings ORDER BY ticker`,
  )
  .all() as Array<{ ticker: string; name: string | null; market: string }>;
const holdSet = new Set(holdings.map((h) => h.ticker));

type Seat = {
  person_id: string;
  din: string | null;
  name: string;
  ticker: string;
  designation: string;
  category: string | null;
};

const seats = gov
  .prepare(
    `SELECT d.person_id, d.din, d.name, UPPER(bs.ticker) AS ticker,
            bs.designation, bs.category
     FROM board_seats bs
     JOIN directors d ON d.person_id = bs.person_id
     WHERE UPPER(bs.ticker) IN (SELECT UPPER(ticker) FROM h.holdings)
     ORDER BY d.name COLLATE NOCASE, bs.ticker`,
  )
  .all() as Seat[];

const personIds = [...new Set(seats.map((s) => s.person_id))];
const relatedByPerson = new Map<
  string,
  Array<{ ticker: string; designation: string }>
>();
const chunk = 400;
for (let i = 0; i < personIds.length; i += chunk) {
  const ids = personIds.slice(i, i + chunk);
  const ph = ids.map(() => "?").join(",");
  const rows = gov
    .prepare(
      `SELECT person_id, UPPER(ticker) AS ticker, designation
       FROM board_seats WHERE person_id IN (${ph})`,
    )
    .all(...ids) as Array<{
    person_id: string;
    ticker: string;
    designation: string;
  }>;
  for (const r of rows) {
    const list = relatedByPerson.get(r.person_id) ?? [];
    list.push({ ticker: r.ticker, designation: r.designation });
    relatedByPerson.set(r.person_id, list);
  }
}

type PersonAgg = {
  person_id: string;
  din: string | null;
  name: string;
  holdings: Array<{ ticker: string; role: string }>;
  related_outside: Array<{ ticker: string; role: string }>;
};

const byPerson = new Map<string, PersonAgg>();
for (const s of seats) {
  let p = byPerson.get(s.person_id);
  if (!p) {
    p = {
      person_id: s.person_id,
      din: s.din,
      name: s.name,
      holdings: [],
      related_outside: [],
    };
    byPerson.set(s.person_id, p);
  }
  const role = [s.designation, s.category].filter(Boolean).join(" · ");
  if (!p.holdings.some((h) => h.ticker === s.ticker)) {
    p.holdings.push({ ticker: s.ticker, role });
  }
}

for (const p of byPerson.values()) {
  const all = relatedByPerson.get(p.person_id) ?? [];
  for (const r of all) {
    if (holdSet.has(r.ticker)) continue;
    if (!p.related_outside.some((x) => x.ticker === r.ticker)) {
      p.related_outside.push({ ticker: r.ticker, role: r.designation });
    }
  }
  p.holdings.sort((a, b) => a.ticker.localeCompare(b.ticker));
  p.related_outside.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

const people = [...byPerson.values()].sort(
  (a, b) =>
    b.holdings.length - a.holdings.length ||
    b.related_outside.length - a.related_outside.length ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
);

const shared = people.filter((p) => p.holdings.length >= 2);
const single = people.filter((p) => p.holdings.length === 1);

const outDir = path.join(root, ".tmp");
fs.mkdirSync(outDir, { recursive: true });

const report = {
  generated_at: new Date().toISOString(),
  holdings_count: holdings.length,
  people_on_holdings: people.length,
  shared_across_holdings: shared.length,
  only_one_holding: single.length,
  holdings: holdings.map((h) => ({
    ticker: h.ticker,
    name: h.name,
    market: h.market,
  })),
  shared,
  all_people: people,
};
fs.writeFileSync(
  path.join(outDir, "holdings-people.json"),
  JSON.stringify(report, null, 2),
);

const tsvHeader = [
  "name",
  "din",
  "n_holdings",
  "holding_tickers",
  "roles_on_holdings",
  "n_related_outside",
  "related_outside",
].join("\t");

const sharedTsv = [
  tsvHeader,
  ...shared.map((p) =>
    [
      p.name,
      p.din || "",
      String(p.holdings.length),
      p.holdings.map((h) => h.ticker).join(", "),
      p.holdings.map((h) => `${h.ticker}: ${h.role}`).join(" | "),
      String(p.related_outside.length),
      p.related_outside.map((h) => h.ticker).join(", "),
    ].join("\t"),
  ),
].join("\n");
fs.writeFileSync(path.join(outDir, "holdings-people-shared.tsv"), sharedTsv);

const allTsv = [
  tsvHeader,
  ...people.map((p) =>
    [
      p.name,
      p.din || "",
      String(p.holdings.length),
      p.holdings.map((h) => h.ticker).join(", "),
      p.holdings.map((h) => `${h.ticker}: ${h.role}`).join(" | "),
      String(p.related_outside.length),
      p.related_outside.map((h) => h.ticker).join(", "),
    ].join("\t"),
  ),
].join("\n");
fs.writeFileSync(path.join(outDir, "holdings-people-all.tsv"), allTsv);

const summary = {
  holdings: holdings.length,
  people: people.length,
  shared: shared.length,
  single: single.length,
  files: {
    json: ".tmp/holdings-people.json",
    shared_tsv: ".tmp/holdings-people-shared.tsv",
    all_tsv: ".tmp/holdings-people-all.tsv",
  },
  top_shared: shared.slice(0, 50).map((p) => ({
    name: p.name,
    din: p.din,
    holdings: p.holdings.map((h) => h.ticker),
    related_n: p.related_outside.length,
    related: p.related_outside.slice(0, 15).map((h) => h.ticker),
  })),
};

console.log(JSON.stringify(summary, null, 2));
gov.close();
