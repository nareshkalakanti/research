import type { ConcallDocLinks } from "./concall-drift-types";

export type HighlightMaterial = {
  kind: string;
  source_url?: string | null;
  brief_text?: string | null;
  raw_text?: string | null;
};

const SKIP =
  /not disclosed|insufficient|concall filed|transcript not filed|financial results|outcome of board|unclear|no capex guidance|no explicit/i;

function clipFact(raw: string): string | null {
  let t = raw
    .replace(/\s+/g, " ")
    .replace(/^[•\-\*–]\s*/, "")
    .replace(/^(Capability|Growth|CAPEX|Summary):\s*/i, "")
    .trim();
  if (t.length < 12 || SKIP.test(t)) return null;
  if (t.length > 88) t = `${t.slice(0, 86).replace(/\s+\S*$/, "")}…`;
  return t;
}

function pushFact(out: string[], raw: string): void {
  const t = clipFact(raw);
  if (!t) return;
  if (out.some((x) => x.toLowerCase() === t.toLowerCase())) return;
  out.push(t);
}

function splitClauses(text: string): string[] {
  return text
    .split(/[·•;]|(?<=\d%)\s+(?=[A-Z₹])|(?<=cr)\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function factLike(s: string): boolean {
  return /₹|\d+\s*%|\bcr\b|\byoy\b|\bq[1-4]\b|commission|debt|margin|guidance|capex|order book|capacity|roa|roe|expansion/i.test(
    s,
  );
}

/** Short call takeaways for the Highlights column (₹ / % / capex facts). */
export function highlightsFromMaterials(materials: HighlightMaterial[]): string[] {
  const out: string[] = [];
  const briefs = materials
    .map((m) => (m.brief_text || "").trim())
    .filter((t) => t && !t.startsWith("[pending]"));

  for (const brief of briefs) {
    const growth = brief.match(/^Growth:\s*(.+)$/im);
    if (growth) {
      for (const part of splitClauses(growth[1]!)) pushFact(out, part);
    }
    const capex = brief.match(/^CAPEX:\s*(.+)$/im);
    if (capex) pushFact(out, capex[1]!);
    const cap = brief.match(/^Capability:\s*(.+)$/im);
    if (cap && factLike(cap[1]!)) pushFact(out, cap[1]!);
    if (out.length >= 3) return out.slice(0, 3);
  }

  for (const brief of briefs) {
    const summary = brief.split(/\n/)[0] || "";
    for (const sent of summary.split(/(?<=[.!?])\s+/)) {
      if (factLike(sent)) pushFact(out, sent);
      if (out.length >= 3) return out.slice(0, 3);
    }
  }

  return out.slice(0, 3);
}

export function docsFromMaterials(materials: HighlightMaterial[]): ConcallDocLinks {
  const url = (m: HighlightMaterial | undefined) => m?.source_url?.trim() || null;
  const transcript = materials.find(
    (m) => m.kind === "concall" || m.kind === "transcript",
  );
  const ppt = materials.find((m) => m.kind === "ppt");
  const results = materials.find((m) => m.kind === "other");
  return {
    summary: url(results) || url(transcript) || url(ppt),
    transcript: url(transcript),
    ppt: url(ppt),
  };
}
