const FOCUS_TICKER_KEY = "research_focus_ticker";

export function writeFocusTicker(ticker: string): void {
  if (typeof window === "undefined") return;
  const t = ticker.trim().toUpperCase();
  if (!t) return;
  try {
    sessionStorage.setItem(FOCUS_TICKER_KEY, t);
  } catch {
    /* ignore */
  }
}

export function readFocusTicker(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const t = (sessionStorage.getItem(FOCUS_TICKER_KEY) || "").trim().toUpperCase();
    return t || null;
  } catch {
    return null;
  }
}

export function tickerFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search).get("ticker");
  const t = (q || "").trim().toUpperCase();
  return t || readFocusTicker();
}
