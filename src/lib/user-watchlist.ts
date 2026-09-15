/**
 * Personal stock watchlist (browser localStorage).
 * Not fund/edge curated lists — user pins only.
 */

const STORAGE_KEY = "research.user_watchlist.v1";

export type UserWatchlistState = {
  tickers: string[];
  updated_at: string;
};

function empty(): UserWatchlistState {
  return { tickers: [], updated_at: new Date().toISOString() };
}

function normalize(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function readRaw(): UserWatchlistState {
  if (typeof window === "undefined") return empty();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<UserWatchlistState>;
    const tickers = Array.isArray(parsed.tickers)
      ? [
          ...new Set(
            parsed.tickers
              .map((t) => (typeof t === "string" ? normalize(t) : ""))
              .filter(Boolean),
          ),
        ]
      : [];
    return {
      tickers,
      updated_at:
        typeof parsed.updated_at === "string"
          ? parsed.updated_at
          : new Date().toISOString(),
    };
  } catch {
    return empty();
  }
}

function writeRaw(state: UserWatchlistState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.dispatchEvent(
      new CustomEvent("research:watchlist", { detail: state }),
    );
  } catch {
    /* quota / private mode */
  }
}

export function listWatchedTickers(): string[] {
  return readRaw().tickers;
}

export function isWatched(ticker: string | null | undefined): boolean {
  const t = normalize(ticker || "");
  if (!t) return false;
  return readRaw().tickers.includes(t);
}

export function addWatch(ticker: string): UserWatchlistState {
  const t = normalize(ticker);
  const cur = readRaw();
  if (!t || cur.tickers.includes(t)) return cur;
  const next = {
    tickers: [t, ...cur.tickers],
    updated_at: new Date().toISOString(),
  };
  writeRaw(next);
  return next;
}

export function removeWatch(ticker: string): UserWatchlistState {
  const t = normalize(ticker);
  const cur = readRaw();
  const next = {
    tickers: cur.tickers.filter((x) => x !== t),
    updated_at: new Date().toISOString(),
  };
  writeRaw(next);
  return next;
}

/** Returns whether the ticker is watched after the toggle. */
export function toggleWatch(ticker: string): boolean {
  const t = normalize(ticker);
  if (!t) return false;
  if (isWatched(t)) {
    removeWatch(t);
    return false;
  }
  addWatch(t);
  return true;
}

export function subscribeWatchlist(
  listener: (state: UserWatchlistState) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    listener(readRaw());
  };
  const onCustom = () => listener(readRaw());
  window.addEventListener("storage", onStorage);
  window.addEventListener("research:watchlist", onCustom);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("research:watchlist", onCustom);
  };
}
