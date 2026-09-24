/** PDF/fallback labels like "DIN 00023046" — DIN on file, no person name. */
export function isPlaceholderDirectorName(name: string | null | undefined): boolean {
  return /^din\s+\d{8}$/i.test((name ?? "").trim());
}
