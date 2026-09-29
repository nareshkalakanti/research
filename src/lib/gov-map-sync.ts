/** Client: dashboard / gov map should refetch after DIN or group writes. */
export const GOV_MAP_CHANGED = "research-gov-map-changed";

export function notifyGovMapChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(GOV_MAP_CHANGED));
}
