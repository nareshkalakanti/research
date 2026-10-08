/**
 * Read-only company_groups audit. Does not write the database.
 */
import { openSqliteNamed } from "../src/lib/sqlite-utils";

const db = openSqliteNamed("governance.db", { wal: true, readonly: true });

type GroupRow = {
  ticker: string;
  group_key: string;
  group_name: string;
  company: string | null;
  mcap: number | null;
};

const rows = db
  .prepare(
    `SELECT g.ticker, g.group_key, g.group_name,
            c.name AS company, m.market_cap AS mcap
     FROM company_groups g
     LEFT JOIN companies c ON c.ticker = g.ticker
     LEFT JOIN company_metrics m ON m.ticker = g.ticker
     ORDER BY g.group_name, g.ticker`,
  )
  .all() as GroupRow[];

const keys = new Set(rows.map((r) => r.group_key));
const names = new Set(rows.map((r) => r.group_name));
const tickers = new Set(rows.map((r) => r.ticker));

const byKey = new Map<string, GroupRow[]>();
for (const r of rows) {
  const a = byKey.get(r.group_key) || [];
  a.push(r);
  byKey.set(r.group_key, a);
}

const sizeBuckets = { s1: 0, s2: 0, s3_5: 0, s6_10: 0, s11_25: 0, s26: 0 };
const groupSizes: Array<{
  group_key: string;
  group_name: string;
  n: number;
  names_used: string[];
  companies: Array<{ ticker: string; company: string | null; mcap: number | null }>;
}> = [];
for (const [key, list] of byKey) {
  const uniqT = [...new Set(list.map((r) => r.ticker))];
  const n = uniqT.length;
  if (n === 1) sizeBuckets.s1 += 1;
  else if (n === 2) sizeBuckets.s2 += 1;
  else if (n <= 5) sizeBuckets.s3_5 += 1;
  else if (n <= 10) sizeBuckets.s6_10 += 1;
  else if (n <= 25) sizeBuckets.s11_25 += 1;
  else sizeBuckets.s26 += 1;
  groupSizes.push({
    group_key: key,
    group_name: list[0].group_name,
    n,
    names_used: [...new Set(list.map((r) => r.group_name))],
    companies: uniqT.map((t) => {
      const r = list.find((x) => x.ticker === t)!;
      return { ticker: t, company: r.company, mcap: r.mcap };
    }),
  });
}
groupSizes.sort((a, b) => b.n - a.n || a.group_name.localeCompare(b.group_name));

const byTicker = new Map<string, GroupRow[]>();
for (const r of rows) {
  const a = byTicker.get(r.ticker) || [];
  a.push(r);
  byTicker.set(r.ticker, a);
}
const multi = [...byTicker.entries()]
  .filter(([, list]) => new Set(list.map((r) => r.group_key)).size > 1)
  .map(([ticker, list]) => {
    const uniq = [...new Map(list.map((r) => [r.group_key, r])).values()];
    return {
      ticker,
      company: list[0].company,
      n_groups: uniq.length,
      groups: uniq.map((r) => ({ group_key: r.group_key, group_name: r.group_name })),
    };
  })
  .sort((a, b) => b.n_groups - a.n_groups || a.ticker.localeCompare(b.ticker));

const SECTORISH =
  /\b(bank|banking|software|engineering|petroleum|railway|railways|electronics|chemical|chemicals|healthcare|health\s*care|textile|textiles|transport|transportation|infrastructure|infra|pharma|pharmaceutical|steel|cement|sugar|power|energy|oil|gas|mining|metal|metals|auto|automobile|insurance|finance|financial|telecom|media|retail|realty|real\s*estate|construction|shipping|logistics|agriculture|agri|fmcg|it\s*services|information\s*technology|technology|tech|hospital|hospitals|hotel|hotels|tourism|defence|defense|psu|government|sector|industry|industries)\b/i;
const GENERIC =
  /^(group|holdings?|enterprises?|industries|limited|ltd|others?|misc|miscellaneous|unclassified|standalone|various|general)$/i;

