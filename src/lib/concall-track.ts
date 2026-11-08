/** Local tracked tickers for the Track tab (shared key with Drift highlights). */

export const CONCALL_TRACK_PINS_KEY = "concall-drift-pins-v1";

export function loadTrackPins(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CONCALL_TRACK_PINS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed
          .map((t) => String(t || "").trim().toUpperCase())
          .filter(Boolean),
      ),
    ].slice(0, 200);
  } catch {
    return [];
  }
}

export function saveTrackPins(pins: string[]) {
  try {
    localStorage.setItem(
      CONCALL_TRACK_PINS_KEY,
      JSON.stringify(pins.slice(0, 200)),
    );
  } catch {
    /* ignore quota */
  }
}
