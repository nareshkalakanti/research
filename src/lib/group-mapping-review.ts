/**
 * Group Mapping Review: inspect company_groups candidates and apply
 * explicit Keep/Remove/Reassign on that table only.
 */
import type Database from "better-sqlite3";
import { pairGroupType } from "@/lib/company-network";
import { openSqliteNamed } from "@/lib/sqlite-utils";

export type ReviewPriority = "HIGH" | "MEDIUM" | "LOW";
export type ReviewKind =
  | "multi_group"
  | "generic_sector"
  | "possible_duplicate"
  | "suspicious_assignment";
export type ReviewStatus =
  | "unreviewed"
  | "verified"
  | "keep"
  | "remove"
  | "reassign"
  | "merge_candidate"
  | "needs_verification";

export type GroupReviewSummary = {
  groups: number;
  companies: number;
  multi_group_companies: number;
  review_candidates: number;
  cross_group_pairs: number;
  same_group_pairs: number;
  company_pairs: number;
};

export type GroupReviewRow = {
  id: string;
  kind: ReviewKind;
  priority: ReviewPriority;
  ticker: string | null;
  company: string | null;
  current_group: string;
  current_group_key: string | null;
  other_groups: string;
  issue: string;
  governance_impact: string;
  pairs_involving: number;
};

export type MergeCandidateRow = {
  id: string;
  group_a_key: string;
  group_a: string;
  companies_a: number;
  group_b_key: string;
  group_b: string;
  companies_b: number;
  shared_companies: number;
  shared_directors: number;
  pairs_a: number;
  pairs_b: number;
  why: string;
};

type Seat = { person_id: string; ticker: string; designation: string | null };
type Pair = { a: string; b: string; shared: number };

type Graph = {
  rows: Array<{
    ticker: string;
    group_key: string;
    group_name: string;
    company: string | null;
    mcap: number | null;
  }>;
  keys: Map<string, Set<string>>;
  names: Map<string, string>;
  companies: Map<string, { name: string | null; mcap: number | null }>;
  directorNames: Map<string, string>;
  seats: Seat[];
  pairs: Pair[];
  byGroup: Map<string, Set<string>>;
  byTicker: Map<string, Array<{ group_key: string; group_name: string }>>;
};

const SECTORISH =
  /\b(bank|banking|software|engineering|petroleum|railway|railways|electronics|chemical|chemicals|healthcare|health\s*care|textile|textiles|transport|transportation|infrastructure|infra|pharma|pharmaceutical|steel|cement|sugar|power|energy|oil|gas|mining|metal|metals|auto|automobile|insurance|finance|financial|telecom|media|retail|realty|real\s*estate|construction|shipping|logistics|agriculture|agri|fmcg|hospital|hospitals|hotel|hotels|tourism|defence|defense|fertilizer|fertilizers|petrochemical|petrochemicals|infotech|infraprojects|breweries|brewery|housing)\b/i;

const GENERIC_TOKEN =
  /^(advanced|commercial|consolidated|country|creative|dynamic|exchange|natural|pearl|premier|precision|quality|sterling|systems|universal|landmark|concord|century)$/i;

function openGov(readonly: boolean): Database.Database {
  return openSqliteNamed("governance.db", { wal: true, readonly });
}

export function pairRelationship(
  a: string,
  b: string,
  keys: Map<string, Set<string>>,
): "same_group" | "cross_group" | "unclassified" {
  return pairGroupType(a, b, keys);
}

