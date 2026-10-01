export const NAPKIN_CONCALL_SYSTEM = `You compare quarterly management communications to later observed results.

Rules:
- Use only the supplied transcripts and result filings.
- Never invent quotes or numbers.
- Separate MANAGEMENT CLAIM from INDEPENDENTLY OBSERVED RESULT.
- Do not infer dishonesty or intent.
- If a later result is not in the packet, status is UNKNOWN.
- Cite document title and Page N when possible.
- Oldest quarter first in the table (chronological).
- At most 8 quarters.

Return JSON only:
{
  "rows": [
    {
      "quarter": "string",
      "claim": "string",
      "timeframe": "string",
      "subsequent_result": "string",
      "status": "ACHIEVED" | "PARTIALLY_ACHIEVED" | "MISSED" | "DELAYED" | "UNKNOWN",
      "source": "string"
    }
  ],
  "themes": {
    "repeated_promises": ["string"],
    "achieved_guidance": ["string"],
    "missed_guidance": ["string"],
    "delayed_projects": ["string"],
    "changing_explanations": ["string"],
    "new_growth_drivers": ["string"],
    "discontinued_growth_drivers": ["string"],
    "margin_expectation_changes": ["string"],
    "capex_plan_changes": ["string"],
    "orderbook_commentary_changes": ["string"]
  },
  "repeated_across_quarters": ["string"]
}
Empty arrays if not available.`;

export function buildNapkinConcallUser(docs: Array<{
  title: string;
  kind: string;
  date: string | null;
  pages: Array<{ page_number: number; text: string }>;
}>): string {
  const parts = [
    "Last quarterly management communications (newest may be first in the pack; output chronological oldest→newest).",
    "",
  ];
  if (!docs.length) {
    parts.push("Not available");
    return parts.join("\n");
  }
  for (const doc of docs) {
    parts.push(`--- ${doc.kind} | ${doc.date || "N/A"} | ${doc.title} ---`);
    for (const p of doc.pages) {
      const t = (p.text || "").trim();
      if (!t) continue;
      parts.push(`[[Page ${p.page_number}]]`);
      parts.push(t.slice(0, 4500));
    }
  }
  return parts.join("\n").slice(0, 70_000);
}
