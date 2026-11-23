/** Client-safe Portfolio review bag ids (no Node / SQLite). */

export type ReviewBag = "portfolio" | "value" | "rotation" | "dashboard";

/** Dedicated Portfolio page — + on every screen writes here. */
export const PORTFOLIO_BAG: ReviewBag = "portfolio";

export function parseReviewBag(raw: string | null | undefined): ReviewBag {
  if (raw === "rotation" || raw === "dashboard" || raw === "value") return raw;
  return "portfolio";
}