function loadGraph(db: Database.Database): Graph {
  const rows = db
    .prepare(
      `SELECT g.ticker, g.group_key, g.group_name,
              c.name AS company, m.market_cap AS mcap
       FROM company_groups g
       LEFT JOIN companies c ON c.ticker = g.ticker
       LEFT JOIN company_metrics m ON m.ticker = g.ticker`,
    )
    .all() as Graph["rows"];
  const seats = db
    .prepare(
      `SELECT s.person_id, s.ticker, s.designation, d.name AS director
       FROM board_seats s
       LEFT JOIN directors d ON d.person_id = s.person_id`,
    )
    .all() as Array<Seat & { director: string | null }>;
  const keys = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  const companies = new Map<string, { name: string | null; mcap: number | null }>();
  const byGroup = new Map<string, Set<string>>();
  const byTicker = new Map<string, Array<{ group_key: string; group_name: string }>>();
  for (const r of rows) {
    names.set(r.group_key, r.group_name);
    if (!keys.has(r.ticker)) keys.set(r.ticker, new Set());
    keys.get(r.ticker)!.add(r.group_key);
    if (!companies.has(r.ticker)) {
      companies.set(r.ticker, { name: r.company, mcap: r.mcap });
    }
    if (!byGroup.has(r.group_key)) byGroup.set(r.group_key, new Set());
    byGroup.get(r.group_key)!.add(r.ticker);
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    const list = byTicker.get(r.ticker)!;
    if (!list.some((g) => g.group_key === r.group_key)) {
      list.push({ group_key: r.group_key, group_name: r.group_name });
    }
  }
  const directorNames = new Map<string, string>();
  const seatRows: Seat[] = [];
  const byPerson = new Map<string, Map<string, number>>();
  for (const s of seats) {
    seatRows.push({
      person_id: s.person_id,
      ticker: s.ticker,
      designation: s.designation,
    });
    directorNames.set(s.person_id, s.director || s.person_id);
    if (!byPerson.has(s.person_id)) byPerson.set(s.person_id, new Map());
    byPerson.get(s.person_id)!.set(s.ticker, 1);
  }
  const pairAcc = new Map<string, number>();
  for (const tickers of byPerson.values()) {
    const t = [...tickers.keys()].sort();
    for (let i = 0; i < t.length; i++) {
      for (let j = i + 1; j < t.length; j++) {
        const k = `${t[i]}|${t[j]}`;
        pairAcc.set(k, (pairAcc.get(k) || 0) + 1);
      }
    }
  }
  const pairs: Pair[] = [...pairAcc.entries()].map(([k, shared]) => {
    const [a, b] = k.split("|");
    return { a, b, shared };
  });
  return {
    rows,
    keys,
    names,
    companies,
    directorNames,
    seats: seatRows,
    pairs,
    byGroup,
    byTicker,
  };
}

function groupImpact(graph: Graph, groupKey: string) {
  const members = graph.byGroup.get(groupKey) || new Set();
  const seatN = graph.seats.filter((s) => members.has(s.ticker)).length;
  const dirs = new Set(
    graph.seats.filter((s) => members.has(s.ticker)).map((s) => s.person_id),
  );
  const involving = graph.pairs.filter((p) => members.has(p.a) || members.has(p.b));
  const same = involving.filter((p) => members.has(p.a) && members.has(p.b));
  const cross = involving.filter(
    (p) => pairGroupType(p.a, p.b, graph.keys) === "cross_group",
  );
  return {
    seats: seatN,
    directors: dirs.size,
    companies: members.size,
    pairs_involving: involving.length,
    same_group_pairs: same.length,
    cross_group_pairs: cross.length,
  };
}

export type PairClassStats = {
  company_pairs: number;
  same_group_pairs: number;
  cross_group_pairs: number;
  unclassified_pairs: number;
};

