import { pickAboutText } from "./db";
import type { CompanyRow } from "./db";

export type PeerUniqueness = {
  market_pool: string;
  sub_sector: string | null;
  sub_sector_peer_count: number;
  sub_sector_peers: string[];
  sector_peer_count: number;
  activity_peer_count: number;
  activity_peers: string[];
  activity_label: string | null;
  rarity: "high" | "medium" | "low";
  rarity_label: string;
};

const ACTIVITY_PATTERNS: Array<{ label: string; re: RegExp; strict?: RegExp }> = [
  {
    label: "VFX / post-production",
    re: /\b(visual effects|\bvfx\b|post[- ]production|2d\/3d)\b/i,
    strict: /\b(visual effects|\bvfx\b|post[- ]production)\b/i,
  },
  { label: "Animation studio", re: /\b(animation studio|3d animation|animated film)\b/i },
  { label: "Semiconductor / fab", re: /\b(semiconductor|wafer|fab)\b/i },
  { label: "Defence / aerospace", re: /\b(defence|defense|aerospace|missile)\b/i },
  { label: "Renewable energy", re: /\b(solar|wind energy|renewable)\b/i },
  { label: "CRAMS / API", re: /\b(crams|api manufacturing|contract manufacturing)\b/i },
  { label: "Data center / cloud", re: /\b(data center|colocation|hyperscale)\b/i },
];

function sameListingPool(a: CompanyRow, b: CompanyRow): boolean {
  const am = a.market.toUpperCase();
  const bm = b.market.toUpperCase();
  if (am.includes("SME") || bm.includes("SME")) {
    return am === bm || (am.includes("SME") && bm.includes("SME"));
  }
  if (am === "NSE" || am === "BSE") {
    return bm === am || bm.includes("SME");
  }
  return am === bm;
}

function rowText(row: CompanyRow): string {
  const about = pickAboutText({
    about: row.about,
    scraped_about: row.scraped_about,
  });
  return `${row.name} ${row.sector ?? ""} ${row.sub_sector ?? ""} ${about} ${row.search_text ?? ""}`.toLowerCase();
}

function detectActivity(text: string): string | null {
  for (const { label, re } of ACTIVITY_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

export function computePeerUniqueness(
  row: CompanyRow,
  universe: CompanyRow[],
): PeerUniqueness {
  const self = row.ticker.toUpperCase();
  const pool = universe.filter(
    (c) => c.ticker.toUpperCase() !== self && sameListingPool(row, c),
  );

  const subNorm = row.sub_sector?.trim().toLowerCase() || null;
  const subPeers = subNorm
    ? pool.filter((c) => c.sub_sector?.trim().toLowerCase() === subNorm)
    : [];

  const secNorm = row.sector?.trim().toLowerCase() || null;
  const secPeers = secNorm
    ? pool.filter((c) => c.sector?.trim().toLowerCase() === secNorm)
    : [];

  const selfText = rowText(row);
  const activityLabel = detectActivity(selfText);
  let activityPeers: CompanyRow[] = [];
  if (activityLabel) {
    const patternDef = ACTIVITY_PATTERNS.find((p) => p.label === activityLabel);
    const peerRe = patternDef?.strict ?? patternDef?.re ?? /\b(visual effects|\bvfx\b)\b/i;
    activityPeers = pool.filter((c) => peerRe.test(rowText(c)));
  }

  const subCount = subPeers.length;
  const actCount = activityPeers.length;
  const secCount = secPeers.length;
  const sme = row.market.toUpperCase().includes("SME");

  let rarity: PeerUniqueness["rarity"] = "medium";
  let rarity_label = "Some listed peers in the same bucket";

  if (actCount === 0 && activityLabel) {
    rarity = "high";
    rarity_label = `Likely only listed ${activityLabel.toLowerCase()} name on ${row.market}`;
  } else if (subCount === 0 && subNorm) {
    rarity = "high";
    rarity_label = `Sole listed name in sub-sector “${row.sub_sector}” on ${row.market}`;
  } else if (actCount <= 1 && activityLabel) {
    rarity = "high";
    rarity_label = `At most one other listed ${activityLabel.toLowerCase()} peer on ${row.market}`;
  } else if (actCount <= 3 && activityLabel && sme) {
    rarity = "high";
    rarity_label = `Few listed ${activityLabel.toLowerCase()} names on ${row.market} — niche SME slot`;
  } else if (subCount <= 1 && subNorm) {
    rarity = "high";
    rarity_label = `At most one other listed peer in the same sub-sector`;
  } else if (!sme && (secCount > 40 || subCount > 8 || actCount > 5)) {
    rarity = "low";
    rarity_label = "Crowded sector — many listed comparables";
  } else if (sme && secCount > 55 && actCount > 6) {
    rarity = "low";
    rarity_label = "Crowded SME sector — many listed comparables";
  }

  return {
    market_pool: row.market,
    sub_sector: row.sub_sector,
    sub_sector_peer_count: subCount,
    sub_sector_peers: subPeers.slice(0, 6).map((c) => c.name),
    sector_peer_count: secCount,
    activity_peer_count: actCount,
    activity_peers: activityPeers.slice(0, 6).map((c) => c.name),
    activity_label: activityLabel,
    rarity,
    rarity_label,
  };
}

export function peerContextBlock(peers: PeerUniqueness): string {
  return [
    `Listing pool: ${peers.market_pool}`,
    peers.sub_sector
      ? `Sub-sector “${peers.sub_sector}”: ${peers.sub_sector_peer_count} other listed peer(s)${peers.sub_sector_peers.length ? ` — e.g. ${peers.sub_sector_peers.join(", ")}` : ""}`
      : "Sub-sector: not classified",
    `Sector peers on same board: ${peers.sector_peer_count}`,
    peers.activity_label
      ? `Activity “${peers.activity_label}”: ${peers.activity_peer_count} other listed match(es)${peers.activity_peers.length ? ` — ${peers.activity_peers.join(", ")}` : " — none found"}`
      : null,
    `Heuristic rarity: ${peers.rarity} (${peers.rarity_label})`,
  ]
    .filter(Boolean)
    .join("\n");
}