function sectorReason(name: string): string | null {
  const n = name.trim();
  if (GENERIC.test(n)) return "Generic word as group_name";
  if (SECTORISH.test(n) && !/\b(group|family|birla|tata|ambani|godrej|mahindra|bajaj|adani|jindal|reliance)\b/i.test(n)) {
    return "Potential sector/category grouping (name matches a generic industry/function/theme pattern)";
  }
  if (/^[A-Z][a-z]+$/.test(n) && n.length <= 12 && SECTORISH.test(n)) {
    return "Potential sector/category grouping";
  }
  return null;
}

const sectorCandidates = groupSizes
  .filter((g) => sectorReason(g.group_name) || g.names_used.some((n) => sectorReason(n)))
  .map((g) => ({
    ...g,
    reason: sectorReason(g.group_name) || g.names_used.map(sectorReason).find(Boolean),
  }));

const nameToKeys = new Map<string, Set<string>>();
const keyToNames = new Map<string, Set<string>>();
for (const r of rows) {
  const nk = r.group_name.trim().toLowerCase();
  if (!nameToKeys.has(nk)) nameToKeys.set(nk, new Set());
  nameToKeys.get(nk)!.add(r.group_key);
  if (!keyToNames.has(r.group_key)) keyToNames.set(r.group_key, new Set());
  keyToNames.get(r.group_key)!.add(r.group_name);
}

const sameNameDiffKey = [...nameToKeys.entries()]
  .filter(([, ks]) => ks.size > 1)
  .map(([name, ks]) => ({
    group_name: name,
    keys: [...ks],
    counts: [...ks].map((k) => ({
      group_key: k,
      company_count: groupSizes.find((g) => g.group_key === k)?.n ?? 0,
      group_name: groupSizes.find((g) => g.group_key === k)?.group_name,
    })),
  }));

const sameKeyDiffName = [...keyToNames.entries()]
  .filter(([, ns]) => ns.size > 1)
  .map(([key, ns]) => ({
    group_key: key,
    names: [...ns],
    company_count: groupSizes.find((g) => g.group_key === key)?.n ?? 0,
  }));

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(group|ltd|limited|pvt|private|the|of|and|co|company|holdings?|industries)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const similarPairs: Array<{
  a_key: string;
  a_name: string;
  a_n: number;
  b_key: string;
  b_name: string;
  b_n: number;
  why: string;
}> = [];
const gs = groupSizes;
for (let i = 0; i < gs.length; i++) {
  for (let j = i + 1; j < gs.length; j++) {
    const a = gs[i];
    const b = gs[j];
    if (a.group_key === b.group_key) continue;
    const na = normName(a.group_name);
    const nb = normName(b.group_name);
    if (!na || !nb) continue;
    if (na === nb) {
      similarPairs.push({
        a_key: a.group_key,
        a_name: a.group_name,
        a_n: a.n,
        b_key: b.group_key,
        b_name: b.group_name,
        b_n: b.n,
        why: "Normalized group_name equal (punctuation/casing/stopwords)",
      });
      continue;
    }
    if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) {
      similarPairs.push({
        a_key: a.group_key,
        a_name: a.group_name,
        a_n: a.n,
        b_key: b.group_key,
        b_name: b.group_name,
        b_n: b.n,
        why: "One normalized group_name contains the other",
      });
    }
  }
}

const seats = db
  .prepare(`SELECT person_id, ticker FROM board_seats`)
  .all() as Array<{ person_id: string; ticker: string }>;

const tickerToKeys = new Map<string, Set<string>>();
for (const r of rows) {
  if (!tickerToKeys.has(r.ticker)) tickerToKeys.set(r.ticker, new Set());
  tickerToKeys.get(r.ticker)!.add(r.group_key);
}

const byPerson = new Map<string, Set<string>>();
for (const s of seats) {
  if (!byPerson.has(s.person_id)) byPerson.set(s.person_id, new Set());
  byPerson.get(s.person_id)!.add(s.ticker);
}