export function networkPairStats(graph?: Graph): PairClassStats {
  let owned: Database.Database | null = null;
  const g = graph || loadGraph((owned = openGov(true)));
  let same = 0;
  let cross = 0;
  let unclassified = 0;
  for (const p of g.pairs) {
    const t = pairGroupType(p.a, p.b, g.keys);
    if (t === "same_group") same += 1;
    else if (t === "cross_group") cross += 1;
    else unclassified += 1;
  }
  owned?.close();
  return {
    company_pairs: g.pairs.length,
    same_group_pairs: same,
    cross_group_pairs: cross,
    unclassified_pairs: unclassified,
  };
}

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(
      /\b(group|ltd|limited|pvt|private|the|of|and|co|company|holdings?|industries|family|cluster)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function groupNameReviewReason(name: string): string | null {
  const n = name.trim();
  if (!n) return null;
  if (GENERIC_TOKEN.test(n)) {
    return "Potential sector/category grouping (generic token as group_name)";
  }
  if (SECTORISH.test(n) && !/\b(group|family)\b/i.test(n)) {
    return "Potential sector/category grouping";
  }
  return null;
}

function similarGroupPairs(graph: Graph): MergeCandidateRow[] {
  const groups = [...graph.byGroup.entries()].map(([key, tickers]) => ({
    key,
    name: graph.names.get(key) || key,
    n: tickers.size,
    tickers,
  }));
  const out: MergeCandidateRow[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      const na = normName(a.name);
      const nb = normName(b.name);
      if (!na || !nb) continue;
      let why = "";
      if (na === nb) why = "Normalized group_name equal";
      else if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))) {
        why = "One normalized group_name contains the other";
      }
      if (!why) continue;
      const sharedCos = [...a.tickers].filter((t) => b.tickers.has(t)).length;
      const dirsA = new Set(
        graph.seats.filter((s) => a.tickers.has(s.ticker)).map((s) => s.person_id),
      );
      const dirsB = new Set(
        graph.seats.filter((s) => b.tickers.has(s.ticker)).map((s) => s.person_id),
      );
      let sharedDirs = 0;
      for (const d of dirsA) if (dirsB.has(d)) sharedDirs += 1;
      const ia = groupImpact(graph, a.key);
      const ib = groupImpact(graph, b.key);
      const [left, right] = a.key < b.key ? [a, b] : [b, a];
      out.push({
        id: `merge:${left.key}|${right.key}`,
        group_a_key: left.key,
        group_a: left.name,
        companies_a: left.n,
        group_b_key: right.key,
        group_b: right.name,
        companies_b: right.n,
        shared_companies: sharedCos,
        shared_directors: sharedDirs,
        pairs_a: left.key === a.key ? ia.pairs_involving : ib.pairs_involving,
        pairs_b: left.key === a.key ? ib.pairs_involving : ia.pairs_involving,
        why,
      });
    }
  }
  out.sort((x, y) => y.shared_companies - x.shared_companies || x.group_a.localeCompare(y.group_a));
  return out;
}

function buildQueue(graph: Graph): GroupReviewRow[] {
  const rows: GroupReviewRow[] = [];
  for (const [ticker, groups] of graph.byTicker) {
    if (groups.length < 2) continue;
    const maxPairs = Math.max(
      ...groups.map((g) => groupImpact(graph, g.group_key).pairs_involving),
      0,
    );
    const priority: ReviewPriority =
      maxPairs >= 80 || groups.length >= 3 ? "HIGH" : maxPairs < 5 ? "LOW" : "MEDIUM";
    const co = graph.companies.get(ticker);
    rows.push({
      id: `multi:${ticker}`,
      kind: "multi_group",
      priority,
      ticker,
      company: co?.name ?? null,
      current_group: groups.map((g) => g.group_name).join(" | "),
      current_group_key: groups[0].group_key,
      other_groups: groups
        .slice(1)
        .map((g) => g.group_name)
        .join(" | "),
      issue: `${groups.length} group memberships on one ticker`,
      governance_impact: `max pairs involving assigned groups: ${maxPairs}`,
      pairs_involving: maxPairs,
    });
  }
  for (const [key, tickers] of graph.byGroup) {
    const name = graph.names.get(key) || key;
    const reason = groupNameReviewReason(name);
    if (!reason) continue;
    const imp = groupImpact(graph, key);
    const priority: ReviewPriority =
      tickers.size >= 4 && imp.pairs_involving >= 8
        ? "HIGH"
        : imp.pairs_involving >= 1
          ? "MEDIUM"
          : "LOW";
    rows.push({
      id: `group:${key}`,
      kind: "generic_sector",
      priority,
      ticker: null,
      company: `(group) ${tickers.size} companies`,
      current_group: name,
      current_group_key: key,
      other_groups: "",
      issue: reason,
      governance_impact: `${imp.pairs_involving} pairs involving; ${imp.same_group_pairs} same-group; ${imp.cross_group_pairs} cross-group`,
      pairs_involving: imp.pairs_involving,
    });
  }
  for (const m of similarGroupPairs(graph)) {
    rows.push({
      id: m.id,
      kind: "possible_duplicate",
      priority: m.shared_companies > 0 ? "HIGH" : "MEDIUM",
      ticker: null,
      company: `(merge candidate)`,
      current_group: `${m.group_a} ↔ ${m.group_b}`,
      current_group_key: m.group_a_key,
      other_groups: m.group_b,
      issue: m.why,
      governance_impact: `pairs A ${m.pairs_a}; pairs B ${m.pairs_b}; shared companies ${m.shared_companies}`,
      pairs_involving: Math.max(m.pairs_a, m.pairs_b),
    });
  }
  for (const [ticker, groups] of graph.byTicker) {
    if (groups.length !== 1) continue;
    const g = groups[0];
    const members = graph.byGroup.get(g.group_key);
    if (!members || members.size < 10) continue;
    const co = graph.companies.get(ticker)?.name || "";
    const tokens = normName(g.group_name)
      .split(" ")
      .filter((t) => t.length >= 4);
    const cn = co.toLowerCase();
    if (tokens.length && tokens.some((t) => cn.includes(t))) continue;
    const imp = groupImpact(graph, g.group_key);
    rows.push({
      id: `assign:${ticker}|${g.group_key}`,
      kind: "suspicious_assignment",
      priority: imp.pairs_involving >= 80 ? "HIGH" : "MEDIUM",
      ticker,
      company: co || null,
      current_group: g.group_name,
      current_group_key: g.group_key,
      other_groups: "",
      issue:
        "Assigned to a large group whose group_name tokens do not appear in the company legal name",
      governance_impact: `group pairs involving: ${imp.pairs_involving}`,
      pairs_involving: imp.pairs_involving,
    });
  }
  const seen = new Set<string>();
  return rows
    .filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    })
    .sort((a, b) => {
      const o = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return (
        o[a.priority] - o[b.priority] ||
        b.pairs_involving - a.pairs_involving ||
        (a.ticker || "").localeCompare(b.ticker || "")
      );
    });
}

