/** PDF/fallback labels like "DIN 00023046" or a role with no person name. */
export function isPlaceholderDirectorName(name: string | null | undefined): boolean {
  const t = (name ?? "").trim();
  if (!t) return true;
  if (/^din\s+\d{8}$/i.test(t)) return true;
  const n = t.replace(/[^a-z]+/gi, " ").replace(/\s+/g, " ").trim();
  return /^(managing director|whole time director|executive director|non executive director|independent director|additional director|nominee director|woman director|director|chairperson|chairman|ceo|cfo|company secretary|kmp)$/i.test(
    n,
  );
}