type Pair = { a: string; b: string };
const pairMap = new Map<string, Pair>();
for (const tickersOf of byPerson.values()) {
  const t = [...tickersOf].sort();
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      pairMap.set(`${t[i]}|${t[j]}`, { a: t[i], b: t[j] });
    }
  }
}
const pairs = [...pairMap.values()];

function pairType(a: string, b: string): "same" | "cross" | "unclassified" {
  const ga = tickerToKeys.get(a);
  const gb = tickerToKeys.get(b);
  if (!ga?.size || !gb?.size) return "unclassified";
  for (const k of ga) if (gb.has(k)) return "same";
  return "cross";
}

const globalCross = pairs.filter((p) => pairType(p.a, p.b) === "cross").length;
const globalSame = pairs.filter((p) => pairType(p.a, p.b) === "same").length;

function impact(groupKey: string) {
  const members = new Set(
    (byKey.get(groupKey) || []).map((r) => r.ticker),
  );
  const seatRows = seats.filter((s) => members.has(s.ticker));
  const dirs = new Set(seatRows.map((s) => s.person_id));
  const involved = pairs.filter((p) => members.has(p.a) || members.has(p.b));
  const same = involved.filter((p) => members.has(p.a) && members.has(p.b));
  const cross = involved.filter((p) => pairType(p.a, p.b) === "cross");
  const bothGrouped = involved.filter((p) => {
    const ga = tickerToKeys.get(p.a);
    const gb = tickerToKeys.get(p.b);
    return !!(ga?.size && gb?.size);
  });
  return {
    seats: seatRows.length,
    directors: dirs.size,
    companies: members.size,
    company_pairs_involving: involved.length,
    same_group_pairs: same.length,
    cross_group_pairs_involving: cross.length,
    grouped_pairs_involving: bothGrouped.length,
  };
}

const suspiciousTickers: Array<{
  ticker: string;
  company: string | null;
  groups: Array<{ group_key: string; group_name: string }>;
  issue: string;
  evidence: string;
}> = [];

for (const m of multi) {
  const namesG = m.groups.map((g) => g.group_name);
  const company = (m.company || "").toLowerCase();
  const overlap = m.groups.filter((g) => {
    const tokens = normName(g.group_name).split(" ").filter((t) => t.length >= 4);
    return tokens.some((t) => company.includes(t));
  });
  if (m.n_groups >= 3) {
    suspiciousTickers.push({
      ticker: m.ticker,
      company: m.company,
      groups: m.groups,
      issue: `${m.n_groups} group_key values on one ticker`,
      evidence: `company_groups rows: ${namesG.join(" | ")}`,
    });
  } else if (overlap.length === 0 && namesG.every((n) => !sectorReason(n))) {
    suspiciousTickers.push({
      ticker: m.ticker,
      company: m.company,
      groups: m.groups,
      issue: "Multiple groups; company legal name shares no 4+ letter token with either group_name",
      evidence: `Assigned: ${namesG.join(" | ")}; company: ${m.company || "null"}`,
    });
  } else if (overlap.length === 1 && m.n_groups === 2) {
    const other = m.groups.filter((g) => !overlap.includes(g));
    suspiciousTickers.push({
      ticker: m.ticker,
      company: m.company,
      groups: m.groups,
      issue: "Two groups; legal name overlaps one group_name more than the other",
      evidence: `Name overlap with ${overlap.map((g) => g.group_name).join(", ")}; also assigned ${other.map((g) => g.group_name).join(", ")}`,
    });
  }
}

for (const g of groupSizes) {
  const reason = sectorReason(g.group_name);
  if (!reason) continue;
  for (const c of g.companies) {
    const tokens = normName(g.group_name).split(" ").filter((t) => t.length >= 4);
    const company = (c.company || "").toLowerCase();
    const hit = tokens.some((t) => company.includes(t));
    if (!hit && g.n >= 3) {
      suspiciousTickers.push({
        ticker: c.ticker,
        company: c.company,
        groups: [{ group_key: g.group_key, group_name: g.group_name }],
        issue: "Member of a potential sector/category group; legal name does not contain group_name tokens",
        evidence: `group_name=${g.group_name}; company=${c.company || "null"}`,
      });
    }
  }
}