export function loadGroupMappingReview(opts?: {
  q?: string | null;
  page?: number;
  pageSize?: number;
  priority?: string;
  kind?: string;
}): {
  summary: GroupReviewSummary;
  rows: GroupReviewRow[];
  merges: MergeCandidateRow[];
  groups: Array<{ group_key: string; group_name: string; companies: number }>;
  total: number;
  page: number;
  pages: number;
} {
  const db = openGov(true);
  try {
    const graph = loadGraph(db);
    const stats = networkPairStats(graph);
    const queue = buildQueue(graph);
    const merges = similarGroupPairs(graph);
    const multi = [...graph.byTicker.values()].filter((g) => g.length > 1).length;
    const generic = queue.filter((r) => r.kind === "generic_sector").length;
    const summary: GroupReviewSummary = {
      groups: graph.byGroup.size,
      companies: graph.byTicker.size,
      multi_group_companies: multi,
      review_candidates: generic,
      cross_group_pairs: stats.cross_group_pairs,
      same_group_pairs: stats.same_group_pairs,
      company_pairs: stats.company_pairs,
    };
    const q = (opts?.q || "").trim().toLowerCase();
    const pri = (opts?.priority || "all").toUpperCase();
    const kind = opts?.kind || "all";
    const filtered = queue.filter((r) => {
      if (pri !== "ALL" && r.priority !== pri) return false;
      if (kind === "multi_group" && r.kind !== "multi_group") return false;
      if (kind === "generic_sector" && r.kind !== "generic_sector") return false;
      if (kind === "possible_duplicate" && r.kind !== "possible_duplicate") return false;
      if (kind === "suspicious_assignment" && r.kind !== "suspicious_assignment") {
        return false;
      }
      if (!q) return true;
      const blob = [
        r.ticker,
        r.company,
        r.current_group,
        r.other_groups,
        r.issue,
      ]
        .join(" ")
        .toLowerCase();
      if (blob.includes(q)) return true;
      if (r.ticker) {
        for (const s of graph.seats.filter((s) => s.ticker === r.ticker)) {
          const n = graph.directorNames.get(s.person_id) || "";
          if (n.toLowerCase().includes(q)) return true;
        }
      }
      return false;
    });
    const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(Math.max(1, opts?.page ?? 1), pages);
    const groups = [...graph.byGroup.entries()]
      .map(([group_key, set]) => ({
        group_key,
        group_name: graph.names.get(group_key) || group_key,
        companies: set.size,
      }))
      .sort((a, b) => b.companies - a.companies || a.group_name.localeCompare(b.group_name));
    return {
      summary,
      rows: filtered.slice((page - 1) * pageSize, page * pageSize),
      merges,
      groups,
      total: filtered.length,
      page,
      pages,
    };
  } finally {
    db.close();
  }
}

