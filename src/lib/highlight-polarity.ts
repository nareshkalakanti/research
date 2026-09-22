/**
 * Highlight dot colour from the fact in the headline.
 * Stored LLM polarity is only used when the text itself is ambiguous.
 * Capacity / capex / expansion is not a risk unless delay/cut/miss is stated.
 */

const NEGATIVE_FACT =
  /\b(miss|cut|reset|delay|destock|divest|decline|loss|weak|compress(?:ion)?|headwind|cautious|overrun|under-?util|write[- ]?off|impair)\b/i;

const POSITIVE_FACT =
  /\b(grew|growth|won|win|record|beat|raise|strong|capacit(?:y|ies)|addition|expansion|commission|order inflow|ramp|opportunity|investment|target)\b/i;

export function looksNegativeHighlight(text: string): boolean {
  return NEGATIVE_FACT.test(text);
}

export function looksPositiveHighlight(text: string): boolean {
  return POSITIVE_FACT.test(text);
}

export function polarityFromHighlightText(
  text: string,
  stored?: string | null,
): "positive" | "negative" | "neutral" {
  const t = (text || "").replace(/\s+/g, " ").trim();
  const storedPol = String(stored || "")
    .toLowerCase()
    .replace(/^pos(itive)?$/, "positive")
    .replace(/^neg(ative)?$/, "negative");
  const storedOk =
    storedPol === "positive" ||
    storedPol === "negative" ||
    storedPol === "neutral"
      ? storedPol
      : null;

  const neg = looksNegativeHighlight(t);
  const pos = looksPositiveHighlight(t);
  if (neg && pos) {
    if (/\b(delay|cut|miss|overrun|under-?util)\b/i.test(t)) return "negative";
    return "positive";
  }
  if (neg) return "negative";
  if (pos) return "positive";
  return storedOk ?? "neutral";
}
