/**
 * Detect preferential issue / allotment filings from category + subject text.
 * Client-safe (no fs) — used by MarketIQ topic chip.
 */

/** Scored / LDR category labels already in the preferential family. */
const CATEGORY_RE =
  /^preferential(?:\s+(?:allotment|issue|issuance|offer))?$|^preferential\s+allotment$|^preferential\s+issue$/i;

const SUBJECT_RE =
  /\bpreferential\s+(?:allotment|issue|issuance|basis|offer)\b|\bissue\s+of\s+(?:equity\s+)?shares?\s+on\s+a?\s*preferential\s+basis\b|\ballotment\s+of\s+(?:equity\s+)?shares?\s+on\s+a?\s*preferential\s+basis\b|\bwarrants?\s+.*\bpreferential\b|\bpreferential\s+allot(?:ment|tee)s?\b/i;

/** True for preferential allotment / issue capital-raise announcements. */
export function isPreferentialAnnouncement(
  ...parts: Array<string | null | undefined>
): boolean {
  const blob = parts
    .map((p) => (p || "").trim())
    .filter(Boolean)
    .join("\n");
  if (!blob) return false;

  const category = (parts[0] || "").trim();
  if (category && CATEGORY_RE.test(category)) return true;
  if (category && /\bpreferential\b/i.test(category)) return true;

  return SUBJECT_RE.test(blob);
}