export function loadGroupReviewCompany(ticker: string) {
  const db = openGov(true);
  try {
    const graph = loadGraph(db);
    const t = ticker.trim().toUpperCase();
    const co = graph.companies.get(t) || {
      name: (
        db.prepare(`SELECT name FROM companies WHERE ticker = ?`).get(t) as
          | { name: string }
          | undefined
      )?.name ?? null,
      mcap:
        (
          db
            .prepare(`SELECT market_cap AS mcap FROM company_metrics WHERE ticker = ?`)
            .get(t) as { mcap: number | null } | undefined
        )?.mcap ?? null,
    };
    const memberships = graph.byTicker.get(t) || [];
    const myDirs = graph.seats.filter((s) => s.ticker === t);
    const dirIds = new Set(myDirs.map((s) => s.person_id));
    const connAcc = new Map<
      string,
      { shared: number; people: string[] }
    >();
    for (const s of graph.seats) {
      if (!dirIds.has(s.person_id) || s.ticker === t) continue;
      const cur = connAcc.get(s.ticker) || { shared: 0, people: [] };
      cur.shared += 1;
      cur.people.push(s.person_id);
      connAcc.set(s.ticker, cur);
    }
    const connections = [...connAcc.entries()].map(([ot, info]) => {
      const oc = graph.companies.get(ot);
      const gs = graph.byTicker.get(ot) || [];
      return {
        ticker: ot,
        company: oc?.name ?? null,
        mcap: oc?.mcap ?? null,
        groups: gs.map((g) => g.group_name).join(", ") || "Unclassified",
        shared_directors: info.shared,
        relationship_type: pairGroupType(t, ot, graph.keys),
      };
    });
    connections.sort(
      (a, b) =>
        b.shared_directors - a.shared_directors || a.ticker.localeCompare(b.ticker),
    );
    const same = connections.filter((c) => c.relationship_type === "same_group").length;
    const cross = connections.filter((c) => c.relationship_type === "cross_group").length;
    const directors = myDirs.map((s) => {
      const otherSeats = graph.seats.filter(
        (x) => x.person_id === s.person_id && x.ticker !== t,
      );
      const otherTickers = [...new Set(otherSeats.map((x) => x.ticker))];
      return {
        person_id: s.person_id,
        director: graph.directorNames.get(s.person_id) || s.person_id,
        designation: s.designation,
        other_boards: otherTickers.length,
        other_companies: otherTickers.map((ot) => ({
          ticker: ot,
          company: graph.companies.get(ot)?.name ?? null,
          groups: (graph.byTicker.get(ot) || []).map((g) => g.group_name).join(", "),
        })),
      };
    });
    const memImpact = memberships.map((m) => ({
      ...m,
      impact: groupImpact(graph, m.group_key),
    }));
    return {
      ticker: t,
      company: co.name,
      mcap: co.mcap,
      memberships: memImpact,
      current_directors: directors.length,
      connected_companies: connections.length,
      same_group_connections: same,
      cross_group_connections: cross,
      connections,
      directors,
    };
  } finally {
    db.close();
  }
}

export function loadGroupReviewGroup(groupKey: string) {
  const db = openGov(true);
  try {
    const graph = loadGraph(db);
    const key = groupKey.trim();
    const members = [...(graph.byGroup.get(key) || [])].sort();
    const impact = groupImpact(graph, key);
    const companies = members.map((ticker) => {
      const dirs = new Set(
        graph.seats.filter((s) => s.ticker === ticker).map((s) => s.person_id),
      );
      const others = (graph.byTicker.get(ticker) || []).filter(
        (g) => g.group_key !== key,
      );
      return {
        ticker,
        company: graph.companies.get(ticker)?.name ?? null,
        mcap: graph.companies.get(ticker)?.mcap ?? null,
        directors: dirs.size,
        other_groups: others.map((g) => g.group_name).join(" | "),
      };
    });
    return {
      group_key: key,
      group_name: graph.names.get(key) || key,
      reason: groupNameReviewReason(graph.names.get(key) || "") || "",
      ...impact,
      companies,
    };
  } finally {
    db.close();
  }
}

export type MappingChange = {
  action: "remove" | "reassign" | "insert";
  ticker: string;
  group_key: string;
  new_group_key?: string;
  expected_group_name?: string;
};

