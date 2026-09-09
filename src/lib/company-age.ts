/** Shared age-filter helpers (safe for client + server). */

export const AGE_MIN_PRESETS = [25, 50, 100] as const;

/** Parse ageMin query/body (1–200). Invalid → null. */
export function parseAgeMin(raw: unknown): number | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw.trim())
        : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 1 || i > 200) return null;
  return i;
}

export function parseFoundedYear(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = String(raw).match(/(19|20)\d{2}/);
  if (!m) return null;
  const y = Number(m[0]);
  return y >= 1800 && y <= new Date().getFullYear() ? y : null;
}

export function companyAgeYears(
  foundedYear: number | null,
  asOf = new Date(),
): number | null {
  if (foundedYear == null) return null;
  return asOf.getFullYear() - foundedYear;
}

export function isAgeAtLeast(
  foundedRaw: string | null | undefined,
  minAge: number,
  asOf = new Date(),
): boolean {
  const age = companyAgeYears(parseFoundedYear(foundedRaw), asOf);
  return age != null && age >= minAge;
}