const otherGroupNames = groupSizes.map((g) => ({
  key: g.group_key,
  name: g.group_name,
  norm: normName(g.group_name),
}));
for (const r of rows) {
  const company = r.company || "";
  const cn = company.toLowerCase();
  const assignedNorm = normName(r.group_name);
  const hits = otherGroupNames.filter((og) => {
    if (og.key === r.group_key) return false;
    if (!og.norm || og.norm.length < 5) return false;
    if (assignedNorm === og.norm) return false;
    return cn.includes(og.norm) || cn.includes(og.name.toLowerCase());
  });
  if (hits.length === 1 && !cn.includes(assignedNorm) && assignedNorm.length >= 4) {
    suspiciousTickers.push({
      ticker: r.ticker,
      company: r.company,
      groups: [{ group_key: r.group_key, group_name: r.group_name }],
      issue: "Company legal name contains a different existing group_name",
      evidence: `Assigned ${r.group_name}; company name contains ${hits[0].name}`,
    });
  }
}

const seenSusp = new Set<string>();
const uniqueSusp = suspiciousTickers.filter((s) => {
  const k = `${s.ticker}|${s.issue}`;
  if (seenSusp.has(k)) return false;
  seenSusp.add(k);
  return true;
});

const candidateKeys = new Set<string>();
for (const g of sectorCandidates) candidateKeys.add(g.group_key);
for (const d of sameNameDiffKey) for (const k of d.keys) candidateKeys.add(k);
for (const d of sameKeyDiffName) candidateKeys.add(d.group_key);
for (const p of similarPairs) {
  candidateKeys.add(p.a_key);
  candidateKeys.add(p.b_key);
}
for (const g of groupSizes.filter((g) => g.n >= 11)) candidateKeys.add(g.group_key);
for (const m of multi) for (const g of m.groups) candidateKeys.add(g.group_key);

const impacts = [...candidateKeys].map((k) => {
  const g = groupSizes.find((x) => x.group_key === k)!;
  return {
    group_key: k,
    group_name: g.group_name,
    n: g.n,
    impact: impact(k),
    sector: !!sectorReason(g.group_name),
    multi_members: multi.filter((m) => m.groups.some((x) => x.group_key === k)).length,
  };
});
impacts.sort(
  (a, b) =>
    b.impact.company_pairs_involving - a.impact.company_pairs_involving ||
    b.n - a.n,
);

function priorityFor(imp: (typeof impacts)[0]): {
  priority: "HIGH" | "MEDIUM" | "LOW";
  why: string;
} {
  const i = imp.impact;
  if (imp.sector && imp.n >= 4 && i.company_pairs_involving >= 20) {
    return {
      priority: "HIGH",
      why: "Potential sector/category name, several members, and many current company-company edges involve the members",
    };
  }
  if (imp.n >= 11 && i.company_pairs_involving >= 50) {
    return {
      priority: "HIGH",
      why: "Unusually large membership relative to the group size distribution, with high current-network involvement",
    };
  }
  if (sameNameDiffKey.some((d) => d.keys.includes(imp.group_key))) {
    return {
      priority: "HIGH",
      why: "Same group_name appears under more than one group_key",
    };
  }
  if (imp.multi_members >= 5) {
    return {
      priority: "HIGH",
      why: "Many tickers in this group also have another group_key",
    };
  }
  if (imp.sector || similarPairs.some((p) => p.a_key === imp.group_key || p.b_key === imp.group_key)) {
    return {
      priority: "MEDIUM",
      why: "Suspicious naming or possible overlapping group_name; limited or mixed network impact",
    };
  }
  if (i.company_pairs_involving < 5) {
    return {
      priority: "LOW",
      why: "Little current board-pair involvement",
    };
  }
  return {
    priority: "MEDIUM",
    why: "Candidate for review because of size, overlap, or naming; not proven incorrect",
  };
}

