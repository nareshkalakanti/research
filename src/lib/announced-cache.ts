/** In-process TTL cache for live NSE/BSE announced pulls. */

type Entry = { at: number; data: unknown };

const store = new Map<string, Entry>();

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min

export function announcedCacheGet<T>(key: string, ttlMs = DEFAULT_TTL_MS): T | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    store.delete(key);
    return null;
  }
  return hit.data as T;
}

export function announcedCacheSet(key: string, data: unknown): void {
  store.set(key, { at: Date.now(), data });
}

export function announcedCacheKey(
  lane: "marketiq" | "orderbook" | "boardroom",
  days: number,
  q?: string | null,
): string {
  return `${lane}|d=${days}|q=${(q || "").trim().toLowerCase()}`;
}
