/**
 * Fill capex / catalysts / watch from Research-stored sources only.
 * Prefer PPT, then concall transcript, then corporate concall extract.
 * Never invent ₹ or generic catalyst phrases.
 */
import { loadCorporateConcallExtract } from "./corporate-data";
import {
  listInvestorMaterials,
  importLatestInvestorMaterials,
  isPendingInvestorMaterial,
  type InvestorMaterial,
} from "./investor-materials";
import { materialHeadline } from "./investor-material-labels";
import { pickMaterialsForBrief } from "./investor-material-corpus";

export type ResearchFillSourceKind = "ppt" | "concall" | "corporate";

export type ResearchBriefFill = {
  capex: string;
  capexFrom: ResearchFillSourceKind | null;
  triggers: string[];
  triggersFrom: ResearchFillSourceKind | null;
  watch: string;
  watchFrom: ResearchFillSourceKind | null;
  note: string | null;
  sources: string[];
};

const GENERIC_TRIGGER =
  /^(order book expansion|new product launches?|increase in export mix|capacity utilization improvement|plant commissioning)$/i;

const PLACEHOLDER_CAPEX =
  /₹X\s*cr|\bX cr\b|details to be provided|unclear from sources|not disclosed|no explicit fy capex|no capex guidance/i;

function usableMaterial(m: InvestorMaterial): boolean {
  if (isPendingInvestorMaterial(m)) return false;
  return m.raw_text.replace(/\s/g, "").length >= 80;
}

function kindOf(m: InvestorMaterial): ResearchFillSourceKind {
  return m.kind === "ppt" ? "ppt" : "concall";
}

function fieldFromBriefText(text: string, label: RegExp): string {
  const m = text.match(label);
  return (m?.[1] || "").replace(/\s+/g, " ").trim();
}

function parseMaterialFill(m: InvestorMaterial): {
  capex: string;
  triggers: string[];
  watch: string;
} {
  const brief = (m.brief_text || "").trim();
  const capex = fieldFromBriefText(brief, /^CAPEX:\s*(.+)$/im);
  const growth = fieldFromBriefText(brief, /^Growth:\s*(.+)$/im);
  const triggers = growth
    .split(/\s*·\s*|\n+/)
    .map((p) => p.trim())
    .filter((p) => p && !GENERIC_TRIGGER.test(p) && !PLACEHOLDER_CAPEX.test(p));
  return {
    capex: capex && !PLACEHOLDER_CAPEX.test(capex) ? capex.slice(0, 280) : "",
    triggers: triggers.slice(0, 4),
    watch: "",
  };
}

function usableCapex(s: string | null | undefined): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (!t || PLACEHOLDER_CAPEX.test(t)) return "";
  return t.slice(0, 280);
}

function usableWatch(s: string | null | undefined): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (/risks related to global market|crowded sector/i.test(t)) return "";
  return t.slice(0, 240);
}

export function isGenericTriggerClause(text: string): boolean {
  return GENERIC_TRIGGER.test(text.trim());
}

export function isPlaceholderCapex(text: string): boolean {
  return !text.trim() || PLACEHOLDER_CAPEX.test(text);
}

