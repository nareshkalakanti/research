/**
 * PEAD result-date seasons (India earnings calendar, no issuer facts).
 * Q2 prints → Oct–Dec, Q3 → Jan–Mar, Q4 → Apr–Jun, Q1 → Jul–Sep.
 */

export type PeadSeasonId = "current" | "all" | "prev";

export type PeadSeasonBounds = {
  id: PeadSeasonId;
  label: string;
  /** Inclusive YYYY-MM-DD, or null when unbounded. */
  from: string | null;
  /** Inclusive YYYY-MM-DD, or null when unbounded. */
  to: string | null;
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function seasonBoundsForMonth(
  year: number,
  month1to12: number,
): { from: string; to: string; label: string } {
  if (month1to12 >= 10) {
    return {
      from: `${year}-10-01`,
      to: `${year}-12-31`,
      label: `Oct–Dec ${year}`,
    };
  }
  if (month1to12 >= 7) {
    return {
      from: `${year}-07-01`,
      to: `${year}-09-30`,
      label: `Jul–Sep ${year}`,
    };
  }
  if (month1to12 >= 4) {
    return {
      from: `${year}-04-01`,
      to: `${year}-06-30`,
      label: `Apr–Jun ${year}`,
    };
  }
  return {
    from: `${year}-01-01`,
    to: `${year}-03-31`,
    label: `Jan–Mar ${year}`,
  };
}

/** Season containing `asOf` (default: today UTC). */
export function currentPeadSeasonBounds(
  asOf: Date = new Date(),
): PeadSeasonBounds {
  const y = asOf.getUTCFullYear();
  const m = asOf.getUTCMonth() + 1;
  const b = seasonBoundsForMonth(y, m);
  return { id: "current", label: b.label, from: b.from, to: b.to };
}

/** Immediately previous season (for “Prev season” chip). */
export function previousPeadSeasonBounds(
  asOf: Date = new Date(),
): PeadSeasonBounds {
  const cur = currentPeadSeasonBounds(asOf);
  if (!cur.from) {
    return { id: "prev", label: "Prev season", from: null, to: null };
  }
  const start = new Date(`${cur.from}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 1);
  const b = seasonBoundsForMonth(start.getUTCFullYear(), start.getUTCMonth() + 1);
  return { id: "prev", label: b.label, from: b.from, to: b.to };
}

export function peadSeasonBounds(
  id: PeadSeasonId | string | null | undefined,
  asOf: Date = new Date(),
): PeadSeasonBounds {
  const key = (id || "current").trim().toLowerCase();
  if (key === "all") {
    return { id: "all", label: "All dates", from: null, to: null };
  }
  if (key === "prev") return previousPeadSeasonBounds(asOf);
  return currentPeadSeasonBounds(asOf);
}

/** True when result_date is inside [from, to] (inclusive). Null date never matches a bounded season. */
export function resultDateInPeadSeason(
  resultDate: string | null | undefined,
  bounds: Pick<PeadSeasonBounds, "from" | "to">,
): boolean {
  if (!bounds.from && !bounds.to) return true;
  const d = (resultDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  if (bounds.from && d < bounds.from) return false;
  if (bounds.to && d > bounds.to) return false;
  return true;
}

export function parsePeadSeasonParam(
  raw: string | null | undefined,
): PeadSeasonId {
  const key = (raw || "current").trim().toLowerCase();
  if (key === "all" || key === "prev" || key === "current") return key;
  return "current";
}

/** Debug / labels — today as ISO day. */
export function peadSeasonAsOfDay(asOf: Date = new Date()): string {
  return isoDay(asOf);
}
