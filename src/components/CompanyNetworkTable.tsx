"use client";

import { useEffect, useState, Fragment } from "react";
import { tradingviewUrl } from "@/lib/links";

type PairRow = {
  ticker_a: string;
  ticker_b: string;
  shared_directors: number;
  name_a: string | null;
  name_b: string | null;
};

type DirectorHubRow = {
  person_id: string;
  director: string;
  boards: number;
  groups: number;
  largest_mcap: number | null;
  smallest_mcap: number | null;
  mcap_spread: number | null;
  new_connections: number;
  cross_group: number;
};

type DirectorHubSeat = {
  ticker: string;
  company: string | null;
  market_cap: number | null;
  group_name: string | null;
  designation: string | null;
};

type DirectorHubSummary = {
  directors: number;
  boards_3: number;
  boards_5: number;
  boards_7: number;
  groups_2: number;
  cross_group: number;
};

type ClusterRow = {
  cluster: string;
  companies: number;
  companies_with_groups?: number;
  companies_without_groups?: number;
  directors: number;
  groups: number;
  direct_relationships: number;
  same_group_relationships: number;
  cross_group_relationships: number;
  unclassified_relationships: number;
  largest_mcap: number | null;
  smallest_mcap: number | null;
  total_mcap: number | null;
  density: number | null;
  multi_director_relationships: number;
};

type ClusterSummary = {
  clusters: number;
  companies: number;
  isolated_companies: number;
  directors: number;
  groups: number;
  governance_connections: number;
  cross_group_relationships: number;
};

type ClusterDetail = {
  cluster: ClusterRow | null;
  companies: Array<{
    ticker: string;
    company: string | null;
    market_cap: number | null;
    group_name: string | null;
    directors_in_cluster: number;
    connections_in_cluster: number;
  }>;
  directors: Array<{
    person_id: string;
    director: string;
    boards_in_cluster: number;
    total_boards: number;
    groups_represented: number;
    companies_connected: number;
  }>;
  connections: Array<{
    ticker_a: string;
    company_a: string | null;
    mcap_a: number | null;
    group_a: string | null;
    ticker_b: string;
    company_b: string | null;
    mcap_b: number | null;
    group_b: string | null;
    shared_directors: number;
    shared_people?: Array<{ person_id: string; director: string }>;
    relationship_type: "same_group" | "cross_group" | "unclassified";
  }>;
  groups: Array<{
    group_key: string;
    group_name: string;
    companies: number;
    directors: number;
    connections: number;
    cross_group_connections: number;
  }>;
};

type ClusterShared = {
  pair: ClusterDetail["connections"][number] | null;
  directors: Array<{
    person_id: string;
    director: string;
    designation_a: string | null;
    designation_b: string | null;
  }>;
};

type GmapRow = {
  id: string;
  kind: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  ticker: string | null;
  company: string | null;
  current_group: string;
  current_group_key: string | null;
  other_groups: string;
  issue: string;
  governance_impact: string;
  pairs_involving: number;
};

type GmapSummary = {
  groups: number;
  companies: number;
  multi_group_companies: number;
  review_candidates: number;
  cross_group_pairs: number;
  same_group_pairs: number;
  company_pairs: number;
};