export function collectResearchBriefFill(ticker: string): ResearchBriefFill {
  const key = ticker.trim().toUpperCase();
  const materials = pickMaterialsForBrief(listInvestorMaterials(key)).filter(
    usableMaterial,
  );
  const ordered = [...materials].sort((a, b) => {
    const rank = (m: InvestorMaterial) => (m.kind === "ppt" ? 0 : 1);
    return rank(a) - rank(b);
  });

  let capex = "";
  let capexFrom: ResearchFillSourceKind | null = null;
  let triggers: string[] = [];
  let triggersFrom: ResearchFillSourceKind | null = null;
  let watch = "";
  let watchFrom: ResearchFillSourceKind | null = null;
  const sources: string[] = [];

  for (const m of ordered) {
    sources.push(materialHeadline(m));
    const parsed = parseMaterialFill(m);
    const from = kindOf(m);
    if (!capex && parsed.capex) {
      capex = parsed.capex;
      capexFrom = from;
    }
    if (!triggers.length && parsed.triggers.length) {
      triggers = parsed.triggers;
      triggersFrom = from;
    }
  }

  const corp = loadCorporateConcallExtract(key);
  if (corp) {
    sources.push(
      ["Research concall extract", corp.period, corp.title]
        .filter(Boolean)
        .join(" · "),
    );
    if (!capex) {
      const line = usableCapex(corp.capex);
      if (line) {
        capex = line;
        capexFrom = "corporate";
      }
    }
    if (!triggers.length) {
      const bits = [corp.orders, corp.guidance]
        .map((s) => (s || "").replace(/\s+/g, " ").trim())
        .filter((s) => s && !GENERIC_TRIGGER.test(s));
      if (bits.length) {
        triggers = bits.slice(0, 4);
        triggersFrom = "corporate";
      }
    }
    if (!watch) {
      const w = usableWatch(corp.risks);
      if (w) {
        watch = w;
        watchFrom = "corporate";
      }
    }
  }

  const used = [
    capexFrom === "ppt" || triggersFrom === "ppt" ? "PPT" : null,
    capexFrom === "concall" || triggersFrom === "concall"
      ? "concall"
      : null,
    capexFrom === "corporate" ||
    triggersFrom === "corporate" ||
    watchFrom === "corporate"
      ? "Research concall extract"
      : null,
  ].filter(Boolean);

  const note = used.length
    ? `Filled from ${used.join(" · ")}`
    : sources.length
      ? "PPT/concall on file — no ₹ capex or named catalysts in those sources"
      : "No PPT or concall in Calls yet — capex/catalysts left empty";

  return {
    capex,
    capexFrom,
    triggers,
    triggersFrom,
    watch,
    watchFrom,
    note,
    sources,
  };
}

export function formatResearchFillBlock(fill: ResearchBriefFill): string | null {
  const lines: string[] = [
    "Research-extracted facts (copy into capex / growth_triggers / watch only if present; otherwise leave empty — do not invent ₹ or generic catalysts):",
  ];
  if (fill.capex) lines.push(`capex: ${fill.capex}`);
  if (fill.triggers.length) {
    lines.push(`growth_triggers: ${fill.triggers.join(" · ")}`);
  }
  if (fill.watch) lines.push(`watch: ${fill.watch}`);
  if (fill.sources.length) {
    lines.push(`sources: ${fill.sources.join(" | ")}`);
  }
  if (lines.length <= 1) return null;
  return lines.join("\n");
}

export function applyResearchFillToBrief<
  T extends { capex: string; growth_triggers: string; watch: string },
>(brief: T, fill: ResearchBriefFill): T {
  const next = { ...brief };
  if (isPlaceholderCapex(next.capex) && fill.capex) next.capex = fill.capex;
  const clauses = next.growth_triggers
    .split(/\s*·\s*|\n+/)
    .map((p) => p.trim())
    .filter((p) => p && !isGenericTriggerClause(p));
  if (!clauses.length && fill.triggers.length) {
    next.growth_triggers = fill.triggers.join(" · ");
  } else {
    next.growth_triggers = clauses.join(" · ");
  }
  if ((!next.watch.trim() || /risks related to global market/i.test(next.watch)) &&
    fill.watch
  ) {
    next.watch = fill.watch;
  }
  return next;
}

export async function ensureInvestorMaterialsForBrief(
  ticker: string,
): Promise<void> {
  const key = ticker.trim().toUpperCase();
  const picked = pickMaterialsForBrief(listInvestorMaterials(key));
  const hasPpt = picked.some((m) => m.kind === "ppt" && usableMaterial(m));
  const hasCall = picked.some(
    (m) =>
      (m.kind === "concall" || m.kind === "transcript") && usableMaterial(m),
  );
  if (hasPpt || hasCall) return;
  await importLatestInvestorMaterials({
    ticker: key,
    limit: 2,
    kinds: ["ppt", "concall", "transcript"],
    distill: true,
  });
}
