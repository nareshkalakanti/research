import {
  isPendingInvestorMaterial,
  listInvestorMaterials,
  type InvestorMaterial,
} from "./investor-materials";
import type { InvestorMaterialKind } from "./investor-material-types";
import { materialHeadline, sourceLabel as labelForMaterial } from "./investor-material-labels";

const INVESTMENT_KEYWORDS =
  /capex|capital expend|guidance|order book|pipeline|capacity|commission|utilization|margin|ebitda|revenue|growth|expansion|plant|fy2[0-9]|quarter|segment|outlook|target|debt|working capital|free cash/i;

/** Drop BSE cover-letter noise before slide deck content. */
export function trimInvestorMaterialBody(raw: string): string {
  const text = raw.trim();
  const markers = [
    /Investor Presentation/i,
    /Safe Harbor/i,
    /Financial Results/i,
    /Q[1-4]\s*FY/i,
    /Company Overview/i,
  ];
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index != null && m.index > 80) {
      return text.slice(m.index).trim();
    }
  }
  return text;
}

function excerpt(text: string, limit: number): string {
  const t = text.trim();
  if (t.length <= limit) return t;
  return `${t.slice(0, limit)}\n\n[… truncated for analysis …]`;
}

function skipCoverLetterPrefix(text: string): string {
  const markers = [
    /Moderator:/i,
    /Operator:/i,
    /Conference Call Transcript/i,
    /Earnings Call Transcript/i,
    /Question-and-Answer/i,
    /Q&A Session/i,
    /Management Discussion/i,
    /Investor Presentation/i,
    /Safe Harbor/i,
    /Financial Results/i,
    /Q[1-4]\s*FY/i,
  ];
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index != null && m.index > 0 && m.index < 4000) {
      return text.slice(m.index).trim();
    }
  }
  return trimInvestorMaterialBody(text);
}

/** Smart excerpt — keep opening + keyword windows (capex, guidance, order book, etc.). */
export function excerptInvestorTextForLlm(text: string, limit: number): string {
  const trimmed = skipCoverLetterPrefix(text).trim();
  if (trimmed.length <= limit) return trimmed;

  const head = trimmed.slice(0, Math.floor(limit * 0.55));
  const chunks: Array<{ start: number }> = [];
  const re = new RegExp(INVESTMENT_KEYWORDS.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(trimmed)) !== null) {
    chunks.push({ start: Math.max(0, match.index - 400) });
    if (chunks.length > 24) break;
  }

  const tailStart = Math.max(0, trimmed.length - Math.floor(limit * 0.2));
  chunks.push({ start: tailStart });

  const seen = new Set<string>();
  const excerpts: string[] = [head];
  let used = head.length;

  for (const { start } of chunks.sort((a, b) => a.start - b.start)) {
    const slice = trimmed.slice(start, start + 900).trim();
    const key = slice.slice(0, 80);
    if (!slice || seen.has(key) || used + slice.length > limit) continue;
    seen.add(key);
    excerpts.push(`\n[… excerpt …]\n${slice}`);
    used += slice.length;
  }

  return `${excerpts.join("\n")}\n\n[… truncated — read sections above for capex, guidance, capacity …]`;
}

function charLimitForKind(kind: InvestorMaterialKind): number {
  if (kind === "concall" || kind === "transcript") return 14_000;
  if (kind === "ppt") return 8_000;
  return 6_000;
}

/** Full source text for the business-brief LLM (not the short distill alone). */
export function materialBodyForLlm(
  m: InvestorMaterial,
  opts?: { charLimit?: number },
): string {
  const limit = opts?.charLimit ?? charLimitForKind(m.kind);
  const parts: string[] = [];

  if (m.brief_text?.trim()) {
    parts.push(
      `Pre-extracted facts (cross-check with source text below):\n${m.brief_text.trim().slice(0, 1400)}`,
    );
  }

  const raw = trimInvestorMaterialBody(m.raw_text);
  if (m.kind === "concall" || m.kind === "transcript") {
    parts.push(excerptInvestorTextForLlm(raw, limit));
  } else {
    parts.push(excerpt(raw, limit));
  }

  return parts.join("\n\n");
}

