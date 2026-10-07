/** Deterministic keyword buckets. Generic language only — no issuers. */

export const VP_THEME_KEYS = [
  "Capacity",
  "Revenue Growth",
  "Margins",
  "Debt",
  "Promoter",
  "Management",
  "Order Book",
  "Exports",
  "New Products",
  "Valuation",
  "Corporate Governance",
  "Industry",
  "Competition",
  "Capex",
] as const;

export type VpThemeKey = (typeof VP_THEME_KEYS)[number];

const THEME_RX: Record<VpThemeKey, RegExp> = {
  Capacity:
    /\b(capacit(?:y|ies)|utilisation|utilization|debottleneck|throughput|plant expansion)\b/i,
  "Revenue Growth":
    /\b(revenue|topline|top[- ]line|sales growth|yoy growth|cagr)\b/i,
  Margins: /\b(margin|ebitda|gross profit|operating profit)\b/i,
  Debt: /\b(debt|leverage|nwc|working capital|interest cost|borrow)\b/i,
  Promoter: /\b(promoter|pledged|pledge|family holding)\b/i,
  Management: /\b(management|ceo|md\b|promoter.?md|succession|kmp)\b/i,
  "Order Book": /\b(order book|orderbook|order inflow|backlog|pipeline)\b/i,
  Exports: /\b(export|overseas|global demand|ex[- ]india)\b/i,
  "New Products":
    /\b(new product|product launch|value[- ]added|vap\b|sku)\b/i,
  Valuation: /\b(valuation|pe\b|p\/e|ev\/ebitda|cheap|expensive|multiple)\b/i,
  "Corporate Governance":
    /\b(governance|related party|rpt\b|minority|sebi|audit)\b/i,
  Industry: /\b(industry|sector|cycle|demand|supply)\b/i,
  Competition: /\b(competitor|competition|market share|peer)\b/i,
  Capex: /\b(capex|capital expenditure|greenfield|brownfield)\b/i,
};

const POS_RX =
  /\b(strong|beat|growth|recovery|upside|improving|robust|win|outperform)\b/i;
const NEG_RX =
  /\b(weak|miss|decline|downside|deteriorat|risk|concern|loss|slowdown)\b/i;

export function tagPostTone(text: string): "pos" | "neg" | "neu" | "q" {
  const t = text || "";
  if (/\?/.test(t)) return "q";
  const pos = POS_RX.test(t);
  const neg = NEG_RX.test(t);
  if (pos && !neg) return "pos";
  if (neg && !pos) return "neg";
  return "neu";
}

export function themesInText(text: string): VpThemeKey[] {
  const t = text || "";
  return VP_THEME_KEYS.filter((k) => THEME_RX[k].test(t));
}

export function calculateThemeStrength(
  texts: string[],
): { theme: VpThemeKey; posts: number; pct: number }[] {
  const n = texts.length;
  if (!n) return [];
  const counts = new Map<VpThemeKey, number>();
  for (const raw of texts) {
    const hit = new Set(themesInText(raw));
    for (const k of hit) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return VP_THEME_KEYS.map((theme) => ({
    theme,
    posts: counts.get(theme) ?? 0,
    pct: ((counts.get(theme) ?? 0) / n) * 100,
  })).filter((r) => r.posts > 0);
}