const queue: Array<{
  priority: string;
  company: string;
  ticker: string;
  current_group: string;
  issue: string;
  network_impact: string;
  action: string;
}> = [];

for (const s of uniqueSusp) {
  const keysS = s.groups.map((g) => g.group_key);
  const maxPairs = Math.max(
    ...keysS.map((k) => impact(k).company_pairs_involving),
    0,
  );
  let priority: "HIGH" | "MEDIUM" | "LOW" = "MEDIUM";
  if (s.groups.length >= 3 || maxPairs >= 80) priority = "HIGH";
  else if (maxPairs < 5) priority = "LOW";
  queue.push({
    priority,
    company: s.company || s.ticker,
    ticker: s.ticker,
    current_group: s.groups.map((g) => g.group_name).join(" | "),
    issue: s.issue,
    network_impact: `max company-pairs involving assigned group(s): ${maxPairs}`,
    action: s.issue.includes("contains a different existing group_name")
      ? "Verify; Reassign only after confirming the name match is the same corporate group. Manual verification required."
      : "Verify. Manual verification required.",
  });
}

for (const g of sectorCandidates) {
  const i = impact(g.group_key);
  const pr = priorityFor({
    group_key: g.group_key,
    group_name: g.group_name,
    n: g.n,
    impact: i,
    sector: true,
    multi_members: 0,
  });
  queue.push({
    priority: pr.priority,
    company: `(group) ${g.n} tickers`,
    ticker: "",
    current_group: g.group_name,
    issue: g.reason || "Potential sector/category grouping",
    network_impact: `pairs involving members ${i.company_pairs_involving}; same-group ${i.same_group_pairs}; cross involving ${i.cross_group_pairs_involving}`,
    action: "Verify whether this is a corporate/family group or a sector/theme label. Do not auto-remove.",
  });
}

for (const d of sameNameDiffKey) {
  queue.push({
    priority: "HIGH",
    company: `(duplicate name) ${d.group_name}`,
    ticker: "",
    current_group: d.keys.join(" | "),
    issue: "Multiple group_key values share this group_name",
    network_impact: d.counts
      .map((c) => `${c.group_key}:${impact(c.group_key).company_pairs_involving} pairs`)
      .join("; "),
    action: "Merge candidate — only after confirming the keys are the same group. Manual verification required.",
  });
}

const qSeen = new Set<string>();
const reviewQueue = queue
  .filter((q) => {
    const k = `${q.priority}|${q.ticker}|${q.current_group}|${q.issue}`;
    if (qSeen.has(k)) return false;
    qSeen.add(k);
    return true;
  })
  .sort((a, b) => {
    const o = { HIGH: 0, MEDIUM: 1, LOW: 2 } as Record<string, number>;
    return (o[a.priority] ?? 9) - (o[b.priority] ?? 9);
  });

const out = {
  universe: {
    rows: rows.length,
    unique_tickers: tickers.size,
    unique_group_keys: keys.size,
    unique_group_names: names.size,
    sizeBuckets,
    global_current_company_pairs: pairs.length,
    global_same_group_pairs: globalSame,
    global_cross_group_pairs: globalCross,
  },
  largest: groupSizes.slice(0, 40).map((g) => ({
    group: g.group_name,
    group_key: g.group_key,
    company_count: g.n,
    names_used: g.names_used,
    companies: g.companies.map((c) => `${c.ticker} (${c.company || "?"})`),
  })),
  all_groups: groupSizes.map((g) => ({
    group: g.group_name,
    group_key: g.group_key,
    company_count: g.n,
  })),
  multi,
  sectorCandidates: sectorCandidates.map((g) => ({
    group: g.group_name,
    group_key: g.group_key,
    company_count: g.n,
    companies: g.companies.map((c) => `${c.ticker} ${c.company || ""}`.trim()),
    reason: g.reason,
  })),
  sameNameDiffKey,
  sameKeyDiffName,
  similarPairs,
  uniqueSusp,
  impacts,
  reviewQueue,
};
db.close();
console.log(JSON.stringify(out, null, 2));
