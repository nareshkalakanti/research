/** Client-safe Gov/CPSU ratna labels (no fs). */

export type GovRatnaTier =
  | "maharatna"
  | "navratna"
  | "miniratna_i"
  | "miniratna_ii"
  | "non_ratna"
  | "psu_bank"
  | "state_psu";

export const GOV_RATNA_TIERS: GovRatnaTier[] = [
  "maharatna",
  "navratna",
  "miniratna_i",
  "miniratna_ii",
  "non_ratna",
  "psu_bank",
  "state_psu",
];

export const GOV_RATNA_LABELS: Record<GovRatnaTier, string> = {
  maharatna: "Maharatna",
  navratna: "Navratna",
  miniratna_i: "Miniratna I",
  miniratna_ii: "Miniratna II",
  non_ratna: "Non-Ratna",
  psu_bank: "PSU Bank",
  state_psu: "State PSU",
};

export const GOV_RATNA_SHORT: Record<GovRatnaTier, string> = {
  maharatna: "Maha",
  navratna: "Nav",
  miniratna_i: "Mini-I",
  miniratna_ii: "Mini-II",
  non_ratna: "Non-R",
  psu_bank: "Bank",
  state_psu: "State",
};