type GmapMerge = {
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

type GmapCompanyDetail = {
  ticker: string;
  company: string | null;
  mcap: number | null;
  memberships: Array<{
    group_key: string;
    group_name: string;
    impact: {
      seats: number;
      directors: number;
      companies: number;
      pairs_involving: number;
      same_group_pairs: number;
      cross_group_pairs: number;
    };
  }>;
  current_directors: number;
  connected_companies: number;
  same_group_connections: number;
  cross_group_connections: number;
  connections: Array<{
    ticker: string;
    company: string | null;
    mcap: number | null;
    groups: string;
    shared_directors: number;
    relationship_type: string;
  }>;
  directors: Array<{
    person_id: string;
    director: string;
    designation: string | null;
    other_boards: number;
    other_companies: Array<{
      ticker: string;
      company: string | null;
      groups: string;
    }>;
  }>;
};

type GmapGroupDetail = {
  group_key: string;
  group_name: string;
  reason: string;
  seats: number;
  directors: number;
  pairs_involving: number;
  same_group_pairs: number;
  cross_group_pairs: number;
  companies: Array<{
    ticker: string;
    company: string | null;
    mcap: number | null;
    directors: number;
    other_groups: string;
  }>;
};

type GmapPreview = {
  before: {
    company_pairs: number;
    same_group_pairs: number;
    cross_group_pairs: number;
    unclassified_pairs: number;
  };
  after: {
    company_pairs: number;
    same_group_pairs: number;
    cross_group_pairs: number;
    unclassified_pairs: number;
  };
  affected: Array<{
    ticker_a: string;
    ticker_b: string;
    before: string;
    after: string;
    reason: string;
  }>;
  summary?: { removed: number; reassigned: number; added: number };
  change?: {
    ticker: string;
    company: string | null;
    current_group: string;
    action: string;
    new_group: string | null;
  };
};

type GmapWriteResult = {
  ok: boolean;
  committed: boolean;
  message: string;
  company_groups_changed: number;
  removed: number;
  reassigned: number;
  added: number;
  before: GmapPreview["before"] | null;
  after: GmapPreview["after"] | null;
  affected: GmapPreview["affected"];
  changes: Array<{
    ticker: string;
    company: string | null;
    current_group: string;
    action: string;
    new_group: string | null;
  }>;
};

type XgPane = "groups" | "companies" | "directors";

type XgSummary = {
  relationships: number;
  directors: number;
  companies: number;
  group_pairs: number;
  groups: number;
};

type XgPairRow = {
  group_a_key: string;
  group_a: string;
  group_b_key: string;
  group_b: string;
  directors: number;
  companies: number;
  relationships: number;
  largest_mcap: number | null;
  smallest_mcap: number | null;
};

type XgCompanyRow = {
  ticker: string;
  company: string | null;
  market_cap: number | null;
  group_name: string | null;
  connected_groups: number;
  cross_group_companies: number;
  cross_group_directors: number;
  largest_connected_mcap: number | null;
  bridge_directors: string | null;
};

type XgDirectorRow = {
  person_id: string;
  director: string;
  boards: number;
  groups: number;
  cross_group_groups: number;
  cross_group_companies: number;
  cross_group_relationships: number;
};

type XgEdgeRow = {
  person_id: string;
  director: string;
  company_a_ticker: string;
  company_a: string | null;
  company_a_mcap: number | null;
  group_a: string;
  company_b_ticker: string;
  company_b: string | null;
  company_b_mcap: number | null;
  group_b: string;
};

type XgOption = { key: string; name: string };

type ConnectivityRow = {
  ticker: string;
  name: string | null;
  market_cap_cr: number | null;
  cap_code: string;
  total_directors: number;
  externally_connected_directors: number;
  connected_share: number | null;
};

type CapBand = { code: string; label: string };

type DiscoveryRow = {
  ticker: string;
  name: string | null;
  market_cap: number | null;
  connected_companies: number;
  directors: number;
  board_directors: number;
  largest_connected_mcap: number | null;
  cross_group: boolean;
};

type DiscoverySummary = {
  companies: number;
  boards_3: number;
  connected_5k: number;
  connected_10k: number;
  cross_group: number;
};

function discoveryBadges(row: DiscoveryRow): string[] {
  const out: string[] = [];
  if (row.board_directors >= 3) out.push("3+ Boards");
  if ((row.largest_connected_mcap ?? 0) >= 10_000) out.push("₹10k+ Connection");
  else if ((row.largest_connected_mcap ?? 0) >= 5000) out.push("₹5k+ Connection");
  if (row.cross_group) out.push("Cross Group");
  if (row.connected_companies >= 2) out.push("2+ Connections");
  return out;
}

type NewConnRow = {
  target_ticker: string;
  target_company: string | null;
  target_market_cap: number | null;
  director: string;
  person_id: string;
  event_date: string;
  connected_ticker: string;
  connected_company: string | null;
  connected_market_cap: number | null;
  market_cap_ratio: number | null;
  connection_type: "same_group" | "cross_group" | "unclassified";
  board_count: number | null;
  target_designation?: string | null;
  connected_designation?: string | null;
  connected_current?: number;
  connected_joined_at?: string | null;
  connected_resigned_at?: string | null;
};

type NewConnTarget = {
  target_ticker: string;
  target_company: string | null;
  target_market_cap: number | null;
  connected_companies: number;
  n_10k: number;
  n_25k: number;
  n_50k: number;
  largest_connected_mcap: number | null;
  largest_connected_ticker: string | null;
  largest_connected_company: string | null;
  largest_ratio: number | null;
  cross_group_count: number;
  multi_board_director_count: number;
};

type NewConnSummary = {
  edges: number;
  unique_targets: number;
  unique_directors: number;
  cross_group: number;
  mega_connections: number;
  n_10k_connections?: number;
  n_25k_connections?: number;
};

type TinyGapRow = {
  target_ticker: string;
  target_company: string | null;
  target_market_cap: number | null;
  band: "lt100" | "100_250" | "250_500" | "500_1000";
  connected_company_count: number;
  distinct_director_count: number;
  max_connected_market_cap: number | null;
  largest_connected_ticker: string | null;
  largest_connected_company: string | null;
  max_market_cap_ratio: number | null;
  connected_10000cr_count: number;
  connected_25000cr_count: number;
  connected_50000cr_count: number;
  cross_group_count: number;
};

type TinyGapSummary = {
  companies: number;
  band_lt100: number;
  band_100_250: number;
  band_250_500: number;
  band_500_1000: number;
  connected_10k: number;
  max_gap_50x: number;
  cross_group: number;
};

type TinyGapDetail = {
  company: TinyGapRow | null;
  connections: NewConnRow[];
  directors: Array<{
    person_id: string;
    director: string;
    connected_companies: number;
  }>;
  groups: Array<{ group_key: string; group_name: string; tickers: string[] }>;
};

type TinySort =
  | "mcap"
  | "connected"
  | "directors"
  | "largest"
  | "ratio"
  | "n10k"
  | "n25k"
  | "n50k"
  | "cross";

type HubSort =
  | "boards"
  | "groups"
  | "largest"
  | "smallest"
  | "spread"
  | "new"
  | "cross";

type GapSort =
  | "ratio"
  | "mcap"
  | "connected"
  | "n10k"
  | "n25k"
  | "n50k"
  | "cross"
  | "multi";

type Mode = "connectivity" | "discovery" | "new" | "gap" | "tiny" | "pairs" | "directors" | "xgroup" | "clusters" | "gmap";
type NewPane = "connections" | "anomalies";
type AnomalyKind = "gap" | "multi" | "cross" | "boards" | "large";

const GOVERNANCE_NETWORK_COVERAGE_NOTE =
  "Governance coverage: NSE / NSE SME network. BSE SME companies are included in the company universe and market-cap data but excluded from governance connections because reliable current board extraction is unavailable.";

const VIEW_BY_MODE: Record<Mode, string> = {
  connectivity: "company-connectivity",
  discovery: "network-discovery",
  new: "network-new-connections",
  gap: "network-new-connections",
  tiny: "tiny-capital-gap",
  pairs: "company-network",
  directors: "director-hubs",
  xgroup: "cross-group-network",
  clusters: "network-clusters",
  gmap: "group-mapping-review",
};

const NOUN_BY_MODE: Record<Mode, string> = {
  connectivity: "companies",
  discovery: "companies",
  new: "new connections",
  gap: "companies",
  tiny: "companies",
  pairs: "pairs",
  directors: "directors",
  xgroup: "connections",
  clusters: "clusters",
  gmap: "review items",
};

function fmtRatio(v: number | null): string {
  if (v == null) return "N/A";
  return `${v.toLocaleString("en-IN", { maximumFractionDigits: 1 })}x`;
}

function fmtCr(v: number | null): string {
  if (v == null) return "N/A";
  const digits = Math.abs(v) < 10 ? 2 : 0;
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: digits })} Cr`;
}

function fmtShare(v: number | null): string {
  if (v == null) return "N/A";
  return `${Math.round(v * 100)}%`;
}

function fmtEventDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function connLabel(v: NewConnRow["connection_type"]): string {
  if (v === "same_group") return "Same group";
  if (v === "cross_group") return "Cross group";
  return "Unclassified";
}

function anomalyBadges(row: NewConnRow): string[] {
  const badges: string[] = [];
  const ratio = row.market_cap_ratio ?? 0;
  const mcap = row.connected_market_cap ?? 0;
  const boards = row.board_count ?? 0;
  if (ratio >= 500) badges.push("500x+ GAP");
  else if (ratio >= 250) badges.push("250x+ GAP");
  else if (ratio >= 100) badges.push("100x+ GAP");
  else if (ratio >= 50) badges.push("50x+ GAP");
  else if (ratio >= 25) badges.push("25x+ GAP");
  else if (ratio >= 10) badges.push("10x+ GAP");
  if (mcap >= 50_000) badges.push("₹50kCr+");
  else if (mcap >= 25_000) badges.push("₹25kCr+");
  else if (mcap >= 10_000) badges.push("₹10kCr+");
  if (row.connection_type === "cross_group") badges.push("CROSS GROUP");
  if (boards >= 5) badges.push("5+ BOARDS");
  else if (boards >= 4) badges.push("4+ BOARDS");
  else if (boards >= 3) badges.push("3+ BOARDS");
  return badges;
}

export function CompanyNetworkTable({
  onPerson,
  chartUrl,
  onTargetTicker,
}: {
  onPerson: (personId: string, name: string) => void;
  chartUrl?: (ticker: string) => string;
  onTargetTicker?: (ticker: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("gap");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [caps, setCaps] = useState<string[] | null>(null);
  const [bands, setBands] = useState<CapBand[]>([]);
  const [pairs, setPairs] = useState<PairRow[]>([]);
  const [hubs, setHubs] = useState<DirectorHubRow[]>([]);
  const [hubSummary, setHubSummary] = useState<DirectorHubSummary | null>(null);
  const [hubSeats, setHubSeats] = useState<DirectorHubSeat[]>([]);
  const [hubPerson, setHubPerson] = useState<string | null>(null);
  const [hubMinBoards, setHubMinBoards] = useState("3");
  const [hubMinGroups, setHubMinGroups] = useState("0");
  const [hubMinSpread, setHubMinSpread] = useState("0");
  const [hubCross, setHubCross] = useState("any");
  const [hubSort, setHubSort] = useState<HubSort>("boards");
  const [xgPane, setXgPane] = useState<XgPane>("groups");
  const [xgSummary, setXgSummary] = useState<XgSummary | null>(null);
  const [xgPairs, setXgPairs] = useState<XgPairRow[]>([]);
  const [xgCompanies, setXgCompanies] = useState<XgCompanyRow[]>([]);
  const [xgDirectors, setXgDirectors] = useState<XgDirectorRow[]>([]);
  const [xgGroups, setXgGroups] = useState<XgOption[]>([]);
  const [xgGroup, setXgGroup] = useState("");
  const [xgMinMcap, setXgMinMcap] = useState("0");
  const [xgMinCos, setXgMinCos] = useState("0");
  const [xgDrill, setXgDrill] = useState<string | null>(null);
  const [xgEdges, setXgEdges] = useState<XgEdgeRow[]>([]);
  const [clusterRows, setClusterRows] = useState<ClusterRow[]>([]);
  const [clusterSummary, setClusterSummary] = useState<ClusterSummary | null>(
    null,
  );
  const [clusterMinCos, setClusterMinCos] = useState("2");
  const [clusterMinDirs, setClusterMinDirs] = useState("0");
  const [clusterMinGroups, setClusterMinGroups] = useState("0");
  const [clusterMinConn, setClusterMinConn] = useState("0");
  const [clusterMulti, setClusterMulti] = useState("any");
  const [clusterQCompany, setClusterQCompany] = useState("");
  const [clusterQTicker, setClusterQTicker] = useState("");
  const [clusterQDirector, setClusterQDirector] = useState("");
  const [clusterQGroup, setClusterQGroup] = useState("");
  const [clusterCross, setClusterCross] = useState("any");
  const [clusterMinMcap, setClusterMinMcap] = useState("0");
  const [clusterOpen, setClusterOpen] = useState<string | null>(null);
  const [clusterDetail, setClusterDetail] = useState<ClusterDetail | null>(null);
  const [clusterTab, setClusterTab] = useState<
    "overview" | "companies" | "directors" | "connections" | "groups"
  >("overview");
  const [clusterPair, setClusterPair] = useState<string | null>(null);
  const [clusterShared, setClusterShared] = useState<ClusterShared | null>(null);
  const [gmapRows, setGmapRows] = useState<GmapRow[]>([]);
  const [gmapSummary, setGmapSummary] = useState<GmapSummary | null>(null);
  const [gmapMerges, setGmapMerges] = useState<GmapMerge[]>([]);
  const [gmapGroups, setGmapGroups] = useState<
    Array<{ group_key: string; group_name: string; companies: number }>
  >([]);
  const [gmapPane, setGmapPane] = useState<"queue" | "merges" | "groups">("queue");
  const [gmapPriority, setGmapPriority] = useState("all");
  const [gmapKind, setGmapKind] = useState("all");
  const [gmapStatusFilter, setGmapStatusFilter] = useState("all");
  const [gmapStatus, setGmapStatus] = useState<Record<string, string>>({});
  const [gmapOpen, setGmapOpen] = useState<GmapRow | null>(null);
  const [gmapCompany, setGmapCompany] = useState<GmapCompanyDetail | null>(null);
  const [gmapGroup, setGmapGroup] = useState<GmapGroupDetail | null>(null);
  const [gmapMergeOpen, setGmapMergeOpen] = useState<string | null>(null);
  const [gmapPreview, setGmapPreview] = useState<GmapPreview | null>(null);
  const [gmapAction, setGmapAction] = useState<{
    action: "remove" | "reassign";
    ticker: string;
    group_key: string;
    new_group_key?: string;
    expected_group_name?: string;
  } | null>(null);
  const [gmapReassignTo, setGmapReassignTo] = useState("");
  const [gmapWrite, setGmapWrite] = useState<GmapWriteResult | null>(null);
  const [gmapTick, setGmapTick] = useState(0);
  const [companies, setCompanies] = useState<ConnectivityRow[]>([]);
  const [discovery, setDiscovery] = useState<DiscoveryRow[]>([]);
  const [discSummary, setDiscSummary] = useState<DiscoverySummary | null>(null);
  const [discMcap, setDiscMcap] = useState("all");
  const [discSignal, setDiscSignal] = useState("all");
  const [news, setNews] = useState<NewConnRow[]>([]);
  const [targets, setTargets] = useState<NewConnTarget[]>([]);
  const [summary, setSummary] = useState<NewConnSummary | null>(null);
  const [days, setDays] = useState("180");
  const [connection, setConnection] = useState("any");
  const [minConnected, setMinConnected] = useState("0");
  const [minRatio, setMinRatio] = useState("0");
  const [maxTargetFilter, setMaxTargetFilter] = useState("5000");
  const [minBoards, setMinBoards] = useState("0");
  const [minN10k, setMinN10k] = useState("0");
  const [sort, setSort] = useState("event");
  const [gapMinConnected, setGapMinConnected] = useState("0");
  const [gapMinRatio, setGapMinRatio] = useState("0");
  const [gapSort, setGapSort] = useState<GapSort>("ratio");
  const [tinyRows, setTinyRows] = useState<TinyGapRow[]>([]);
  const [tinySummary, setTinySummary] = useState<TinyGapSummary | null>(null);
  const [tinyBand, setTinyBand] = useState("all");
  const [tinyMinConnected, setTinyMinConnected] = useState("0");
  const [tinyMinRatio, setTinyMinRatio] = useState("0");
  const [tinyCross, setTinyCross] = useState("any");
  const [tinyMinCos, setTinyMinCos] = useState("0");
  const [tinyMinDirs, setTinyMinDirs] = useState("0");
  const [tinySort, setTinySort] = useState<TinySort>("mcap");
  const [tinyOpen, setTinyOpen] = useState<string | null>(null);
  const [tinyDetail, setTinyDetail] = useState<TinyGapDetail | null>(null);
  const [tinyTab, setTinyTab] = useState<
    "overview" | "connections" | "directors" | "groups"
  >("overview");
  const [tinyEdgeSort, setTinyEdgeSort] = useState<"ratio" | "mcap" | "date">(
    "ratio",
  );
  const [newPane, setNewPane] = useState<NewPane>("connections");
  const [anomaly, setAnomaly] = useState<AnomalyKind>("gap");
  const [drillTicker, setDrillTicker] = useState<string | null>(null);
  const [profileRows, setProfileRows] = useState<NewConnRow[]>([]);
  const [maxTarget, setMaxTarget] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const capsKey = caps ? caps.join(",") : "";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      view: VIEW_BY_MODE[mode],
      page: String(page),
      pageSize: "50",
    });
    if (q.trim()) params.set("q", q.trim());
    if (mode === "connectivity" && capsKey) params.set("caps", capsKey);
    if (mode === "discovery") {
      params.set("agg", "companies");
      params.set("mcap", discMcap);
      params.set("signal", discSignal);
    }
    if (mode === "directors") {
      params.set("minBoards", hubMinBoards);
      params.set("minGroups", hubMinGroups);
      params.set("minSpread", hubMinSpread);
      params.set("cross", hubCross);
      params.set("sort", hubSort);
    }
    if (mode === "xgroup") {
      params.set("pane", xgPane);
      if (xgGroup) params.set("group", xgGroup);
      params.set("minMcap", xgMinMcap);
      params.set("minXg", xgMinCos);
    }
    if (mode === "clusters") {
      params.set("minCompanies", clusterMinCos);
      params.set("minDirectors", clusterMinDirs);
      params.set("minGroups", clusterMinGroups);
      params.set("minConnections", clusterMinConn);
      params.set("cross", clusterCross);
      params.set("minLargest", clusterMinMcap);
      if (clusterMulti === "yes") params.set("multiGroups", "1");
      if (clusterQCompany.trim()) params.set("qCompany", clusterQCompany.trim());
      if (clusterQTicker.trim()) params.set("qTicker", clusterQTicker.trim());
      if (clusterQDirector.trim()) params.set("qDirector", clusterQDirector.trim());
      if (clusterQGroup.trim()) params.set("qGroup", clusterQGroup.trim());
    }
    if (mode === "gmap") {
      params.set("priority", gmapPriority);
      params.set("kind", gmapKind);
    }
    if (mode === "tiny") {
      params.set("days", days);
      params.set("band", tinyBand);
      params.set("minConnected", tinyMinConnected);
      params.set("minRatio", tinyMinRatio);
      params.set("cross", tinyCross);
      params.set("minCos", tinyMinCos);
      params.set("minDirs", tinyMinDirs);
      params.set("sort", tinySort);
    }
    if (mode === "new" || mode === "gap") {
      params.set("days", days);
      params.set("connection", mode === "gap" ? "any" : connection);
      params.set("minConnected", mode === "gap" ? gapMinConnected : minConnected);
      params.set("minRatio", mode === "gap" ? gapMinRatio : minRatio);
      params.set("maxTarget", maxTargetFilter);
      params.set("minBoards", mode === "gap" ? "0" : minBoards);
      params.set("sort", mode === "gap" ? gapSort : sort);
      if (mode === "gap") {
        params.set("agg", "gap");
        params.set("minConnected", gapMinConnected);
        params.set("minRatio", gapMinRatio);
      } else if (newPane === "anomalies" && anomaly === "multi") {
        params.set("agg", "targets");
        params.set("minN10k", minN10k);
      } else if (newPane === "connections") {
        params.set("former", "1");
      }
    }
    void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as {
          rows?: unknown[];
          targets?: NewConnTarget[];
          total?: number;
          pages?: number;
          caps?: string[];
          bands?: CapBand[];
          max_target_mcap?: number | null;
          summary?: NewConnSummary;
          hubSummary?: DirectorHubSummary;
          companies?: DiscoveryRow[];
          discSummary?: DiscoverySummary;
        };
      })
      .then((json) => {
        if (cancelled) return;
        const rows = Array.isArray(json.rows) ? json.rows : [];
        if (mode === "pairs") setPairs(rows as PairRow[]);
        else if (mode === "directors") {
          setHubs(rows as DirectorHubRow[]);
          setHubSummary(
            (json as { summary?: DirectorHubSummary }).summary ?? null,
          );
        } else if (mode === "xgroup") {
          const xg = json as {
            summary?: XgSummary;
            pairs?: XgPairRow[];
            companies?: XgCompanyRow[];
            directors?: XgDirectorRow[];
            groups?: XgOption[];
          };
          setXgSummary(xg.summary ?? null);
          setXgPairs(Array.isArray(xg.pairs) ? xg.pairs : []);
          setXgCompanies(Array.isArray(xg.companies) ? xg.companies : []);
          setXgDirectors(Array.isArray(xg.directors) ? xg.directors : []);
          setXgGroups(Array.isArray(xg.groups) ? xg.groups : []);
        } else if (mode === "clusters") {
          setClusterRows(rows as ClusterRow[]);
          setClusterSummary(
            (json as { summary?: ClusterSummary }).summary ?? null,
          );
        } else if (mode === "gmap") {
          const g = json as {
            summary?: GmapSummary;
            merges?: GmapMerge[];
            groups?: Array<{
              group_key: string;
              group_name: string;
              companies: number;
            }>;
          };
          setGmapRows(rows as GmapRow[]);
          setGmapSummary(g.summary ?? null);
          setGmapMerges(Array.isArray(g.merges) ? g.merges : []);
          setGmapGroups(Array.isArray(g.groups) ? g.groups : []);
        }
        else if (mode === "discovery") {
          const disc = json as {
            companies?: DiscoveryRow[];
            summary?: DiscoverySummary;
          };
          setDiscovery(
            Array.isArray(disc.companies) ? disc.companies : (rows as DiscoveryRow[]),
          );
          setDiscSummary(disc.summary ?? null);
          setMaxTarget(json.max_target_mcap ?? null);
        } else if (mode === "new") {
          setNews(rows as NewConnRow[]);
          setTargets(Array.isArray(json.targets) ? json.targets : []);
          setSummary(json.summary ?? null);
          setMaxTarget(json.max_target_mcap ?? null);
        } else if (mode === "gap") {
          setNews([]);
          setTargets(Array.isArray(json.targets) ? json.targets : []);
          setSummary(json.summary ?? null);
          setMaxTarget(json.max_target_mcap ?? null);
        } else if (mode === "tiny") {
          setTinyRows(rows as TinyGapRow[]);
          setTinySummary(
            (json as { summary?: TinyGapSummary }).summary ?? null,
          );
        } else {
          setCompanies(rows as ConnectivityRow[]);
          if (json.bands) setBands(json.bands);
          if (!capsKey && json.caps) setCaps(json.caps);
        }
        setTotal(json.total ?? 0);
        setPages(json.pages ?? 1);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPairs([]);
        setHubs([]);
        setHubSummary(null);
        setHubSeats([]);
        setXgPairs([]);
        setXgCompanies([]);
        setXgDirectors([]);
        setXgSummary(null);
        setClusterRows([]);
        setClusterSummary(null);
        setTinyRows([]);
        setTinySummary(null);
        setGmapRows([]);
        setGmapSummary(null);
        setCompanies([]);
        setDiscovery([]);
        setDiscSummary(null);
        setNews([]);
        setTargets([]);
        setSummary(null);
        setProfileRows([]);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    mode,
    q,
    page,
    capsKey,
    discMcap,
    discSignal,
    days,
    connection,
    minConnected,
    minRatio,
    maxTargetFilter,
    minBoards,
    minN10k,
    sort,
    gapMinConnected,
    gapMinRatio,
    gapSort,
    tinyBand,
    tinyMinConnected,
    tinyMinRatio,
    tinyCross,
    tinyMinCos,
    tinyMinDirs,
    tinySort,
    hubMinBoards,
    hubMinGroups,
    hubMinSpread,
    hubCross,
    hubSort,
    xgPane,
    xgGroup,
    xgMinMcap,
    xgMinCos,
    clusterMinCos,
    clusterMinDirs,
    clusterMinGroups,
    clusterMinConn,
    clusterMulti,
    clusterQCompany,
    clusterQTicker,
    clusterQDirector,
    clusterQGroup,
    clusterCross,
    clusterMinMcap,
    gmapPriority,
    gmapKind,
    gmapTick,
    newPane,
    anomaly,
  ]);

  useEffect(() => {
    if (mode !== "gap" || !drillTicker) {
      setProfileRows([]);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      view: "network-new-connections",
      page: "1",
      pageSize: "200",
      days,
      connection: "any",
      minConnected: "0",
      minRatio: "0",
      maxTarget: maxTargetFilter,
      minBoards: "0",
      sort: "ratio",
      targetTicker: drillTicker,
    });
    void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { rows?: NewConnRow[] };
      })
      .then((json) => {
        if (cancelled) return;
        setProfileRows(Array.isArray(json.rows) ? json.rows : []);
      })
      .catch(() => {
        if (!cancelled) setProfileRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, drillTicker, days, maxTargetFilter]);

  useEffect(() => {
    if (mode !== "directors" || !hubPerson) {
      setHubSeats([]);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      view: "director-hub-seats",
      personId: hubPerson,
    });
    void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { rows?: DirectorHubSeat[] };
      })
      .then((json) => {
        if (!cancelled) setHubSeats(Array.isArray(json.rows) ? json.rows : []);
      })
      .catch(() => {
        if (!cancelled) setHubSeats([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, hubPerson]);

  useEffect(() => {
    if (mode !== "xgroup" || !xgDrill) {
      setXgEdges([]);
      return;
    }
    const [groupA, groupB] = xgDrill.split("|");
    if (!groupA || !groupB) return;
    let cancelled = false;
    const params = new URLSearchParams({
      view: "cross-group-edges",
      groupA,
      groupB,
    });
    void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { rows?: XgEdgeRow[] };
      })
      .then((json) => {
        if (!cancelled) setXgEdges(Array.isArray(json.rows) ? json.rows : []);
      })
      .catch(() => {
        if (!cancelled) setXgEdges([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, xgDrill]);

  useEffect(() => {
    if (mode !== "clusters" || !clusterOpen) {
      setClusterDetail(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      view: "network-cluster-detail",
      cluster: clusterOpen,
    });
    void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ClusterDetail;
      })
      .then((json) => {
        if (!cancelled) setClusterDetail(json);
      })
      .catch(() => {
        if (!cancelled) setClusterDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, clusterOpen]);

  useEffect(() => {
    if (mode !== "tiny" || !tinyOpen) {
      setTinyDetail(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      view: "tiny-capital-gap-detail",
      ticker: tinyOpen,
      days,
    });
    void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as TinyGapDetail;
      })
      .then((json) => {
        if (!cancelled) setTinyDetail(json);
      })
      .catch(() => {
        if (!cancelled) setTinyDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, tinyOpen, days]);

  useEffect(() => {
    if (mode !== "clusters" || !clusterPair) {
      setClusterShared(null);
      return;
    }
    const [a, b] = clusterPair.split("|");
    if (!a || !b) return;
    let cancelled = false;
    const params = new URLSearchParams({
      view: "network-cluster-shared",
      a,
      b,
    });
    void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ClusterShared;
      })
      .then((json) => {
        if (!cancelled) setClusterShared(json);
      })
      .catch(() => {
        if (!cancelled) setClusterShared(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, clusterPair]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("group-mapping-review-status");
      if (raw) setGmapStatus(JSON.parse(raw) as Record<string, string>);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (mode !== "gmap" || !gmapOpen) {
      setGmapCompany(null);
      setGmapGroup(null);
      setGmapPreview(null);
      return;
    }
    let cancelled = false;
    if (gmapOpen.ticker) {
      const params = new URLSearchParams({
        view: "group-mapping-company",
        ticker: gmapOpen.ticker,
      });
      void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as GmapCompanyDetail;
        })
        .then((json) => {
          if (!cancelled) setGmapCompany(json);
        })
        .catch(() => {
          if (!cancelled) setGmapCompany(null);
        });
    }
    if (gmapOpen.current_group_key && gmapOpen.kind !== "multi_group") {
      const params = new URLSearchParams({
        view: "group-mapping-group",
        group: gmapOpen.current_group_key,
      });
      void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as GmapGroupDetail;
        })
        .then((json) => {
          if (!cancelled) setGmapGroup(json);
        })
        .catch(() => {
          if (!cancelled) setGmapGroup(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [mode, gmapOpen]);

  const setReviewStatus = (id: string, status: string) => {
    setGmapStatus((prev) => {
      const next = { ...prev, [id]: status };
      try {
        localStorage.setItem("group-mapping-review-status", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const runPreview = (action: {
    action: "remove" | "reassign";
    ticker: string;
    group_key: string;
    new_group_key?: string;
    expected_group_name?: string;
  }) => {
    setGmapAction(action);
    setGmapWrite(null);
    const params = new URLSearchParams({
      view: "group-mapping-preview",
      action: action.action,
      ticker: action.ticker,
      group_key: action.group_key,
    });
    if (action.new_group_key) params.set("new_group_key", action.new_group_key);
    void fetch(`/api/governance-map?${params}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as GmapPreview;
      })
      .then(setGmapPreview)
      .catch(() => setGmapPreview(null));
  };

  const applyNewPane = (pane: NewPane) => {
    if (pane === newPane) return;
    setNewPane(pane);
    setPage(1);
    if (pane === "connections") {
      setDays("180");
      setConnection("any");
      setMinConnected("0");
      setMinRatio("0");
      setMaxTargetFilter("5000");
      setMinBoards("0");
      setMinN10k("0");
      setSort("event");
    } else {
      applyAnomalyKind(anomaly);
    }
  };

  const applyAnomalyKind = (kind: AnomalyKind) => {
    setAnomaly(kind);
    setPage(1);
    setMinN10k(kind === "multi" ? "2" : "0");
    if (kind === "gap") {
      setMinRatio((v) => (v === "0" ? "25" : v));
      setSort("ratio");
    } else if (kind === "cross") {
      setConnection("cross_group");
      setSort("ratio");
    } else if (kind === "boards") {
      setMinBoards((v) => (v === "0" ? "3" : v));
      setSort("boards");
    } else if (kind === "large") {
      setMinConnected((v) => (v === "0" ? "10000" : v));
      setSort("event");
    } else {
      setSort("event");
    }
  };

  const toggleCap = (code: string) => {
    const cur = caps ?? [];
    const next = cur.includes(code)
      ? cur.filter((c) => c !== code)
      : bands.map((b) => b.code).filter((c) => c === code || cur.includes(c));
    if (!next.length) return;
    setCaps(next);
    setPage(1);
  };

  const setGapCol = (col: GapSort) => {
    setGapSort(col);
    setPage(1);
  };

  const setHubCol = (col: HubSort) => {
    setHubSort(col);
    setPage(1);
  };

  const tvHref = (ticker: string) =>
    chartUrl?.(ticker) || tradingviewUrl(ticker);

  const tvBadge = (ticker: string) => (
    <a
      className="net-tv"
      href={tvHref(ticker)}
      target="_blank"
      rel="noreferrer"
      title={`${ticker} — TradingView`}
    >
      TV
    </a>
  );

  const targetCell = (ticker: string, name: string | null) => (
    <td className="net-company">
      {onTargetTicker ? (
        <>
          <button
            type="button"
            title={`${ticker} — board graph`}
            onClick={() => onTargetTicker(ticker)}
          >
            {ticker}
          </button>
          {tvBadge(ticker)}
        </>
      ) : (
        <a
          href={tvHref(ticker)}
          target="_blank"
          rel="noreferrer"
          title={`${ticker} — TradingView`}
        >
          {ticker}
        </a>
      )}
      {name ? <span>{name}</span> : null}
    </td>
  );

  const companyCell = (ticker: string, name: string | null) => {
    const href = tvHref(ticker);
    const title = `${ticker} — TradingView`;
    return (
      <td className="net-company">
        <a href={href} target="_blank" rel="noreferrer" title={title}>
          {ticker}
        </a>
        {name ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            title={title}
            className="net-company-name"
          >
            {name}
          </a>
        ) : null}
      </td>
    );
  };

  return (
    <div className="company-network">
      <div className="company-network-bar">
        <input
          value={q}
          placeholder="Director, ticker or company…"
          onChange={(e) => {
            setPage(1);
            setQ(e.target.value);
          }}
        />
        <span className="table-meta">
          {loading
            ? "Loading…"
            : `${total.toLocaleString("en-IN")} ${NOUN_BY_MODE[mode]}`}
        </span>
      </div>
      {mode === "connectivity" ? (
        <>
          <div className="company-network-caps">
            {bands.map((b) => (
              <button
                key={b.code}
                type="button"
                className={caps?.includes(b.code) ? "on" : ""}
                aria-pressed={caps?.includes(b.code) ?? false}
                onClick={() => toggleCap(b.code)}
              >
                {b.label}
              </button>
            ))}
          </div>
          <p className="table-meta">
            Connected directors also sit on at least one other listed board,
            including boards in the same business group. More connectivity
            marks a company for network investigation, not a better investment.
          </p>
        </>
      ) : null}
      {mode === "discovery" ? (
        <>
          <h2 className="gov-disc-title">Governance Discovery</h2>
          <p className="table-meta">
            Small companies with unusual governance-network connections.
          </p>
          <div className="company-network-filters">
            <label>
              Market Cap
              <select
                value={discMcap}
                onChange={(e) => {
                  setPage(1);
                  setDiscMcap(e.target.value);
                }}
              >
                <option value="all">All</option>
                <option value="lt100">&lt; ₹100 Cr</option>
                <option value="b100_500">₹100–500 Cr</option>
                <option value="b500_1000">₹500–1,000 Cr</option>
                <option value="b1000_5000">₹1,000–5,000 Cr</option>
                <option value="gte5000">₹5,000+ Cr</option>
              </select>
            </label>
            <label>
              Governance Signal
              <select
                value={discSignal}
                onChange={(e) => {
                  setPage(1);
                  setDiscSignal(e.target.value);
                }}
              >
                <option value="all">All</option>
                <option value="boards3">3+ board director</option>
                <option value="c5k">Connected to ₹5,000Cr+ company</option>
                <option value="c10k">Connected to ₹10,000Cr+ company</option>
                <option value="xgroup">Cross-group connection</option>
                <option value="cos2">2+ connected companies</option>
                <option value="dirs2">2+ connecting directors</option>
              </select>
            </label>
            <label className="gov-disc-search">
              Search
              <input
                value={q}
                placeholder="Search company or ticker..."
                onChange={(e) => {
                  setPage(1);
                  setQ(e.target.value);
                }}
              />
            </label>
          </div>
          {discSummary ? (
            <div className="company-network-summary">
              <span>
                <strong>{discSummary.companies.toLocaleString("en-IN")}</strong>{" "}
                Companies
              </span>
              <span>
                <strong>{discSummary.boards_3.toLocaleString("en-IN")}</strong> 3+
                Board Directors
              </span>
              <span>
                <strong>
                  {discSummary.connected_5k.toLocaleString("en-IN")}
                </strong>{" "}
                ₹5,000Cr+ Connections
              </span>
              <span>
                <strong>
                  {discSummary.connected_10k.toLocaleString("en-IN")}
                </strong>{" "}
                ₹10,000Cr+ Connections
              </span>
              <span>
                <strong>
                  {discSummary.cross_group.toLocaleString("en-IN")}
                </strong>{" "}
                Cross-Group
              </span>
            </div>
          ) : null}
        </>
      ) : null}
      {mode === "directors" ? (
        <>
          <p className="table-meta">
            Director Hubs uses current governance board coverage. It measures
            observed listed-company board seats; it is not a measure of director
            quality or investment quality.
          </p>
          <p className="table-meta">
            Cross Group counts distinct current boards that have a group
            assignment while the director also sits on at least one other
            grouped board in a different group. Unclassified boards are omitted.
            New Connections uses the canonical latest-join edges, not every
            current pair.
          </p>
          <div className="company-network-filters">
            <label>
              Minimum Boards
              <select
                value={hubMinBoards}
                onChange={(e) => {
                  setPage(1);
                  setHubMinBoards(e.target.value);
                }}
              >
                <option value="2">2+</option>
                <option value="3">3+</option>
                <option value="4">4+</option>
                <option value="5">5+</option>
                <option value="6">6+</option>
                <option value="7">7+</option>
                <option value="10">10+</option>
              </select>
            </label>
            <label>
              Minimum Groups
              <select
                value={hubMinGroups}
                onChange={(e) => {
                  setPage(1);
                  setHubMinGroups(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="2">2+</option>
                <option value="3">3+</option>
                <option value="4">4+</option>
                <option value="5">5+</option>
              </select>
            </label>
            <label>
              Minimum MCap Spread
              <select
                value={hubMinSpread}
                onChange={(e) => {
                  setPage(1);
                  setHubMinSpread(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="5">5x+</option>
                <option value="10">10x+</option>
                <option value="25">25x+</option>
                <option value="50">50x+</option>
                <option value="100">100x+</option>
              </select>
            </label>
            <label>
              Cross Group
              <select
                value={hubCross}
                onChange={(e) => {
                  setPage(1);
                  setHubCross(e.target.value);
                }}
              >
                <option value="any">All</option>
                <option value="yes">Has cross-group</option>
                <option value="no">No cross-group</option>
              </select>
            </label>
          </div>
          {hubSummary ? (
            <div className="company-network-summary">
              <span>
                <strong>{hubSummary.directors.toLocaleString("en-IN")}</strong>{" "}
                directors
              </span>
              <span>
                <strong>{hubSummary.boards_3.toLocaleString("en-IN")}</strong> 3+
                board directors
              </span>
              <span>
                <strong>{hubSummary.boards_5.toLocaleString("en-IN")}</strong> 5+
                board directors
              </span>
              <span>
                <strong>{hubSummary.boards_7.toLocaleString("en-IN")}</strong> 7+
                board directors
              </span>
              <span>
                <strong>{hubSummary.groups_2.toLocaleString("en-IN")}</strong>{" "}
                directors with 2+ groups
              </span>
              <span>
                <strong>{hubSummary.cross_group.toLocaleString("en-IN")}</strong>{" "}
                directors with cross-group boards
              </span>
            </div>
          ) : null}
        </>
      ) : null}
      {mode === "xgroup" ? (
        <>
          <p className="table-meta">
            Cross-Group Network shows current directors who sit on companies
            belonging to different corporate groups. Companies without group
            classification are excluded from cross-group relationships.
          </p>
          <p className="table-meta">
            Relationships are based on current board seats, not historical
            appointments or event detection dates. Two companies are linked
            only when they share no group_key.
          </p>
          {xgSummary ? (
            <div className="company-network-summary">
              <span>
                <strong>
                  {xgSummary.relationships.toLocaleString("en-IN")}
                </strong>{" "}
                cross-group relationships
              </span>
              <span>
                <strong>{xgSummary.directors.toLocaleString("en-IN")}</strong>{" "}
                directors
              </span>
              <span>
                <strong>{xgSummary.companies.toLocaleString("en-IN")}</strong>{" "}
                companies
              </span>
              <span>
                <strong>{xgSummary.group_pairs.toLocaleString("en-IN")}</strong>{" "}
                group pairs
              </span>
              <span>
                <strong>{xgSummary.groups.toLocaleString("en-IN")}</strong>{" "}
                groups
              </span>
            </div>
          ) : null}
          <div className="fam-dash-tabs" role="tablist" aria-label="Cross-group views">
            {(
              [
                ["groups", "Group Connections"],
                ["companies", "Company Connections"],
                ["directors", "Directors"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className={xgPane === id ? "tab on" : "tab"}
                aria-selected={xgPane === id}
                onClick={() => {
                  setXgPane(id);
                  setPage(1);
                  setXgDrill(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="company-network-filters">
            <label>
              Group
              <select
                value={xgGroup}
                onChange={(e) => {
                  setPage(1);
                  setXgGroup(e.target.value);
                }}
              >
                <option value="">All</option>
                {xgGroups.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.name || g.key}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Minimum MCap
              <select
                value={xgMinMcap}
                onChange={(e) => {
                  setPage(1);
                  setXgMinMcap(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="100">₹100 Cr</option>
                <option value="500">₹500 Cr</option>
                <option value="1000">₹1,000 Cr</option>
                <option value="5000">₹5,000 Cr</option>
                <option value="10000">₹10,000 Cr</option>
                <option value="25000">₹25,000 Cr</option>
                <option value="50000">₹50,000 Cr</option>
              </select>
            </label>
            <label>
              Minimum cross-group companies
              <select
                value={xgMinCos}
                onChange={(e) => {
                  setPage(1);
                  setXgMinCos(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="5">5</option>
              </select>
            </label>
          </div>
        </>
      ) : null}
      {mode === "clusters" ? (
        <>
          <p className="table-meta">
            Network Clusters are connected components of the current
            board-sharing graph. Two companies belong to the same cluster when
            they share a current director, or are linked through a chain of
            such shares. Company groups are metadata on those companies; they
            do not create cluster membership.
          </p>
          {clusterSummary ? (
            <div className="company-network-summary">
              <span>
                <strong>{clusterSummary.clusters.toLocaleString("en-IN")}</strong>{" "}
                Network Clusters
              </span>
              <span>
                <strong>
                  {clusterSummary.companies.toLocaleString("en-IN")}
                </strong>{" "}
                Connected Companies
              </span>
              <span>
                <strong>
                  {clusterSummary.isolated_companies.toLocaleString("en-IN")}
                </strong>{" "}
                Isolated Companies
              </span>
              <span>
                <strong>
                  {clusterSummary.governance_connections.toLocaleString(
                    "en-IN",
                  )}
                </strong>{" "}
                Governance Connections
              </span>
              <span>
                <strong>
                  {clusterSummary.directors.toLocaleString("en-IN")}
                </strong>{" "}
                Directors
              </span>
            </div>
          ) : null}
          <div className="company-network-filters">
            <label>
              Search Company
              <input
                value={clusterQCompany}
                onChange={(e) => {
                  setPage(1);
                  setClusterQCompany(e.target.value);
                }}
              />
            </label>
            <label>
              Search Ticker
              <input
                value={clusterQTicker}
                onChange={(e) => {
                  setPage(1);
                  setClusterQTicker(e.target.value);
                }}
              />
            </label>
            <label>
              Search Director
              <input
                value={clusterQDirector}
                onChange={(e) => {
                  setPage(1);
                  setClusterQDirector(e.target.value);
                }}
              />
            </label>
            <label>
              Search Group
              <input
                value={clusterQGroup}
                onChange={(e) => {
                  setPage(1);
                  setClusterQGroup(e.target.value);
                }}
              />
            </label>
            <label>
              Has Cross-Group Connection
              <select
                value={clusterCross}
                onChange={(e) => {
                  setPage(1);
                  setClusterCross(e.target.value);
                }}
              >
                <option value="any">All</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label>
              Has Multiple Groups
              <select
                value={clusterMulti}
                onChange={(e) => {
                  setPage(1);
                  setClusterMulti(e.target.value);
                }}
              >
                <option value="any">All</option>
                <option value="yes">Yes</option>
              </select>
            </label>
            <label>
              Minimum Companies
              <select
                value={clusterMinCos}
                onChange={(e) => {
                  setPage(1);
                  setClusterMinCos(e.target.value);
                }}
              >
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="5">5</option>
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
              </select>
            </label>
            <label>
              Minimum Directors
              <select
                value={clusterMinDirs}
                onChange={(e) => {
                  setPage(1);
                  setClusterMinDirs(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="5">5</option>
                <option value="10">10</option>
              </select>
            </label>
            <label>
              Minimum Connections
              <select
                value={clusterMinConn}
                onChange={(e) => {
                  setPage(1);
                  setClusterMinConn(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="5">5</option>
                <option value="10">10</option>
              </select>
            </label>
            <label>
              Minimum Groups
              <select
                value={clusterMinGroups}
                onChange={(e) => {
                  setPage(1);
                  setClusterMinGroups(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
              </select>
            </label>
            <label>
              Minimum Largest MCap
              <select
                value={clusterMinMcap}
                onChange={(e) => {
                  setPage(1);
                  setClusterMinMcap(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="1000">₹1,000 Cr</option>
                <option value="5000">₹5,000 Cr</option>
                <option value="10000">₹10,000 Cr</option>
                <option value="25000">₹25,000 Cr</option>
                <option value="50000">₹50,000 Cr</option>
              </select>
            </label>
          </div>
        </>
      ) : null}
      {mode === "gmap" ? (
        <>
          <p className="table-meta">
            Group Mapping Review inspects company → corporate/business group
            assignments. Audit items are review candidates, not proven errors.
            The taxonomy is not an industry classification.
          </p>
          {gmapSummary ? (
            <div className="company-network-summary">
              <span>
                <strong>{gmapSummary.groups.toLocaleString("en-IN")}</strong>{" "}
                groups
              </span>
              <span>
                <strong>
                  {gmapSummary.companies.toLocaleString("en-IN")}
                </strong>{" "}
                companies
              </span>
              <span>
                <strong>
                  {gmapSummary.multi_group_companies.toLocaleString("en-IN")}
                </strong>{" "}
                multi-group companies
              </span>
              <span>
                <strong>
                  {gmapSummary.review_candidates.toLocaleString("en-IN")}
                </strong>{" "}
                review candidates
              </span>
              <span>
                <strong>
                  {gmapSummary.cross_group_pairs.toLocaleString("en-IN")}
                </strong>{" "}
                current cross-group pairs
              </span>
            </div>
          ) : null}
          <div className="fam-dash-tabs" role="tablist" aria-label="Group mapping">
            {(
              [
                ["queue", "Review Queue"],
                ["merges", "Possible Group Merges"],
                ["groups", "Groups"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className={gmapPane === id ? "tab on" : "tab"}
                aria-selected={gmapPane === id}
                onClick={() => {
                  setGmapPane(id);
                  setGmapOpen(null);
                  setPage(1);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {gmapPane === "queue" ? (
            <div className="company-network-filters">
              <label>
                Priority
                <select
                  value={gmapPriority}
                  onChange={(e) => {
                    setPage(1);
                    setGmapPriority(e.target.value);
                  }}
                >
                  <option value="all">All</option>
                  <option value="HIGH">High</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="LOW">Low</option>
                </select>
              </label>
              <label>
                Status
                <select
                  value={gmapStatusFilter}
                  onChange={(e) => {
                    setPage(1);
                    setGmapStatusFilter(e.target.value);
                  }}
                >
                  <option value="all">All</option>
                  <option value="unreviewed">Unreviewed</option>
                  <option value="verified">Verified</option>
                  <option value="keep">Keep</option>
                  <option value="remove">Remove</option>
                  <option value="reassign">Reassign</option>
                  <option value="merge_candidate">Merge Candidate</option>
                  <option value="needs_verification">Needs Verification</option>
                </select>
              </label>
              <label>
                Type
                <select
                  value={gmapKind}
                  onChange={(e) => {
                    setPage(1);
                    setGmapKind(e.target.value);
                  }}
                >
                  <option value="all">All</option>
                  <option value="multi_group">Multi-Group</option>
                  <option value="generic_sector">Generic/Sector Candidate</option>
                  <option value="possible_duplicate">Possible Duplicate</option>
                  <option value="suspicious_assignment">
                    Suspicious Assignment
                  </option>
                </select>
              </label>
            </div>
          ) : null}
        </>
      ) : null}
      {mode === "gap" ? (
        <>
          <p className="table-meta">{GOVERNANCE_NETWORK_COVERAGE_NOTE}</p>
          <p className="table-meta">
            Company-level measurements on the same latest-join edges as New
            Connections. These are counts and ratios, not a network score.
            {maxTargetFilter !== "all"
              ? ` Target market cap < ₹${Number(maxTargetFilter).toLocaleString("en-IN")} Cr.`
              : ""}
          </p>
          <div className="company-network-filters">
            <label>
              Time
              <select
                value={days}
                onChange={(e) => {
                  setPage(1);
                  setDays(e.target.value);
                }}
              >
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="180">180 days</option>
                <option value="365">365 days</option>
                <option value="all">All</option>
              </select>
            </label>
            <label>
              Target MCap
              <select
                value={maxTargetFilter}
                onChange={(e) => {
                  setPage(1);
                  setMaxTargetFilter(e.target.value);
                }}
              >
                <option value="500">{"<₹500 Cr"}</option>
                <option value="1000">{"<₹1,000 Cr"}</option>
                <option value="2000">{"<₹2,000 Cr"}</option>
                <option value="5000">{"<₹5,000 Cr"}</option>
                <option value="all">All</option>
              </select>
            </label>
            <label>
              Minimum connected MCap
              <select
                value={gapMinConnected}
                onChange={(e) => {
                  setPage(1);
                  setGapMinConnected(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="1000">₹1,000 Cr+</option>
                <option value="5000">₹5,000 Cr+</option>
                <option value="10000">₹10,000 Cr+</option>
                <option value="25000">₹25,000 Cr+</option>
                <option value="50000">₹50,000 Cr+</option>
                <option value="100000">₹1,00,000 Cr+</option>
              </select>
            </label>
            <label>
              Minimum Max Ratio
              <select
                value={gapMinRatio}
                onChange={(e) => {
                  setPage(1);
                  setGapMinRatio(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="5">5x+</option>
                <option value="10">10x+</option>
                <option value="25">25x+</option>
                <option value="50">50x+</option>
                <option value="100">100x+</option>
              </select>
            </label>
          </div>
          {summary ? (
            <div className="company-network-summary">
              <span>
                <strong>{summary.unique_targets.toLocaleString("en-IN")}</strong>{" "}
                companies
              </span>
              <span>
                <strong>{summary.edges.toLocaleString("en-IN")}</strong>{" "}
                connections
              </span>
              <span>
                <strong>
                  {(summary.n_10k_connections ?? 0).toLocaleString("en-IN")}
                </strong>{" "}
                ≥₹10k Cr connections
              </span>
              <span>
                <strong>
                  {(summary.n_25k_connections ?? 0).toLocaleString("en-IN")}
                </strong>{" "}
                ≥₹25k Cr connections
              </span>
              <span>
                <strong>
                  {summary.mega_connections.toLocaleString("en-IN")}
                </strong>{" "}
                ≥₹50k Cr connections
              </span>
              <span>
                <strong>{summary.cross_group.toLocaleString("en-IN")}</strong>{" "}
                cross-group connections
              </span>
            </div>
          ) : null}
        </>
      ) : null}
      {mode === "tiny" ? (
        <>
          <p className="table-meta">{GOVERNANCE_NETWORK_COVERAGE_NOTE}</p>
          <p className="table-meta">
            Tiny Capital Gap is the canonical New Connections / Capital Gap
            universe (latest-join edges, current other seats, target mcap &gt; 0
            and &lt; ₹5,000 Cr) limited to targets below ₹1,000 Cr. Counts and
            ratios are measurements, not scores.
          </p>
          {tinySummary ? (
            <div className="company-network-summary">
              <span>
                <strong>{tinySummary.companies.toLocaleString("en-IN")}</strong>{" "}
                Tiny Companies
              </span>
              <span>
                <strong>
                  {tinySummary.band_lt100.toLocaleString("en-IN")}
                </strong>{" "}
                &lt; ₹100 Cr
              </span>
              <span>
                <strong>
                  {tinySummary.band_100_250.toLocaleString("en-IN")}
                </strong>{" "}
                ₹100–250 Cr
              </span>
              <span>
                <strong>
                  {tinySummary.band_250_500.toLocaleString("en-IN")}
                </strong>{" "}
                ₹250–500 Cr
              </span>
              <span>
                <strong>
                  {tinySummary.band_500_1000.toLocaleString("en-IN")}
                </strong>{" "}
                ₹500–1,000 Cr
              </span>
              <span>
                <strong>
                  {tinySummary.connected_10k.toLocaleString("en-IN")}
                </strong>{" "}
                Connected to ₹10k Cr+
              </span>
              <span>
                <strong>
                  {tinySummary.max_gap_50x.toLocaleString("en-IN")}
                </strong>{" "}
                Max Gap ≥50x
              </span>
              <span>
                <strong>
                  {tinySummary.cross_group.toLocaleString("en-IN")}
                </strong>{" "}
                Cross Group
              </span>
            </div>
          ) : null}
          <div className="company-network-filters">
            <label>
              Time
              <select
                value={days}
                onChange={(e) => {
                  setPage(1);
                  setDays(e.target.value);
                }}
              >
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="180">180 days</option>
                <option value="365">365 days</option>
                <option value="all">All</option>
              </select>
            </label>
            <label>
              MCap Band
              <select
                value={tinyBand}
                onChange={(e) => {
                  setPage(1);
                  setTinyBand(e.target.value);
                }}
              >
                <option value="all">All</option>
                <option value="lt100">&lt; ₹100 Cr</option>
                <option value="100_250">₹100–250 Cr</option>
                <option value="250_500">₹250–500 Cr</option>
                <option value="500_1000">₹500–1,000 Cr</option>
              </select>
            </label>
            <label>
              Connected MCap
              <select
                value={tinyMinConnected}
                onChange={(e) => {
                  setPage(1);
                  setTinyMinConnected(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="1000">≥ ₹1,000 Cr</option>
                <option value="5000">≥ ₹5,000 Cr</option>
                <option value="10000">≥ ₹10,000 Cr</option>
                <option value="25000">≥ ₹25,000 Cr</option>
                <option value="50000">≥ ₹50,000 Cr</option>
                <option value="100000">≥ ₹1,00,000 Cr</option>
              </select>
            </label>
            <label>
              Max MCap Gap
              <select
                value={tinyMinRatio}
                onChange={(e) => {
                  setPage(1);
                  setTinyMinRatio(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="5">≥ 5x</option>
                <option value="10">≥ 10x</option>
                <option value="25">≥ 25x</option>
                <option value="50">≥ 50x</option>
                <option value="100">≥ 100x</option>
                <option value="250">≥ 250x</option>
                <option value="500">≥ 500x</option>
              </select>
            </label>
            <label>
              Cross Group
              <select
                value={tinyCross}
                onChange={(e) => {
                  setPage(1);
                  setTinyCross(e.target.value);
                }}
              >
                <option value="any">Any</option>
                <option value="yes">Cross Group Only</option>
                <option value="no">No Cross Group</option>
              </select>
            </label>
            <label>
              Connected Companies
              <select
                value={tinyMinCos}
                onChange={(e) => {
                  setPage(1);
                  setTinyMinCos(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="2">2+</option>
                <option value="3">3+</option>
                <option value="4">4+</option>
              </select>
            </label>
            <label>
              Directors
              <select
                value={tinyMinDirs}
                onChange={(e) => {
                  setPage(1);
                  setTinyMinDirs(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="2">2+</option>
                <option value="3">3+</option>
              </select>
            </label>
          </div>
        </>
      ) : null}
      {mode === "new" ? (
        <>
          <div className="fam-dash-tabs" role="tablist" aria-label="New connections">
            <button
              type="button"
              role="tab"
              className={newPane === "connections" ? "tab on" : "tab"}
              aria-selected={newPane === "connections"}
              onClick={() => applyNewPane("connections")}
            >
              Connections
            </button>
            <button
              type="button"
              role="tab"
              className={newPane === "anomalies" ? "tab on" : "tab"}
              aria-selected={newPane === "anomalies"}
              onClick={() => applyNewPane("anomalies")}
            >
              Anomalies
            </button>
          </div>
          <p className="table-meta">
            Same joined-event edges as Connections (latest join still seated,
            other current boards, target market cap &gt; 0
            {maxTargetFilter !== "all" ? ` and &lt; ₹${Number(maxTargetFilter).toLocaleString("en-IN")} Cr` : ""}
            ). Counts describe the network, not investment quality. Target opens
            that stock’s board graph; connected names open TradingView.
          </p>
          {newPane === "anomalies" ? (
            <div className="company-network-caps" role="tablist" aria-label="Anomaly">
              {(
                [
                  ["gap", "Capital gap"],
                  ["multi", "Multiple large"],
                  ["cross", "Cross-group"],
                  ["boards", "Multi-board"],
                  ["large", "New large-cap"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={anomaly === id ? "on" : ""}
                  aria-pressed={anomaly === id}
                  onClick={() => applyAnomalyKind(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="company-network-filters">
            <label>
              Time
              <select
                value={days}
                onChange={(e) => {
                  setPage(1);
                  setDays(e.target.value);
                }}
              >
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="180">180 days</option>
                <option value="365">1 year</option>
                <option value="all">All</option>
              </select>
            </label>
            <label>
              Target MCap
              <select
                value={maxTargetFilter}
                onChange={(e) => {
                  setPage(1);
                  setMaxTargetFilter(e.target.value);
                }}
              >
                <option value="500">{"< ₹500 Cr"}</option>
                <option value="1000">{"< ₹1,000 Cr"}</option>
                <option value="2000">{"< ₹2,000 Cr"}</option>
                <option value="5000">{"< ₹5,000 Cr"}</option>
                <option value="all">All</option>
              </select>
            </label>
            <label>
              Connection
              <select
                value={connection}
                onChange={(e) => {
                  setPage(1);
                  setConnection(e.target.value);
                }}
              >
                <option value="any">All</option>
                <option value="same_group">Same group</option>
                <option value="cross_group">Cross group</option>
                <option value="unclassified">Unclassified</option>
              </select>
            </label>
            <label>
              Min connected MCap
              <select
                value={minConnected}
                onChange={(e) => {
                  setPage(1);
                  setMinConnected(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="1000">₹1,000 Cr</option>
                <option value="5000">₹5,000 Cr</option>
                <option value="10000">₹10,000 Cr</option>
                <option value="25000">₹25,000 Cr</option>
                <option value="50000">₹50,000 Cr</option>
              </select>
            </label>
            <label>
              Min ratio
              <select
                value={minRatio}
                onChange={(e) => {
                  setPage(1);
                  setMinRatio(e.target.value);
                }}
              >
                <option value="0">Any</option>
                <option value="10">10x</option>
                <option value="25">25x</option>
                <option value="50">50x</option>
                <option value="100">100x</option>
                <option value="250">250x</option>
                <option value="500">500x</option>
              </select>
            </label>
            {newPane === "anomalies" ? (
              <label>
                Min boards
                <select
                  value={minBoards}
                  onChange={(e) => {
                    setPage(1);
                    setMinBoards(e.target.value);
                  }}
                >
                  <option value="0">Any</option>
                  <option value="3">3+</option>
                  <option value="4">4+</option>
                  <option value="5">5+</option>
                </select>
              </label>
            ) : null}
            {newPane === "anomalies" && anomaly === "multi" ? (
              <label>
                ≥ ₹10k Cr companies
                <select
                  value={minN10k}
                  onChange={(e) => {
                    setPage(1);
                    setMinN10k(e.target.value);
                  }}
                >
                  <option value="2">2+</option>
                  <option value="3">3+</option>
                </select>
              </label>
            ) : null}
          </div>
          {summary ? (
            <div className="company-network-summary">
              <span>
                <strong>{summary.edges.toLocaleString("en-IN")}</strong> edges
              </span>
              <span>
                <strong>{summary.unique_targets.toLocaleString("en-IN")}</strong>{" "}
                unique targets
              </span>
              <span>
                <strong>
                  {summary.unique_directors.toLocaleString("en-IN")}
                </strong>{" "}
                unique directors
              </span>
              <span>
                <strong>{summary.cross_group.toLocaleString("en-IN")}</strong>{" "}
                cross-group edges
              </span>
              <span>
                <strong>
                  {summary.mega_connections.toLocaleString("en-IN")}
                </strong>{" "}
                connected companies ≥ ₹50k Cr
              </span>
            </div>
          ) : null}
        </>
      ) : null}
      {error ? <div className="table-meta">Could not load: {error}</div> : null}
      <div className="table-wrap">
        {mode === "connectivity" ? (
          <table className="company-network-table company-network-table--conn">
            <thead>
              <tr>
                <th>Company</th>
                <th>Market cap</th>
                <th>Total directors</th>
                <th>Connected directors</th>
                <th>Connected share</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((row) => (
                <tr key={row.ticker}>
                  {companyCell(row.ticker, row.name)}
                  <td>{fmtCr(row.market_cap_cr)}</td>
                  <td>{row.total_directors}</td>
                  <td>{row.externally_connected_directors}</td>
                  <td>{fmtShare(row.connected_share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : mode === "discovery" ? (
          <table className="company-network-table company-network-table--disc">
            <thead>
              <tr>
                <th>Company</th>
                <th>MCap</th>
                <th>Connected Companies</th>
                <th>Directors</th>
                <th>Largest Connected MCap</th>
                <th>Signals</th>
              </tr>
            </thead>
            <tbody>
              {discovery.map((row) => (
                <tr key={row.ticker}>
                  {companyCell(row.ticker, row.name)}
                  <td>{fmtCr(row.market_cap)}</td>
                  <td>{row.connected_companies}</td>
                  <td>{row.directors}</td>
                  <td>{fmtCr(row.largest_connected_mcap)}</td>
                  <td>
                    <div className="net-badges">
                      {discoveryBadges(row).map((b) => (
                        <span key={b} className="net-badge">
                          {b}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : mode === "gap" ? (
          <table className="company-network-table company-network-table--gap">
            <thead>
              <tr>
                <th>Company</th>
                <th>MCap</th>
                {(
                  [
                    ["connected", "Connected Companies"],
                    ["mcap", "Max Connected MCap"],
                    ["ratio", "Max Ratio"],
                    ["n10k", "≥₹10k Cr"],
                    ["n25k", "≥₹25k Cr"],
                    ["n50k", "≥₹50k Cr"],
                    ["cross", "Cross Group"],
                    ["multi", "Multi-board"],
                  ] as const
                ).map(([id, label]) => (
                  <th key={id}>
                    <button
                      type="button"
                      className={
                        gapSort === id ? "net-sort-btn on" : "net-sort-btn"
                      }
                      onClick={() => setGapCol(id)}
                    >
                      {label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {targets.map((row) => {
                const open = drillTicker === row.target_ticker;
                return (
                  <Fragment key={row.target_ticker}>
                    <tr>
                      <td className="net-company">
                        {onTargetTicker ? (
                          <button
                            type="button"
                            title={`${row.target_ticker} — board graph`}
                            onClick={() => onTargetTicker(row.target_ticker)}
                          >
                            {row.target_ticker}
                          </button>
                        ) : (
                          row.target_ticker
                        )}
                        {tvBadge(row.target_ticker)}
                        {row.target_company ? (
                          <span>{row.target_company}</span>
                        ) : null}
                      </td>
                      <td>{fmtCr(row.target_market_cap)}</td>
                      <td>
                        <button
                          type="button"
                          title="Underlying connections"
                          onClick={() =>
                            setDrillTicker(open ? null : row.target_ticker)
                          }
                        >
                          {row.connected_companies}
                        </button>
                      </td>
                      <td>{fmtCr(row.largest_connected_mcap)}</td>
                      <td className="net-ratio">
                        {fmtRatio(row.largest_ratio)}
                      </td>
                      <td>{row.n_10k}</td>
                      <td>{row.n_25k}</td>
                      <td>{row.n_50k}</td>
                      <td>{row.cross_group_count}</td>
                      <td>{row.multi_board_director_count}</td>
                    </tr>
                    {open ? (
                      <tr
                        key={`${row.target_ticker}|profile`}
                        className="net-gap-profile"
                      >
                        <td colSpan={10}>
                          <div className="net-gap-profile-inner">
                            <table className="company-network-table company-network-table--new">
                              <thead>
                                <tr>
                                  <th>Director</th>
                                  <th>Connected Company</th>
                                  <th>Connected MCap</th>
                                  <th>Ratio</th>
                                  <th>Connection Type</th>
                                  <th>Join Date</th>
                                </tr>
                              </thead>
                              <tbody>
                                {profileRows.map((edge) => (
                                  <tr
                                    key={`${edge.person_id}|${edge.connected_ticker}`}
                                  >
                                    <td>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          onPerson(
                                            edge.person_id,
                                            edge.director,
                                          )
                                        }
                                      >
                                        {edge.director}
                                      </button>
                                    </td>
                                    {companyCell(
                                      edge.connected_ticker,
                                      edge.connected_company,
                                    )}
                                    <td>
                                      {fmtCr(edge.connected_market_cap)}
                                    </td>
                                    <td className="net-ratio">
                                      {fmtRatio(edge.market_cap_ratio)}
                                    </td>
                                    <td>
                                      {connLabel(edge.connection_type)}
                                    </td>
                                    <td>
                                      {fmtEventDate(edge.event_date)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        ) : mode === "new" && newPane === "anomalies" && anomaly === "multi" ? (
          <table className="company-network-table company-network-table--new">
            <thead>
              <tr>
                <th>Target</th>
                <th>Target MCap</th>
                <th>Connected companies</th>
                <th>≥ ₹10k Cr</th>
                <th>≥ ₹25k Cr</th>
                <th>≥ ₹50k Cr</th>
                <th>Largest connected MCap</th>
                <th>Largest ratio</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((row) => (
                <tr key={row.target_ticker}>
                  <td className="net-company">
                    <button
                      type="button"
                      title="Show underlying connections"
                      onClick={() => {
                        setQ(row.target_ticker);
                        setAnomaly("gap");
                        setMinN10k("0");
                        setPage(1);
                      }}
                    >
                      {row.target_ticker}
                    </button>
                    {tvBadge(row.target_ticker)}
                    {row.target_company ? <span>{row.target_company}</span> : null}
                  </td>
                  <td>{fmtCr(row.target_market_cap)}</td>
                  <td>{row.connected_companies}</td>
                  <td>{row.n_10k}</td>
                  <td>{row.n_25k}</td>
                  <td>{row.n_50k}</td>
                  <td>{fmtCr(row.largest_connected_mcap)}</td>
                  <td className="net-ratio">{fmtRatio(row.largest_ratio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : mode === "new" && newPane === "connections" ? (
          <table className="company-network-table company-network-table--moves">
            <thead>
              <tr>
                <th>Director</th>
                <th>Existing company</th>
                <th>New company</th>
                <th>Existing MCap</th>
                <th>New MCap</th>
                <th>MCap ratio</th>
                <th>Join date</th>
                <th>Existing company join date</th>
                <th>Existing company resignation date</th>
                <th>Relationship type</th>
                <th>Same/Cross group</th>
              </tr>
            </thead>
            <tbody>
              {news.map((row) => (
                <tr
                  key={`${row.target_ticker}|${row.person_id}|${row.connected_ticker}|${row.connected_current ?? 1}`}
                >
                  <td>
                    <button
                      type="button"
                      onClick={() => onPerson(row.person_id, row.director)}
                    >
                      {row.director}
                    </button>
                  </td>
                  {companyCell(row.connected_ticker, row.connected_company)}
                  {targetCell(row.target_ticker, row.target_company)}
                  <td>{fmtCr(row.connected_market_cap)}</td>
                  <td>{fmtCr(row.target_market_cap)}</td>
                  <td className="net-ratio">{fmtRatio(row.market_cap_ratio)}</td>
                  <td>{fmtEventDate(row.event_date)}</td>
                  <td>
                    {row.connected_joined_at
                      ? fmtEventDate(row.connected_joined_at)
                      : "N/A"}
                  </td>
                  <td>
                    {row.connected_current === 0
                      ? row.connected_resigned_at
                        ? fmtEventDate(row.connected_resigned_at)
                        : "N/A"
                      : "Current"}
                  </td>
                  <td>
                    {row.target_designation || "N/A"}
                    <span>Existing: {row.connected_designation || "N/A"}</span>
                  </td>
                  <td>{connLabel(row.connection_type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : mode === "new" ? (
          <table className="company-network-table company-network-table--new">
            <thead>
              <tr>
                <th>Target</th>
                <th>Target MCap</th>
                <th>Director</th>
                {newPane === "anomalies" && anomaly === "boards" ? (
                  <th>Board count</th>
                ) : null}
                {newPane === "connections" || anomaly === "large" ? (
                  <th>Event date</th>
                ) : null}
                <th>Connected company</th>
                <th>Connected MCap</th>
                <th>Ratio</th>
                {newPane === "connections" ||
                anomaly === "gap" ||
                anomaly === "large" ? (
                  <th>Connection</th>
                ) : null}
                {newPane === "anomalies" ? <th>Flags</th> : null}
              </tr>
            </thead>
            <tbody>
              {news.map((row) => (
                <tr
                  key={`${row.target_ticker}|${row.person_id}|${row.connected_ticker}`}
                >
                  {targetCell(row.target_ticker, row.target_company)}
                  <td>{fmtCr(row.target_market_cap)}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => onPerson(row.person_id, row.director)}
                    >
                      {row.director}
                    </button>
                  </td>
                  {newPane === "anomalies" && anomaly === "boards" ? (
                    <td>{row.board_count ?? "N/A"}</td>
                  ) : null}
                  {newPane === "connections" || anomaly === "large" ? (
                    <td>{fmtEventDate(row.event_date)}</td>
                  ) : null}
                  {companyCell(row.connected_ticker, row.connected_company)}
                  <td>{fmtCr(row.connected_market_cap)}</td>
                  <td className="net-ratio">{fmtRatio(row.market_cap_ratio)}</td>
                  {newPane === "connections" ||
                  anomaly === "gap" ||
                  anomaly === "large" ? (
                    <td>{connLabel(row.connection_type)}</td>
                  ) : null}
                  {newPane === "anomalies" ? (
                    <td className="net-badges">
                      {anomalyBadges(row).map((b) => (
                        <span key={b} className="net-badge">
                          {b}
                        </span>
                      ))}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : mode === "tiny" ? (
          <table className="company-network-table company-network-table--gap">
            <thead>
              <tr>
                <th>Company</th>
                {(
                  [
                    ["mcap", "MCap"],
                    ["connected", "Connected Companies"],
                    ["directors", "Directors"],
                    ["largest", "Largest Connected MCap"],
                    ["ratio", "Max Gap"],
                    ["n10k", "≥₹10k Cr"],
                    ["n25k", "≥₹25k Cr"],
                    ["n50k", "≥₹50k Cr"],
                    ["cross", "Cross Group"],
                  ] as const
                ).map(([id, label]) => (
                  <th key={id}>
                    <button
                      type="button"
                      className={
                        tinySort === id ? "net-sort-btn on" : "net-sort-btn"
                      }
                      onClick={() => {
                        setPage(1);
                        setTinySort(id);
                      }}
                    >
                      {label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tinyRows.map((row) => {
                const open = tinyOpen === row.target_ticker;
                const d = tinyDetail;
                const bandLabel =
                  row.band === "lt100"
                    ? "< ₹100 Cr"
                    : row.band === "100_250"
                      ? "₹100–250 Cr"
                      : row.band === "250_500"
                        ? "₹250–500 Cr"
                        : "₹500–1,000 Cr";
                const connSorted = [...(d?.connections || [])].sort((a, b) => {
                  if (tinyEdgeSort === "mcap") {
                    return (
                      (b.connected_market_cap ?? 0) -
                      (a.connected_market_cap ?? 0)
                    );
                  }
                  if (tinyEdgeSort === "date") {
                    return b.event_date.localeCompare(a.event_date);
                  }
                  return (
                    (b.market_cap_ratio ?? 0) - (a.market_cap_ratio ?? 0)
                  );
                });
                return (
                  <Fragment key={row.target_ticker}>
                    <tr>
                      <td className="net-company">
                        {onTargetTicker ? (
                          <button
                            type="button"
                            title={`${row.target_ticker} — board graph`}
                            onClick={() => onTargetTicker(row.target_ticker)}
                          >
                            {row.target_company || row.target_ticker}
                          </button>
                        ) : (
                          (row.target_company || row.target_ticker)
                        )}
                        {tvBadge(row.target_ticker)}
                        <span>{row.target_ticker}</span>
                      </td>
                      <td>{fmtCr(row.target_market_cap)}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => {
                            setTinyOpen(open ? null : row.target_ticker);
                            setTinyTab("overview");
                          }}
                        >
                          {row.connected_company_count.toLocaleString("en-IN")}
                        </button>
                      </td>
                      <td>
                        {row.distinct_director_count.toLocaleString("en-IN")}
                      </td>
                      <td>{fmtCr(row.max_connected_market_cap)}</td>
                      <td className="net-ratio">
                        {fmtRatio(row.max_market_cap_ratio)}
                      </td>
                      <td>
                        {row.connected_10000cr_count.toLocaleString("en-IN")}
                      </td>
                      <td>
                        {row.connected_25000cr_count.toLocaleString("en-IN")}
                      </td>
                      <td>
                        {row.connected_50000cr_count.toLocaleString("en-IN")}
                      </td>
                      <td>
                        {row.cross_group_count.toLocaleString("en-IN")}
                      </td>
                    </tr>
                    {open ? (
                      <tr className="net-drill">
                        <td colSpan={10}>
                          {d?.company?.target_ticker === row.target_ticker ? (
                            <div>
                              <div
                                className="fam-dash-tabs"
                                role="tablist"
                                aria-label="Tiny Capital Gap detail"
                              >
                                {(
                                  [
                                    ["overview", "Overview"],
                                    ["connections", "Connections"],
                                    ["directors", "Directors"],
                                    ["groups", "Groups"],
                                  ] as const
                                ).map(([id, label]) => (
                                  <button
                                    key={id}
                                    type="button"
                                    role="tab"
                                    className={
                                      tinyTab === id ? "tab on" : "tab"
                                    }
                                    aria-selected={tinyTab === id}
                                    onClick={() => setTinyTab(id)}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                              {tinyTab === "overview" ? (
                                <div className="company-network-summary">
                                  <span>
                                    {d.company.target_company ||
                                      d.company.target_ticker}{" "}
                                    ({d.company.target_ticker})
                                  </span>
                                  <span>
                                    MCap {fmtCr(d.company.target_market_cap)}
                                  </span>
                                  <span>Band {bandLabel}</span>
                                  <span>
                                    {d.company.connected_company_count}{" "}
                                    connected companies
                                  </span>
                                  <span>
                                    {d.company.distinct_director_count}{" "}
                                    directors
                                  </span>
                                  <span>
                                    Largest connected{" "}
                                    {fmtCr(d.company.max_connected_market_cap)}
                                  </span>
                                  <span>
                                    Max gap{" "}
                                    {fmtRatio(d.company.max_market_cap_ratio)}
                                  </span>
                                  <span>
                                    Cross-group{" "}
                                    {d.company.cross_group_count}
                                  </span>
                                </div>
                              ) : null}
                              {tinyTab === "connections" ? (
                                <>
                                  <div className="company-network-filters">
                                    <label>
                                      Sort connections
                                      <select
                                        value={tinyEdgeSort}
                                        onChange={(e) =>
                                          setTinyEdgeSort(
                                            e.target.value as
                                              | "ratio"
                                              | "mcap"
                                              | "date",
                                          )
                                        }
                                      >
                                        <option value="ratio">MCap ratio</option>
                                        <option value="mcap">
                                          Connected MCap
                                        </option>
                                        <option value="date">
                                          Event date
                                        </option>
                                      </select>
                                    </label>
                                  </div>
                                  <table className="company-network-table">
                                    <thead>
                                      <tr>
                                        <th>Director</th>
                                        <th>Connected Company</th>
                                        <th>Connected MCap</th>
                                        <th>MCap Ratio</th>
                                        <th>Connection Type</th>
                                        <th>Event date</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {connSorted.map((edge) => (
                                        <tr
                                          key={`${edge.person_id}|${edge.connected_ticker}`}
                                        >
                                          <td>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                onPerson(
                                                  edge.person_id,
                                                  edge.director,
                                                )
                                              }
                                            >
                                              {edge.director}
                                            </button>
                                          </td>
                                          {companyCell(
                                            edge.connected_ticker,
                                            edge.connected_company,
                                          )}
                                          <td>
                                            {fmtCr(edge.connected_market_cap)}
                                          </td>
                                          <td className="net-ratio">
                                            {fmtRatio(edge.market_cap_ratio)}
                                          </td>
                                          <td>
                                            {connLabel(edge.connection_type)}
                                          </td>
                                          <td>
                                            {fmtEventDate(edge.event_date)}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </>
                              ) : null}
                              {tinyTab === "directors" ? (
                                <table className="company-network-table">
                                  <thead>
                                    <tr>
                                      <th>Director</th>
                                      <th>person_id</th>
                                      <th>Connected companies</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {d.directors.map((p) => (
                                      <tr key={p.person_id}>
                                        <td>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              onPerson(p.person_id, p.director)
                                            }
                                          >
                                            {p.director}
                                          </button>
                                        </td>
                                        <td>{p.person_id}</td>
                                        <td>
                                          {p.connected_companies.toLocaleString(
                                            "en-IN",
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : null}
                              {tinyTab === "groups" ? (
                                <table className="company-network-table">
                                  <thead>
                                    <tr>
                                      <th>Group</th>
                                      <th>group_key</th>
                                      <th>Companies</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {d.groups.map((g) => (
                                      <tr key={g.group_key}>
                                        <td>{g.group_name}</td>
                                        <td>{g.group_key}</td>
                                        <td>{g.tickers.join(", ")}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : null}
                            </div>
                          ) : (
                            <p className="table-meta">Loading…</p>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        ) : mode === "pairs" ? (
          <table className="company-network-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Company</th>
                <th>Shared directors</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((row) => (
                <tr key={`${row.ticker_a}|${row.ticker_b}`}>
                  {companyCell(row.ticker_a, row.name_a)}
                  {companyCell(row.ticker_b, row.name_b)}
                  <td>{row.shared_directors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : mode === "gmap" ? (
          gmapPane === "merges" ? (
            <table className="company-network-table company-network-table--hubs">
              <thead>
                <tr>
                  <th>Group A</th>
                  <th>Companies A</th>
                  <th>Group B</th>
                  <th>Companies B</th>
                  <th>Shared Companies</th>
                  <th>Shared Directors</th>
                  <th>Pairs A</th>
                  <th>Pairs B</th>
                  <th>Issue</th>
                </tr>
              </thead>
              <tbody>
                {gmapMerges.map((m) => {
                  const open = gmapMergeOpen === m.id;
                  return (
                    <Fragment key={m.id}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            onClick={() =>
                              setGmapMergeOpen(open ? null : m.id)
                            }
                          >
                            {m.group_a}
                          </button>
                        </td>
                        <td>{m.companies_a}</td>
                        <td>{m.group_b}</td>
                        <td>{m.companies_b}</td>
                        <td>{m.shared_companies}</td>
                        <td>{m.shared_directors}</td>
                        <td>{m.pairs_a}</td>
                        <td>{m.pairs_b}</td>
                        <td>{m.why}</td>
                      </tr>
                      {open ? (
                        <tr className="net-drill">
                          <td colSpan={9}>
                            <p className="table-meta">
                              Merge candidate only. Do not merge automatically.
                              Status: {gmapStatus[m.id] || "Unreviewed"}
                            </p>
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => setReviewStatus(m.id, "keep")}
                            >
                              Keep Separate
                            </button>{" "}
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() =>
                                setReviewStatus(m.id, "merge_candidate")
                              }
                            >
                              Merge Candidate
                            </button>{" "}
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() =>
                                setReviewStatus(m.id, "needs_verification")
                              }
                            >
                              Needs Verification
                            </button>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          ) : gmapPane === "groups" ? (
            <table className="company-network-table company-network-table--hubs">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Companies</th>
                </tr>
              </thead>
              <tbody>
                {gmapGroups.map((g) => {
                  const open =
                    gmapOpen?.kind === "generic_sector" &&
                    gmapOpen.current_group_key === g.group_key;
                  return (
                    <Fragment key={g.group_key}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            onClick={() =>
                              setGmapOpen(
                                open
                                  ? null
                                  : {
                                      id: `group:${g.group_key}`,
                                      kind: "generic_sector",
                                      priority: "MEDIUM",
                                      ticker: null,
                                      company: `(group) ${g.companies} companies`,
                                      current_group: g.group_name,
                                      current_group_key: g.group_key,
                                      other_groups: "",
                                      issue: "",
                                      governance_impact: "",
                                      pairs_involving: 0,
                                    },
                              )
                            }
                          >
                            {g.group_name}
                          </button>
                        </td>
                        <td>{g.companies.toLocaleString("en-IN")}</td>
                      </tr>
                      {open && gmapGroup?.group_key === g.group_key ? (
                        <tr className="net-drill">
                          <td colSpan={2}>
                            <p className="table-meta">
                              {gmapGroup.group_name} · {gmapGroup.group_key} ·{" "}
                              {gmapGroup.companies.length} companies ·{" "}
                              {gmapGroup.seats} seats · {gmapGroup.directors}{" "}
                              directors · {gmapGroup.pairs_involving} governance
                              pairs · {gmapGroup.same_group_pairs} same-group ·{" "}
                              {gmapGroup.cross_group_pairs} cross-group
                              {gmapGroup.reason
                                ? ` · ${gmapGroup.reason}`
                                : ""}
                            </p>
                            <table className="company-network-table">
                              <thead>
                                <tr>
                                  <th>Ticker</th>
                                  <th>Company</th>
                                  <th>MCap</th>
                                  <th>Directors</th>
                                  <th>Other Groups</th>
                                </tr>
                              </thead>
                              <tbody>
                                {gmapGroup.companies.map((c) => (
                                  <tr key={c.ticker}>
                                    {targetCell(c.ticker, c.company)}
                                    <td>{c.company || "N/A"}</td>
                                    <td>{fmtCr(c.mcap)}</td>
                                    <td>{c.directors}</td>
                                    <td>{c.other_groups || "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      ) : open ? (
                        <tr className="net-drill">
                          <td colSpan={2}>
                            <p className="table-meta">Loading group…</p>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="company-network-table company-network-table--hubs">
              <thead>
                <tr>
                  <th>Priority</th>
                  <th>Company</th>
                  <th>Ticker</th>
                  <th>Current Group</th>
                  <th>Other Groups</th>
                  <th>Issue</th>
                  <th>Governance Impact</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {gmapRows
                  .filter((row) => {
                    const st = gmapStatus[row.id] || "unreviewed";
                    return (
                      gmapStatusFilter === "all" || st === gmapStatusFilter
                    );
                  })
                  .map((row) => {
                    const open = gmapOpen?.id === row.id;
                    const st = gmapStatus[row.id] || "unreviewed";
                    return (
                      <Fragment key={row.id}>
                        <tr>
                          <td>{row.priority}</td>
                          <td>
                            <button
                              type="button"
                              onClick={() => setGmapOpen(open ? null : row)}
                            >
                              {row.company || row.current_group}
                            </button>
                          </td>
                          <td>
                            {row.ticker && onTargetTicker ? (
                              <button
                                type="button"
                                onClick={() => onTargetTicker(row.ticker!)}
                              >
                                {row.ticker}
                              </button>
                            ) : (
                              row.ticker || "—"
                            )}
                          </td>
                          <td>{row.current_group}</td>
                          <td>{row.other_groups || "—"}</td>
                          <td>{row.issue}</td>
                          <td>{row.governance_impact}</td>
                          <td>{st.replace(/_/g, " ")}</td>
                        </tr>
                        {open ? (
                          <tr className="net-drill">
                            <td colSpan={8}>
                              {row.ticker &&
                              gmapCompany?.ticker === row.ticker ? (
                                <div>
                                  <p className="table-meta">
                                    {gmapCompany.company || gmapCompany.ticker}{" "}
                                    · {gmapCompany.ticker} ·{" "}
                                    {fmtCr(gmapCompany.mcap)} ·{" "}
                                    {gmapCompany.current_directors} current
                                    directors ·{" "}
                                    {gmapCompany.connected_companies} connected
                                    companies ·{" "}
                                    {gmapCompany.same_group_connections}{" "}
                                    same-group ·{" "}
                                    {gmapCompany.cross_group_connections}{" "}
                                    cross-group
                                  </p>
                                  <p className="table-meta">
                                    Current memberships:
                                  </p>
                                  <ul>
                                    {gmapCompany.memberships.map((m) => (
                                      <li key={m.group_key}>
                                        {m.group_name} ({m.group_key}) · pairs{" "}
                                        {m.impact.pairs_involving} · same{" "}
                                        {m.impact.same_group_pairs} · cross{" "}
                                        {m.impact.cross_group_pairs}{" "}
                                        <button
                                          type="button"
                                          className="btn-ghost"
                                          onClick={() =>
                                            runPreview({
                                              action: "remove",
                                              ticker: gmapCompany.ticker,
                                              group_key: m.group_key,
                                              expected_group_name: m.group_name,
                                            })
                                          }
                                        >
                                          Preview remove
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                  {gmapCompany.memberships.length > 1 ? (
                                    <p className="table-meta">
                                      Removing one membership leaves the others.
                                      A company may keep multiple groups.
                                    </p>
                                  ) : null}
                                  <p className="table-meta">Connected companies</p>
                                  <table className="company-network-table">
                                    <thead>
                                      <tr>
                                        <th>Company</th>
                                        <th>Ticker</th>
                                        <th>MCap</th>
                                        <th>Current Group</th>
                                        <th>Shared Directors</th>
                                        <th>Relationship Type</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {gmapCompany.connections.map((c) => (
                                        <tr key={c.ticker}>
                                          {targetCell(c.ticker, c.company)}
                                          <td>{c.ticker}</td>
                                          <td>{fmtCr(c.mcap)}</td>
                                          <td>{c.groups}</td>
                                          <td>{c.shared_directors}</td>
                                          <td>
                                            {c.relationship_type ===
                                            "cross_group"
                                              ? "Cross Group"
                                              : c.relationship_type ===
                                                  "same_group"
                                                ? "Same Group"
                                                : "Unclassified"}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  <p className="table-meta">Directors</p>
                                  <table className="company-network-table">
                                    <thead>
                                      <tr>
                                        <th>Director</th>
                                        <th>Other Current Boards</th>
                                        <th>Other Companies&apos; Groups</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {gmapCompany.directors.map((d) => (
                                        <tr key={d.person_id}>
                                          <td>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                onPerson(
                                                  d.person_id,
                                                  d.director,
                                                )
                                              }
                                            >
                                              {d.director}
                                            </button>
                                          </td>
                                          <td>{d.other_boards}</td>
                                          <td>
                                            {d.other_companies
                                              .map(
                                                (o) =>
                                                  `${o.ticker}${
                                                    o.groups
                                                      ? ` (${o.groups})`
                                                      : ""
                                                  }`,
                                              )
                                              .join("; ") || "—"}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  {gmapWrite ? (
                                    <div>
                                      <p className="table-meta">
                                        {gmapWrite.committed
                                          ? "✓ company_groups updated"
                                          : "No database changes were committed."}{" "}
                                        {gmapWrite.message}
                                      </p>
                                      {gmapWrite.committed && gmapWrite.before && gmapWrite.after ? (
                                        <p className="table-meta">
                                          {gmapWrite.company_groups_changed} mappings
                                          changed. Network validation complete.
                                          Company pairs {gmapWrite.before.company_pairs} →{" "}
                                          {gmapWrite.after.company_pairs}. Same-group{" "}
                                          {gmapWrite.before.same_group_pairs} →{" "}
                                          {gmapWrite.after.same_group_pairs}. Cross-group{" "}
                                          {gmapWrite.before.cross_group_pairs} →{" "}
                                          {gmapWrite.after.cross_group_pairs}.
                                          Unclassified {gmapWrite.before.unclassified_pairs}{" "}
                                          → {gmapWrite.after.unclassified_pairs}.
                                        </p>
                                      ) : null}
                                    </div>
                                  ) : null}
                                  {gmapAction && gmapPreview ? (
                                    <div>
                                      <p className="table-meta">
                                        Confirm write to company_groups.{" "}
                                        {gmapPreview.summary?.removed ?? 0} mappings
                                        will be removed.{" "}
                                        {gmapPreview.summary?.reassigned ?? 0}{" "}
                                        mappings will be reassigned.{" "}
                                        {gmapPreview.summary?.added ?? 0} mappings
                                        will be added.
                                      </p>
                                      <p className="table-meta">
                                        Preview: company pairs{" "}
                                        {gmapPreview.before.company_pairs} →{" "}
                                        {gmapPreview.after.company_pairs} (must stay
                                        equal). Same-group{" "}
                                        {gmapPreview.before.same_group_pairs} →{" "}
                                        {gmapPreview.after.same_group_pairs}.
                                        Cross-group{" "}
                                        {gmapPreview.before.cross_group_pairs} →{" "}
                                        {gmapPreview.after.cross_group_pairs}.
                                        Unclassified{" "}
                                        {gmapPreview.before.unclassified_pairs} →{" "}
                                        {gmapPreview.after.unclassified_pairs}.
                                      </p>
                                      {gmapPreview.change ? (
                                        <p className="table-meta">
                                          {gmapPreview.change.ticker}{" "}
                                          {gmapPreview.change.company || ""} ·{" "}
                                          {gmapPreview.change.current_group} ·{" "}
                                          {gmapPreview.change.action}
                                          {gmapPreview.change.new_group
                                            ? ` → ${gmapPreview.change.new_group}`
                                            : ""}
                                        </p>
                                      ) : null}
                                      {gmapAction.action === "remove" ? (
                                        <p className="table-meta">
                                          This will remove {gmapAction.ticker} from
                                          the selected group. It will not delete
                                          the company or any governance data.
                                        </p>
                                      ) : (
                                        <p className="table-meta">
                                          Current: {gmapAction.ticker} →{" "}
                                          {gmapAction.group_key}. New:{" "}
                                          {gmapAction.ticker} →{" "}
                                          {gmapAction.new_group_key}.
                                        </p>
                                      )}
                                      <table className="company-network-table">
                                        <thead>
                                          <tr>
                                            <th>Company A</th>
                                            <th>Company B</th>
                                            <th>Before</th>
                                            <th>After</th>
                                            <th>Reason</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {gmapPreview.affected
                                            .slice(0, 50)
                                            .map((p) => (
                                              <tr
                                                key={`${p.ticker_a}|${p.ticker_b}`}
                                              >
                                                <td>{p.ticker_a}</td>
                                                <td>{p.ticker_b}</td>
                                                <td>{p.before}</td>
                                                <td>{p.after}</td>
                                                <td>{p.reason}</td>
                                              </tr>
                                            ))}
                                        </tbody>
                                      </table>
                                      <button
                                        type="button"
                                        className="btn-ghost"
                                        onClick={() => {
                                          const mem =
                                            gmapCompany.memberships.find(
                                              (m) =>
                                                m.group_key ===
                                                gmapAction.group_key,
                                            );
                                          void fetch("/api/governance-map", {
                                            method: "POST",
                                            headers: {
                                              "Content-Type": "application/json",
                                            },
                                            body: JSON.stringify({
                                              view: "group-mapping-apply",
                                              confirm: true,
                                              changes: [
                                                {
                                                  ...gmapAction,
                                                  expected_group_name:
                                                    gmapAction.expected_group_name ||
                                                    mem?.group_name,
                                                },
                                              ],
                                            }),
                                          }).then(async (res) => {
                                            const j =
                                              (await res.json()) as GmapWriteResult;
                                            setGmapWrite(j);
                                            if (j.ok && j.committed) {
                                              setReviewStatus(
                                                row.id,
                                                gmapAction.action,
                                              );
                                              setGmapAction(null);
                                              setGmapPreview(null);
                                              setGmapTick((n) => n + 1);
                                            }
                                          });
                                        }}
                                      >
                                        Confirm write to company_groups
                                      </button>
                                    </div>
                                  ) : null}
                                  <p className="table-meta">Review actions</p>
                                  <button
                                    type="button"
                                    className="btn-ghost"
                                    onClick={() =>
                                      setReviewStatus(row.id, "keep")
                                    }
                                  >
                                    Keep
                                  </button>{" "}
                                  <button
                                    type="button"
                                    className="btn-ghost"
                                    onClick={() =>
                                      setReviewStatus(row.id, "verified")
                                    }
                                  >
                                    Verified
                                  </button>{" "}
                                  <button
                                    type="button"
                                    className="btn-ghost"
                                    onClick={() =>
                                      setReviewStatus(
                                        row.id,
                                        "needs_verification",
                                      )
                                    }
                                  >
                                    Needs Verification
                                  </button>{" "}
                                  {gmapCompany.memberships.length ? (
                                    <>
                                      <label>
                                        Reassign to{" "}
                                        <select
                                          value={gmapReassignTo}
                                          onChange={(e) =>
                                            setGmapReassignTo(e.target.value)
                                          }
                                        >
                                          <option value="">
                                            Select existing group
                                          </option>
                                          {gmapGroups.map((g) => (
                                            <option
                                              key={g.group_key}
                                              value={g.group_key}
                                            >
                                              {g.group_name}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                      <button
                                        type="button"
                                        className="btn-ghost"
                                        disabled={!gmapReassignTo}
                                        onClick={() =>
                                          runPreview({
                                            action: "reassign",
                                            ticker: gmapCompany.ticker,
                                            group_key:
                                              gmapCompany.memberships[0]
                                                .group_key,
                                            new_group_key: gmapReassignTo,
                                            expected_group_name:
                                              gmapCompany.memberships[0]
                                                .group_name,
                                          })
                                        }
                                      >
                                        Preview reassign
                                      </button>
                                    </>
                                  ) : null}
                                </div>
                              ) : gmapGroup &&
                                row.kind === "generic_sector" &&
                                gmapGroup.group_key ===
                                  row.current_group_key ? (
                                <div>
                                  <p className="table-meta">
                                    {gmapGroup.group_name}: {gmapGroup.reason} ·{" "}
                                    {gmapGroup.companies.length} companies ·{" "}
                                    {gmapGroup.pairs_involving} pairs involving
                                    · {gmapGroup.same_group_pairs} same-group ·{" "}
                                    {gmapGroup.cross_group_pairs} cross-group
                                  </p>
                                  <table className="company-network-table">
                                    <thead>
                                      <tr>
                                        <th>Ticker</th>
                                        <th>Company</th>
                                        <th>MCap</th>
                                        <th>Directors</th>
                                        <th>Other Groups</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {gmapGroup.companies.map((c) => (
                                        <tr key={c.ticker}>
                                          {targetCell(c.ticker, c.company)}
                                          <td>{c.company || "N/A"}</td>
                                          <td>{fmtCr(c.mcap)}</td>
                                          <td>{c.directors}</td>
                                          <td>{c.other_groups || "—"}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  <button
                                    type="button"
                                    className="btn-ghost"
                                    onClick={() =>
                                      setReviewStatus(row.id, "keep")
                                    }
                                  >
                                    Keep
                                  </button>{" "}
                                  <button
                                    type="button"
                                    className="btn-ghost"
                                    onClick={() =>
                                      setReviewStatus(
                                        row.id,
                                        "needs_verification",
                                      )
                                    }
                                  >
                                    Needs Verification
                                  </button>
                                </div>
                              ) : (
                                <p className="table-meta">Loading review…</p>
                              )}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
              </tbody>
            </table>
          )
        ) : mode === "clusters" ? (
          <table className="company-network-table company-network-table--hubs">
            <thead>
              <tr>
                <th>Cluster</th>
                <th>Companies</th>
                <th>Directors</th>
                <th>Governance Connections</th>
                <th>Groups</th>
                <th>Cross-Group Connections</th>
                <th>Largest MCap</th>
                <th>Smallest MCap</th>
              </tr>
            </thead>
            <tbody>
              {clusterRows.map((row) => {
                const open = clusterOpen === row.cluster;
                const d = clusterDetail;
                return (
                  <Fragment key={row.cluster}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          onClick={() => {
                            setClusterOpen(open ? null : row.cluster);
                            setClusterTab("overview");
                            setClusterPair(null);
                          }}
                        >
                          Cluster {row.cluster}
                        </button>
                      </td>
                      <td>{row.companies.toLocaleString("en-IN")}</td>
                      <td>{row.directors.toLocaleString("en-IN")}</td>
                      <td>
                        {row.direct_relationships.toLocaleString("en-IN")}
                      </td>
                      <td>{row.groups.toLocaleString("en-IN")}</td>
                      <td>
                        {row.cross_group_relationships.toLocaleString("en-IN")}
                      </td>
                      <td>{fmtCr(row.largest_mcap)}</td>
                      <td>{fmtCr(row.smallest_mcap)}</td>
                    </tr>
                    {open ? (
                      <tr className="net-drill">
                        <td colSpan={8}>
                          {d?.cluster?.cluster === row.cluster ? (
                            <div>
                              <div
                                className="fam-dash-tabs"
                                role="tablist"
                                aria-label="Cluster detail"
                              >
                                {(
                                  [
                                    ["overview", "Cluster Overview"],
                                    ["companies", "Companies"],
                                    ["directors", "Directors"],
                                    ["connections", "Connections"],
                                    ["groups", "Groups"],
                                  ] as const
                                ).map(([id, label]) => (
                                  <button
                                    key={id}
                                    type="button"
                                    role="tab"
                                    className={
                                      clusterTab === id ? "tab on" : "tab"
                                    }
                                    aria-selected={clusterTab === id}
                                    onClick={() => {
                                      setClusterTab(id);
                                      setClusterPair(null);
                                    }}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                              {clusterTab === "overview" ? (
                                <div>
                                  <p className="table-meta">
                                    Cluster ID {d.cluster.cluster}
                                  </p>
                                  <div className="company-network-summary">
                                    <span>
                                      <strong>
                                        {d.cluster.companies.toLocaleString(
                                          "en-IN",
                                        )}
                                      </strong>{" "}
                                      Companies
                                    </span>
                                    <span>
                                      <strong>
                                        {d.cluster.directors.toLocaleString(
                                          "en-IN",
                                        )}
                                      </strong>{" "}
                                      Directors
                                    </span>
                                    <span>
                                      <strong>
                                        {d.cluster.direct_relationships.toLocaleString(
                                          "en-IN",
                                        )}
                                      </strong>{" "}
                                      Governance Connections
                                    </span>
                                    <span>
                                      <strong>
                                        {d.cluster.groups.toLocaleString(
                                          "en-IN",
                                        )}
                                      </strong>{" "}
                                      Groups
                                    </span>
                                    <span>
                                      <strong>
                                        {d.cluster.same_group_relationships.toLocaleString(
                                          "en-IN",
                                        )}
                                      </strong>{" "}
                                      Same-Group Connections
                                    </span>
                                    <span>
                                      <strong>
                                        {d.cluster.cross_group_relationships.toLocaleString(
                                          "en-IN",
                                        )}
                                      </strong>{" "}
                                      Cross-Group Connections
                                    </span>
                                    <span>
                                      <strong>
                                        {d.cluster.unclassified_relationships.toLocaleString(
                                          "en-IN",
                                        )}
                                      </strong>{" "}
                                      Unclassified Connections
                                    </span>
                                  </div>
                                  {(() => {
                                    const withMcap = d.companies.filter(
                                      (c) =>
                                        c.market_cap != null &&
                                        c.market_cap > 0,
                                    );
                                    const largest = withMcap[0];
                                    const smallest = withMcap.length
                                      ? withMcap[withMcap.length - 1]
                                      : null;
                                    return (
                                      <p className="table-meta">
                                        Largest Company by MCap:{" "}
                                        {largest
                                          ? `${largest.company || largest.ticker} (${largest.ticker}) ${fmtCr(largest.market_cap)}`
                                          : "N/A"}
                                        {" · "}
                                        Smallest Company by MCap:{" "}
                                        {smallest
                                          ? `${smallest.company || smallest.ticker} (${smallest.ticker}) ${fmtCr(smallest.market_cap)}`
                                          : "N/A"}
                                      </p>
                                    );
                                  })()}
                                  {d.companies.length <= 25 ? (
                                    <p className="table-meta">
                                      Company nodes:{" "}
                                      {d.companies
                                        .map((c) => c.ticker)
                                        .join(", ")}
                                      . Shared-director edges:{" "}
                                      {d.connections.length.toLocaleString(
                                        "en-IN",
                                      )}
                                      .
                                    </p>
                                  ) : (
                                    <p className="table-meta">
                                      Graph listing is omitted for large
                                      clusters. Use Connections for
                                      shared-director edges. Groups are
                                      metadata only and do not create edges.
                                    </p>
                                  )}
                                </div>
                              ) : null}
                              {clusterTab === "companies" ? (
                                <table className="company-network-table">
                                  <thead>
                                    <tr>
                                      <th>Company</th>
                                      <th>Ticker</th>
                                      <th>MCap</th>
                                      <th>Groups</th>
                                      <th>Directors</th>
                                      <th>Connections</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {d.companies.map((c) => (
                                      <tr key={c.ticker}>
                                        <td className="net-company">
                                          {onTargetTicker ? (
                                            <button
                                              type="button"
                                              title={`${c.ticker} — board graph`}
                                              onClick={() =>
                                                onTargetTicker(c.ticker)
                                              }
                                            >
                                              {c.company || c.ticker}
                                            </button>
                                          ) : (
                                            (c.company || c.ticker)
                                          )}
                                          {tvBadge(c.ticker)}
                                        </td>
                                        <td>
                                          {onTargetTicker ? (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                onTargetTicker(c.ticker)
                                              }
                                            >
                                              {c.ticker}
                                            </button>
                                          ) : (
                                            c.ticker
                                          )}
                                        </td>
                                        <td>{fmtCr(c.market_cap)}</td>
                                        <td>
                                          {c.group_name || "Unclassified"}
                                        </td>
                                        <td>
                                          {c.directors_in_cluster.toLocaleString(
                                            "en-IN",
                                          )}
                                        </td>
                                        <td>
                                          {c.connections_in_cluster.toLocaleString(
                                            "en-IN",
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : null}
                              {clusterTab === "directors" ? (
                                <table className="company-network-table">
                                  <thead>
                                    <tr>
                                      <th>Director</th>
                                      <th>person_id</th>
                                      <th>Boards in Cluster</th>
                                      <th>Total Current Boards</th>
                                      <th>Groups Represented</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {d.directors.map((p) => (
                                      <tr key={p.person_id}>
                                        <td>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              onPerson(p.person_id, p.director)
                                            }
                                          >
                                            {p.director}
                                          </button>
                                        </td>
                                        <td>{p.person_id}</td>
                                        <td>
                                          {p.boards_in_cluster.toLocaleString(
                                            "en-IN",
                                          )}
                                        </td>
                                        <td>
                                          {p.total_boards.toLocaleString(
                                            "en-IN",
                                          )}
                                        </td>
                                        <td>
                                          {p.groups_represented.toLocaleString(
                                            "en-IN",
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : null}
                              {clusterTab === "connections" ? (
                                <table className="company-network-table">
                                  <thead>
                                    <tr>
                                      <th>Company A</th>
                                      <th>Ticker A</th>
                                      <th>MCap A</th>
                                      <th>Group A</th>
                                      <th>Company B</th>
                                      <th>Ticker B</th>
                                      <th>MCap B</th>
                                      <th>Group B</th>
                                      <th>Shared Directors</th>
                                      <th>Relationship Type</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {d.connections.map((p) => {
                                      const key = `${p.ticker_a}|${p.ticker_b}`;
                                      const shown = clusterPair === key;
                                      return (
                                        <Fragment key={key}>
                                          <tr>
                                            <td className="net-company">
                                              {p.company_a || p.ticker_a}
                                            </td>
                                            {targetCell(p.ticker_a, p.company_a)}
                                            <td>{fmtCr(p.mcap_a)}</td>
                                            <td>
                                              {p.group_a || "Unclassified"}
                                            </td>
                                            <td className="net-company">
                                              {p.company_b || p.ticker_b}
                                            </td>
                                            {targetCell(p.ticker_b, p.company_b)}
                                            <td>{fmtCr(p.mcap_b)}</td>
                                            <td>
                                              {p.group_b || "Unclassified"}
                                            </td>
                                            <td>
                                              {(p.shared_people &&
                                              p.shared_people.length
                                                ? p.shared_people
                                                : []
                                              ).map((sp, i) => (
                                                <span key={sp.person_id}>
                                                  {i ? ", " : ""}
                                                  <button
                                                    type="button"
                                                    onClick={() =>
                                                      onPerson(
                                                        sp.person_id,
                                                        sp.director,
                                                      )
                                                    }
                                                  >
                                                    {sp.director}
                                                  </button>
                                                </span>
                                              ))}
                                              {!p.shared_people?.length ? (
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    setClusterPair(
                                                      shown ? null : key,
                                                    )
                                                  }
                                                >
                                                  {p.shared_directors.toLocaleString(
                                                    "en-IN",
                                                  )}
                                                </button>
                                              ) : null}
                                            </td>
                                            <td>
                                              {p.relationship_type ===
                                              "cross_group"
                                                ? "Cross Group"
                                                : p.relationship_type ===
                                                    "same_group"
                                                  ? "Same Group"
                                                  : "Unclassified"}
                                            </td>
                                          </tr>
                                          {shown && clusterShared?.pair ? (
                                            <tr className="net-drill">
                                              <td colSpan={10}>
                                                <p className="table-meta">
                                                  {clusterShared.pair.ticker_a}{" "}
                                                  {fmtCr(
                                                    clusterShared.pair.mcap_a,
                                                  )}{" "}
                                                  {clusterShared.pair.group_a ||
                                                    "Unclassified"}{" "}
                                                  ↔ {clusterShared.pair.ticker_b}{" "}
                                                  {fmtCr(
                                                    clusterShared.pair.mcap_b,
                                                  )}{" "}
                                                  {clusterShared.pair.group_b ||
                                                    "Unclassified"}
                                                </p>
                                                <table className="company-network-table">
                                                  <thead>
                                                    <tr>
                                                      <th>Director</th>
                                                      <th>Designation A</th>
                                                      <th>Designation B</th>
                                                    </tr>
                                                  </thead>
                                                  <tbody>
                                                    {clusterShared.directors.map(
                                                      (sd) => (
                                                        <tr key={sd.person_id}>
                                                          <td>
                                                            <button
                                                              type="button"
                                                              onClick={() =>
                                                                onPerson(
                                                                  sd.person_id,
                                                                  sd.director,
                                                                )
                                                              }
                                                            >
                                                              {sd.director}
                                                            </button>
                                                          </td>
                                                          <td>
                                                            {sd.designation_a ||
                                                              "N/A"}
                                                          </td>
                                                          <td>
                                                            {sd.designation_b ||
                                                              "N/A"}
                                                          </td>
                                                        </tr>
                                                      ),
                                                    )}
                                                  </tbody>
                                                </table>
                                              </td>
                                            </tr>
                                          ) : null}
                                        </Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              ) : null}
                              {clusterTab === "groups" ? (
                                <table className="company-network-table">
                                  <thead>
                                    <tr>
                                      <th>Group</th>
                                      <th>group_key</th>
                                      <th>Companies</th>
                                      <th>Directors</th>
                                      <th>Connections</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {d.groups.map((g) => (
                                      <tr key={g.group_key}>
                                        <td>{g.group_name || g.group_key}</td>
                                        <td>{g.group_key}</td>
                                        <td>
                                          {g.companies.toLocaleString("en-IN")}
                                        </td>
                                        <td>
                                          {g.directors.toLocaleString("en-IN")}
                                        </td>
                                        <td>
                                          {g.connections.toLocaleString(
                                            "en-IN",
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : null}
                            </div>
                          ) : (
                            <p className="table-meta">Loading cluster…</p>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        ) : mode === "xgroup" ? (
          xgPane === "groups" ? (
            <table className="company-network-table company-network-table--hubs">
              <thead>
                <tr>
                  <th>Group A</th>
                  <th>Group B</th>
                  <th>Directors</th>
                  <th>Companies</th>
                  <th>Relationships</th>
                  <th>Largest MCap</th>
                  <th>Smallest MCap</th>
                </tr>
              </thead>
              <tbody>
                {xgPairs.map((row) => {
                  const key = `${row.group_a_key}|${row.group_b_key}`;
                  const open = xgDrill === key;
                  return (
                    <Fragment key={key}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            onClick={() => setXgDrill(open ? null : key)}
                          >
                            {row.group_a}
                          </button>
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => setXgDrill(open ? null : key)}
                          >
                            {row.group_b}
                          </button>
                        </td>
                        <td>{row.directors}</td>
                        <td>{row.companies}</td>
                        <td>{row.relationships}</td>
                        <td>{fmtCr(row.largest_mcap)}</td>
                        <td>{fmtCr(row.smallest_mcap)}</td>
                      </tr>
                      {open ? (
                        <tr className="net-gap-profile">
                          <td colSpan={7}>
                            <div className="net-gap-profile-inner">
                              <p className="table-meta">
                                Group A ↔ Director ↔ Group B
                              </p>
                              <table className="company-network-table">
                                <thead>
                                  <tr>
                                    <th>Director</th>
                                    <th>Company A</th>
                                    <th>Group A</th>
                                    <th>MCap A</th>
                                    <th>Company B</th>
                                    <th>Group B</th>
                                    <th>MCap B</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {xgEdges.map((e) => (
                                    <tr
                                      key={`${e.person_id}|${e.company_a_ticker}|${e.company_b_ticker}`}
                                    >
                                      <td>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            onPerson(e.person_id, e.director)
                                          }
                                        >
                                          {e.director}
                                        </button>
                                      </td>
                                      {targetCell(
                                        e.company_a_ticker,
                                        e.company_a,
                                      )}
                                      <td>{e.group_a}</td>
                                      <td>{fmtCr(e.company_a_mcap)}</td>
                                      {targetCell(
                                        e.company_b_ticker,
                                        e.company_b,
                                      )}
                                      <td>{e.group_b}</td>
                                      <td>{fmtCr(e.company_b_mcap)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          ) : xgPane === "companies" ? (
            <table className="company-network-table company-network-table--hubs">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>MCap</th>
                  <th>Group</th>
                  <th>Connected Groups</th>
                  <th>Cross-Group Companies</th>
                  <th>Cross-Group Directors</th>
                  <th>Largest Connected MCap</th>
                  <th>Directors Creating Bridge</th>
                </tr>
              </thead>
              <tbody>
                {xgCompanies.map((row) => (
                  <tr key={row.ticker}>
                    {targetCell(row.ticker, row.company)}
                    <td>{fmtCr(row.market_cap)}</td>
                    <td>{row.group_name || "N/A"}</td>
                    <td>{row.connected_groups}</td>
                    <td>{row.cross_group_companies}</td>
                    <td>{row.cross_group_directors}</td>
                    <td>{fmtCr(row.largest_connected_mcap)}</td>
                    <td className="company-network-table--xg-bridge">{row.bridge_directors || "N/A"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="company-network-table company-network-table--hubs">
              <thead>
                <tr>
                  <th>Director</th>
                  <th>Boards</th>
                  <th>Groups</th>
                  <th>Cross-Group Groups</th>
                  <th>Cross-Group Companies</th>
                  <th>Cross-Group Relationships</th>
                </tr>
              </thead>
              <tbody>
                {xgDirectors.map((row) => (
                  <tr key={row.person_id}>
                    <td>
                      <button
                        type="button"
                        onClick={() => onPerson(row.person_id, row.director)}
                      >
                        {row.director}
                      </button>
                    </td>
                    <td>{row.boards}</td>
                    <td>{row.groups}</td>
                    <td>{row.cross_group_groups}</td>
                    <td>{row.cross_group_companies}</td>
                    <td>{row.cross_group_relationships}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <table className="company-network-table company-network-table--hubs">
            <thead>
              <tr>
                <th>Director</th>
                {(
                  [
                    ["boards", "Boards"],
                    ["groups", "Groups"],
                    ["largest", "Largest MCap"],
                    ["smallest", "Smallest MCap"],
                    ["spread", "MCap Spread"],
                    ["new", "New Connections"],
                    ["cross", "Cross Group"],
                  ] as const
                ).map(([id, label]) => (
                  <th key={id}>
                    <button
                      type="button"
                      className={
                        hubSort === id ? "net-sort-btn on" : "net-sort-btn"
                      }
                      title={
                        id === "cross"
                          ? "Distinct grouped current boards while the director also sits on another grouped board in a different group"
                          : id === "boards"
                            ? "Boards ↓"
                            : undefined
                      }
                      onClick={() => setHubCol(id)}
                    >
                      {label}
                      {hubSort === id && id === "boards" ? " ↓" : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hubs.map((row) => {
                const open = hubPerson === row.person_id;
                return (
                  <Fragment key={row.person_id}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          onClick={() => onPerson(row.person_id, row.director)}
                        >
                          {row.director}
                        </button>
                      </td>
                      <td>
                        <button
                          type="button"
                          title="Current boards"
                          onClick={() =>
                            setHubPerson(open ? null : row.person_id)
                          }
                        >
                          {row.boards}
                        </button>
                      </td>
                      <td>{row.groups}</td>
                      <td>{fmtCr(row.largest_mcap)}</td>
                      <td>{fmtCr(row.smallest_mcap)}</td>
                      <td className="net-ratio">
                        {fmtRatio(row.mcap_spread)}
                      </td>
                      <td>{row.new_connections}</td>
                      <td>{row.cross_group}</td>
                    </tr>
                    {open ? (
                      <tr className="net-gap-profile">
                        <td colSpan={8}>
                          <div className="net-gap-profile-inner">
                            <p className="table-meta">Current boards</p>
                            <table className="company-network-table">
                              <thead>
                                <tr>
                                  <th>Company</th>
                                  <th>Ticker</th>
                                  <th>MCap</th>
                                  <th>Group</th>
                                  <th>Designation</th>
                                </tr>
                              </thead>
                              <tbody>
                                {hubSeats.map((seat) => (
                                  <tr key={seat.ticker}>
                                    <td>{seat.company || "N/A"}</td>
                                    <td>
                                      {onTargetTicker ? (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            onTargetTicker(seat.ticker)
                                          }
                                        >
                                          {seat.ticker}
                                        </button>
                                      ) : (
                                        seat.ticker
                                      )}
                                      {tvBadge(seat.ticker)}
                                    </td>
                                    <td>{fmtCr(seat.market_cap)}</td>
                                    <td>{seat.group_name || "Unclassified"}</td>
                                    <td>{seat.designation || "N/A"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {pages > 1 ? (
        <div className="company-network-pager">
          <button
            type="button"
            className="btn-ghost"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span className="table-meta">
            {page} / {pages}
          </span>
          <button
            type="button"
            className="btn-ghost"
            disabled={page >= pages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