export type MappingWriteResult = {
  ok: boolean;
  committed: boolean;
  message: string;
  company_groups_changed: number;
  removed: number;
  reassigned: number;
  added: number;
  before: PairClassStats | null;
  after: PairClassStats | null;
  affected: Array<{
    ticker_a: string;
    ticker_b: string;
    before: string;
    after: string;
    reason: string;
  }>;
  changes: Array<{
    ticker: string;
    company: string | null;
    current_group: string;
    action: string;
    new_group: string | null;
  }>;
};

function integritySnapshot(db: Database.Database) {
  const uniqueSeats = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT DISTINCT ticker, person_id FROM board_seats
         )`,
      )
      .get() as { n: number }
  ).n;
  return {
    board_seats: countTable(db, "board_seats"),
    unique_seats: uniqueSeats,
    board_seat_events: countTable(db, "board_seat_events"),
    directors: countTable(db, "directors"),
    companies: countTable(db, "companies"),
    company_metrics: countTable(db, "company_metrics"),
  };
}

function dumpGroups(db: Database.Database) {
  return db
    .prepare(
      `SELECT ticker, group_key, group_name FROM company_groups
       ORDER BY ticker, group_key`,
    )
    .all() as Array<{ ticker: string; group_key: string; group_name: string }>;
}

function groupNameForKey(
  db: Database.Database,
  groupKey: string,
): string | null {
  const row = db
    .prepare(
      `SELECT group_name FROM company_groups WHERE group_key = ? LIMIT 1`,
    )
    .get(groupKey) as { group_name: string } | undefined;
  return row?.group_name ?? null;
}

function membership(
  db: Database.Database,
  ticker: string,
  groupKey: string,
) {
  return db
    .prepare(
      `SELECT ticker, group_key, group_name FROM company_groups
       WHERE ticker = ? AND group_key = ?`,
    )
    .get(ticker, groupKey) as
    | { ticker: string; group_key: string; group_name: string }
    | undefined;
}

function classifyDiff(
  beforeKeys: Map<string, Set<string>>,
  afterKeys: Map<string, Set<string>>,
  pairs: Pair[],
  reason: string,
) {
  const affected: MappingWriteResult["affected"] = [];
  let same = 0;
  let cross = 0;
  let unclassified = 0;
  for (const p of pairs) {
    const a = pairGroupType(p.a, p.b, afterKeys);
    if (a === "same_group") same += 1;
    else if (a === "cross_group") cross += 1;
    else unclassified += 1;
    const b = pairGroupType(p.a, p.b, beforeKeys);
    if (a !== b) {
      affected.push({
        ticker_a: p.a,
        ticker_b: p.b,
        before: b,
        after: a,
        reason,
      });
    }
  }
  return {
    after: {
      company_pairs: pairs.length,
      same_group_pairs: same,
      cross_group_pairs: cross,
      unclassified_pairs: unclassified,
    },
    affected,
  };
}

function cloneKeys(
  keys: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const next = new Map<string, Set<string>>();
  for (const [t, set] of keys) next.set(t, new Set(set));
  return next;
}

function applyChangeToKeys(
  keys: Map<string, Set<string>>,
  change: MappingChange,
): Map<string, Set<string>> {
  const next = cloneKeys(keys);
  const set = next.get(change.ticker) || new Set();
  if (change.action === "remove") {
    set.delete(change.group_key);
  } else if (change.action === "reassign") {
    const nk = change.new_group_key;
    if (!nk) return next;
    set.delete(change.group_key);
    set.add(nk);
  } else if (change.action === "insert") {
    set.add(change.group_key);
  }
  if (set.size) next.set(change.ticker, set);
  else next.delete(change.ticker);
  return next;
}

export function previewMappingChange(change: MappingChange): {
  before: PairClassStats;
  after: PairClassStats;
  affected: MappingWriteResult["affected"];
  summary: { removed: number; reassigned: number; added: number };
  change: MappingWriteResult["changes"][number];
} {
  const db = openGov(true);
  try {
    const graph = loadGraph(db);
    const before = networkPairStats(graph);
    const ticker = change.ticker.trim().toUpperCase();
    const afterKeys = applyChangeToKeys(graph.keys, {
      ...change,
      ticker,
    });
    const diff = classifyDiff(
      graph.keys,
      afterKeys,
      graph.pairs,
      `${change.action} ${ticker} ${change.group_key}${
        change.new_group_key ? ` → ${change.new_group_key}` : ""
      }`,
    );
    const co = graph.companies.get(ticker);
    const current = membership(db, ticker, change.group_key.trim());
    return {
      before,
      after: diff.after,
      affected: diff.affected,
      summary: {
        removed: change.action === "remove" ? 1 : 0,
        reassigned: change.action === "reassign" ? 1 : 0,
        added: change.action === "insert" ? 1 : 0,
      },
      change: {
        ticker,
        company: co?.name ?? null,
        current_group: current?.group_name || change.group_key,
        action: change.action,
        new_group:
          change.action === "reassign"
            ? groupNameForKey(db, change.new_group_key || "")
            : change.action === "insert"
              ? groupNameForKey(db, change.group_key)
              : null,
      },
    };
  } finally {
    db.close();
  }
}

function emptyWrite(message: string): MappingWriteResult {
  return {
    ok: false,
    committed: false,
    message,
    company_groups_changed: 0,
    removed: 0,
    reassigned: 0,
    added: 0,
    before: null,
    after: null,
    affected: [],
    changes: [],
  };
}

export function confirmMappingWrites(
  changes: MappingChange[],
  opts?: { confirm?: boolean; db?: Database.Database },
): MappingWriteResult {
  if (!opts?.confirm) {
    return emptyWrite("Confirmation required. No database changes were committed.");
  }
  if (!changes.length) {
    return emptyWrite("No mappings selected. No database changes were committed.");
  }
  const owned = !opts.db;
  const db = opts.db || openGov(false);
  try {
    const graphBefore = loadGraph(db);
    const before = networkPairStats(graphBefore);
    const tablesBefore = integritySnapshot(db);
    const dumpBefore = dumpGroups(db);
    const keysBefore = graphBefore.keys;

    const run = db.transaction(() => {
      let removed = 0;
      let reassigned = 0;
      let added = 0;
      const planned: MappingWriteResult["changes"] = [];
      const allowedTickers = new Set<string>();
      const reasons: string[] = [];

      for (const raw of changes) {
        const ticker = raw.ticker.trim().toUpperCase();
        const groupKey = raw.group_key.trim();
        if (!ticker || !groupKey) {
          throw new Error("ticker and group_key required");
        }
        allowedTickers.add(ticker);
        const current = membership(db, ticker, groupKey);
        if (raw.action === "remove" || raw.action === "reassign") {
          if (!current) {
            throw new Error(
              `Conflict: ${ticker} is no longer in ${groupKey}. Fresh review required.`,
            );
          }
          if (
            raw.expected_group_name &&
            current.group_name !== raw.expected_group_name
          ) {
            throw new Error(
              `Conflict: ${ticker} group_name is now ${current.group_name}, review showed ${raw.expected_group_name}.`,
            );
          }
        }
        const co =
          (
            db
              .prepare(`SELECT name FROM companies WHERE ticker = ?`)
              .get(ticker) as { name: string } | undefined
          )?.name ?? null;

        if (raw.action === "remove") {
          db.prepare(
            `DELETE FROM company_groups WHERE ticker = ? AND group_key = ?`,
          ).run(ticker, groupKey);
          removed += 1;
          planned.push({
            ticker,
            company: co,
            current_group: current!.group_name,
            action: "remove",
            new_group: null,
          });
          reasons.push(`remove ${ticker} ${groupKey}`);
        } else if (raw.action === "reassign") {
          const nk = (raw.new_group_key || "").trim();
          if (!nk) throw new Error("new_group_key required");
          const targetName = groupNameForKey(db, nk);
          if (!targetName) {
            throw new Error(
              "Target group_key does not exist. No new groups are created.",
            );
          }
          const already = membership(db, ticker, nk);
          db.prepare(
            `DELETE FROM company_groups WHERE ticker = ? AND group_key = ?`,
          ).run(ticker, groupKey);
          if (!already) {
            db.prepare(
              `INSERT INTO company_groups (ticker, group_key, group_name, updated_at)
               VALUES (?, ?, ?, ?)`,
            ).run(ticker, nk, targetName, new Date().toISOString());
          }
          reassigned += 1;
          planned.push({
            ticker,
            company: co,
            current_group: current!.group_name,
            action: "reassign",
            new_group: targetName,
          });
          reasons.push(`reassign ${ticker} ${groupKey} → ${nk}`);
        } else if (raw.action === "insert") {
          const targetName = groupNameForKey(db, groupKey);
          if (!targetName) {
            throw new Error(
              "Target group_key does not exist. No new groups are created.",
            );
          }
          if (current) {
            throw new Error(`Membership already present for ${ticker}`);
          }
          db.prepare(
            `INSERT INTO company_groups (ticker, group_key, group_name, updated_at)
             VALUES (?, ?, ?, ?)`,
          ).run(ticker, groupKey, targetName, new Date().toISOString());
          added += 1;
          planned.push({
            ticker,
            company: co,
            current_group: targetName,
            action: "insert",
            new_group: targetName,
          });
          reasons.push(`insert ${ticker} ${groupKey}`);
        } else {
          throw new Error("Unknown action");
        }
      }

      const dups = db
        .prepare(
          `SELECT ticker, group_key, COUNT(*) AS n FROM company_groups
           GROUP BY ticker, group_key HAVING n > 1`,
        )
        .all() as Array<{ ticker: string; group_key: string; n: number }>;
      if (dups.length) throw new Error("Duplicate company_groups membership");

      const nameSplit = db
        .prepare(
          `SELECT group_key FROM company_groups
           GROUP BY group_key HAVING COUNT(DISTINCT group_name) > 1`,
        )
        .all() as Array<{ group_key: string }>;
      if (nameSplit.length) throw new Error("Inconsistent group_name for group_key");

      const dumpAfter = dumpGroups(db);
      const beforeSet = new Set(
        dumpBefore.map((r) => `${r.ticker}|${r.group_key}|${r.group_name}`),
      );
      const afterSet = new Set(
        dumpAfter.map((r) => `${r.ticker}|${r.group_key}|${r.group_name}`),
      );
      for (const row of dumpAfter) {
        const k = `${row.ticker}|${row.group_key}|${row.group_name}`;
        if (!beforeSet.has(k) && !allowedTickers.has(row.ticker)) {
          throw new Error(`Unintended ticker changed: ${row.ticker}`);
        }
      }
      for (const row of dumpBefore) {
        const k = `${row.ticker}|${row.group_key}|${row.group_name}`;
        if (!afterSet.has(k) && !allowedTickers.has(row.ticker)) {
          throw new Error(`Unintended ticker changed: ${row.ticker}`);
        }
      }

      const tablesAfter = integritySnapshot(db);
      for (const key of Object.keys(tablesBefore) as Array<keyof typeof tablesBefore>) {
        if (tablesAfter[key] !== tablesBefore[key]) {
          throw new Error(`${key} count changed; rolling back`);
        }
      }

      const graphAfter = loadGraph(db);
      if (graphAfter.pairs.length !== graphBefore.pairs.length) {
        throw new Error(
          `Company-company topology changed (${graphBefore.pairs.length} → ${graphAfter.pairs.length})`,
        );
      }
      const afterKeys = graphAfter.keys;
      const diff = classifyDiff(
        keysBefore,
        afterKeys,
        graphBefore.pairs,
        reasons.join("; "),
      );
      if (diff.after.company_pairs !== before.company_pairs) {
        throw new Error("Company-company pair count changed");
      }

      return {
        removed,
        reassigned,
        added,
        planned,
        after: diff.after,
        affected: diff.affected,
      };
    });

    const applied = run();
    return {
      ok: true,
      committed: true,
      message: "company_groups updated. Network validation complete.",
      company_groups_changed: applied.removed + applied.reassigned + applied.added,
      removed: applied.removed,
      reassigned: applied.reassigned,
      added: applied.added,
      before,
      after: applied.after,
      affected: applied.affected,
      changes: applied.planned,
    };
  } catch (err) {
    return emptyWrite(
      `${err instanceof Error ? err.message : String(err)} No database changes were committed.`,
    );
  } finally {
    if (owned) db.close();
  }
}

export function applyMappingChange(
  change: MappingChange,
  opts?: { confirm?: boolean; db?: Database.Database },
): MappingWriteResult {
  return confirmMappingWrites([change], opts);
}

export function countTable(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