/** @deprecated Use materialBodyForLlm — kept for callers expecting the old name. */
export function materialBodyForBrief(m: InvestorMaterial): string {
  return materialBodyForLlm(m);
}

function materialUsable(m: InvestorMaterial): boolean {
  if (isPendingInvestorMaterial(m)) return false;
  return m.raw_text.replace(/\s/g, "").length >= 40;
}

function periodSortKey(m: InvestorMaterial): number {
  const fromPeriod = m.period?.trim() || "";
  const fromTitle = m.title?.trim() || "";
  for (const raw of [fromPeriod, fromTitle]) {
    if (!raw) continue;
    const ts = Date.parse(raw.replace(/'/g, " "));
    if (Number.isFinite(ts)) return ts;
  }
  const updated = Date.parse(m.updated_at);
  return Number.isFinite(updated) ? updated : 0;
}

/** True when raw text looks like a Q&A transcript, not just an NSE intimation letter. */
export function isTranscriptLike(m: InvestorMaterial): boolean {
  if (m.kind !== "concall" && m.kind !== "transcript") return false;
  const blob = `${m.title}\n${m.raw_text.slice(0, 8000)}`.toLowerCase();
  if (/moderator|unidentified (company|speaker)|question.and.answer|q&a session|earnings call transcript/.test(blob)) {
    return true;
  }
  const len = m.raw_text.replace(/\s/g, "").length;
  if (len >= 8000) return true;
  if (len < 2800 && /national stock exchange|bse limited|sub:\s*transcript|we enclose|pursuant to regulation/.test(blob)) {
    return false;
  }
  return len >= 4500;
}

function scoreMaterialSubstance(m: InvestorMaterial): number {
  if (!materialUsable(m)) return -1;
  const text = trimInvestorMaterialBody(m.raw_text);
  const len = text.replace(/\s/g, "").length;
  let score = len;
  const blob = `${m.title} ${text.slice(0, 2500)}`.toLowerCase();

  if (/transcript|earnings call|concall|q\s*&\s*a|question.and.answer/.test(blob)) {
    score += 8000;
  }
  if (/moderator|unidentified (company|speaker)|operator/.test(blob)) {
    score += 12_000;
  }
  if (m.kind === "ppt" && /investor presentation|safe harbor/.test(blob)) {
    score += 2000;
  }
  if (
    len < 2800 &&
    /national stock exchange|bse limited|sub:\s*transcript|we enclose|pursuant to regulation/.test(blob)
  ) {
    score -= 8000;
  }
  return score;
}

function pickBestByKind(
  items: InvestorMaterial[],
  kinds: InvestorMaterialKind[],
): InvestorMaterial | undefined {
  let best: InvestorMaterial | undefined;
  let bestSubstance = -1;
  let bestPeriod = -1;

  for (const m of items) {
    if (!kinds.includes(m.kind)) continue;
    const substance = scoreMaterialSubstance(m);
    if (substance < 0) continue;
    const period = periodSortKey(m);
    if (
      substance > bestSubstance ||
      (substance === bestSubstance && period > bestPeriod)
    ) {
      bestSubstance = substance;
      bestPeriod = period;
      best = m;
    }
  }
  return best;
}

function anchorMs(iso: string | null | undefined): number {
  if (!iso) return Date.now();
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : Date.now();
}

function scoreNearAnchor(m: InvestorMaterial, anchor: number): number {
  if (!materialUsable(m)) return Infinity;
  const updated = Date.parse(m.updated_at);
  if (!Number.isFinite(updated)) return 90 * 86_400_000;
  return Math.abs(updated - anchor);
}

function kindPriority(kind: InvestorMaterialKind): number {
  if (kind === "concall" || kind === "transcript") return 0;
  if (kind === "ppt") return 1;
  return 2;
}

/** Best concall/transcript and PPT near an earn/concall event. */
export function pickMaterialsForEvent(
  ticker: string,
  anchorIso: string,
  maxAgeDays = 120,
): InvestorMaterial[] {
  const anchor = anchorMs(anchorIso);
  const maxDelta = maxAgeDays * 86_400_000;
  const items = listInvestorMaterials(ticker).filter(materialUsable);
  const picked: InvestorMaterial[] = [];
  const seen = new Set<number>();

  const pickNearest = (kinds: InvestorMaterialKind[]) => {
    let best: InvestorMaterial | null = null;
    let bestScore = Infinity;
    for (const m of items) {
      if (!kinds.includes(m.kind)) continue;
      const score = scoreNearAnchor(m, anchor);
      if (score > maxDelta || score >= bestScore) continue;
      bestScore = score;
      best = m;
    }
    if (best && !seen.has(best.id)) {
      seen.add(best.id);
      picked.push(best);
    }
  };

  pickNearest(["concall", "transcript"]);
  pickNearest(["ppt"]);
  pickNearest(["other"]);

  return picked.sort(
    (a, b) => kindPriority(a.kind) - kindPriority(b.kind),
  );
}

/** Best concall, PPT, and results PDF for the Business dossier. */
export function pickMaterialsForBrief(items: InvestorMaterial[]): InvestorMaterial[] {
  const usable = items.filter(materialUsable);
  const picked: InvestorMaterial[] = [];
  const seen = new Set<number>();

  const add = (m: InvestorMaterial | undefined) => {
    if (!m || seen.has(m.id)) return;
    seen.add(m.id);
    picked.push(m);
  };

  add(pickBestByKind(usable, ["concall", "transcript"]));
  add(pickBestByKind(usable, ["ppt"]));
  add(
    pickBestByKind(
      usable.filter((m) =>
        /annual\s*report|board\s*report|financial results/i.test(m.title || ""),
      ),
      ["other"],
    ) ?? pickBestByKind(usable, ["other"]),
  );

  for (const m of usable.sort((a, b) => periodSortKey(b) - periodSortKey(a))) {
    if (picked.length >= 3) break;
    add(m);
  }
  return picked;
}

function sourceLabel(m: InvestorMaterial): string {
  return labelForMaterial(m);
}

export type InvestorCorpusBlock = {
  promptBlock: string;
  sources: string;
  hasUsableText: boolean;
  hasConcallOrTranscript: boolean;
  materials: InvestorMaterial[];
};

/** Build LLM text block from selected materials (concall / PPT / PDF). */
export function buildInvestorMaterialsPromptBlock(
  materials: InvestorMaterial[],
  opts?: { charLimitPerMaterial?: number },
): InvestorCorpusBlock {
  const parts: string[] = [];
  const sourceParts: string[] = [];
  let hasConcallOrTranscript = false;

  for (const m of materials) {
    if (isPendingInvestorMaterial(m)) {
      parts.push(
        `\n[${materialHeadline(m)}]\nPDF/PPT not fetched — use other sources only.`,
      );
      continue;
    }
    const limit = opts?.charLimitPerMaterial ?? charLimitForKind(m.kind);
    const body = materialBodyForLlm(m, { charLimit: limit });
    if (body.replace(/\s/g, "").length < 40) continue;
    if (m.kind === "concall" || m.kind === "transcript") {
      hasConcallOrTranscript = true;
    }
    sourceParts.push(sourceLabel(m));
    parts.push(`\n=== ${materialHeadline(m)} ===\n${body}`);
  }

  const promptBlock = parts.join("\n");
  return {
    promptBlock,
    sources: sourceParts.join(" · "),
    hasUsableText: promptBlock.replace(/\s/g, "").length > 80,
    hasConcallOrTranscript,
    materials,
  };
}

export function buildEventMaterialCorpus(
  ticker: string,
  anchorIso: string,
  opts?: { charLimitPerMaterial?: number; maxAgeDays?: number },
): InvestorCorpusBlock {
  const materials = pickMaterialsForEvent(
    ticker,
    anchorIso,
    opts?.maxAgeDays ?? 120,
  );
  return buildInvestorMaterialsPromptBlock(materials, opts);
}

/** Text block appended to Business LLM dossier. */
export function formatInvestorMaterialsBriefBlock(ticker: string): string | null {
  const items = listInvestorMaterials(ticker);
  if (!items.length) return null;

  const materials = pickMaterialsForBrief(items);
  const block = buildInvestorMaterialsPromptBlock(materials, {
    charLimitPerMaterial: 14_000,
  });

  if (!block.hasUsableText) {
    const pending = items.filter(isPendingInvestorMaterial);
    if (pending.length) {
      return [
        "Investor materials (Calls tab):",
        "Sources listed but PDF/transcript text not fetched yet — open Calls tab and wait for download to finish.",
        pending.map((m) => `- ${materialHeadline(m)}`).join("\n"),
      ].join("\n");
    }
    return null;
  }

  const quality: string[] = [];
  if (!block.hasConcallOrTranscript) {
    quality.push(
      "Note: no concall transcript in Calls tab — using PPT / results PDF only (weaker for capex and management guidance).",
    );
  } else {
    const concall = materials.find(
      (m) => m.kind === "concall" || m.kind === "transcript",
    );
    if (concall && !isTranscriptLike(concall)) {
      quality.push(
        "Note: concall file may be an exchange intimation letter, not a full Q&A transcript — cross-check capex/guidance from PPT or results PDF.",
      );
    }
  }

  return [
    "Investor materials (concall / PPT / PDF — same as Calls tab; REQUIRED reading for capex, guidance, order book, capacity, segment mix):",
    ...quality,
    block.promptBlock,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Corpus for structured 10-row call review (latest concall + PPT). */
export function buildCallReviewCorpus(ticker: string): {
  corpus: string;
  hash: string;
  sources: string;
} | null {
  const items = listInvestorMaterials(ticker).filter(materialUsable);
  const latestConcall = pickBestByKind(items, ["concall", "transcript"]);
  const latestPpt = pickBestByKind(items, ["ppt"]);
  const priorConcall = items
    .filter(
      (m) =>
        (m.kind === "concall" || m.kind === "transcript") &&
        m.id !== latestConcall?.id,
    )
    .sort((a, b) => periodSortKey(b) - periodSortKey(a))[0];

  if (!latestConcall && !latestPpt) return null;

  const parts: string[] = [];
  const sourceParts: string[] = [];

  if (latestConcall) {
    parts.push(
      `=== LATEST CONCALL (${latestConcall.period || "undated"}) ===\n${materialBodyForLlm(latestConcall, { charLimit: 20_000 })}`,
    );
    sourceParts.push(sourceLabel(latestConcall));
  }
  if (latestPpt) {
    parts.push(
      `=== LATEST INVESTOR PPT (${latestPpt.period || "undated"}) ===\n${materialBodyForLlm(latestPpt, { charLimit: 20_000 })}`,
    );
    sourceParts.push(sourceLabel(latestPpt));
  }
  if (priorConcall) {
    parts.push(
      `=== PRIOR CONCALL (${priorConcall.period || "undated"}) — for QoQ comparison ===\n${materialBodyForLlm(priorConcall, { charLimit: 10_000 })}`,
    );
  }

  const corpus = parts.join("\n\n");
  if (corpus.replace(/\s/g, "").length < 80) return null;

  const hash = [
    latestConcall?.updated_at,
    latestPpt?.updated_at,
    priorConcall?.updated_at,
    corpus.length,
  ].join("|");

  return { corpus, hash, sources: sourceParts.join(" · ") };
}
