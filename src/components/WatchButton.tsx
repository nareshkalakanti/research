"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  isWatched,
  subscribeWatchlist,
  toggleWatch,
} from "@/lib/user-watchlist";

/**
 * Dashed "+ WATCH" / filled "SAVED" chip next to a ticker.
 * Toggle saves to personal watchlist; click SAVED again can open /watchlist
 * when `openOnSaved` is true (default: false — second click unwatches).
 */
export function WatchButton({
  ticker,
  openWatchlistOnSavedClick = false,
  className,
}: {
  ticker: string | null | undefined;
  /** If true, clicking when already watched navigates to /watchlist instead of removing. */
  openWatchlistOnSavedClick?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const sym = (ticker || "").trim().toUpperCase();
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!sym) {
      setOn(false);
      return;
    }
    setOn(isWatched(sym));
    return subscribeWatchlist(() => setOn(isWatched(sym)));
  }, [sym]);

  if (!sym || /^BSE\d{5,6}$/i.test(sym) || /^\d{5,6}$/.test(sym)) {
    return null;
  }

  return (
    <button
      type="button"
      className={`watch-btn${on ? " is-on" : ""}${className ? ` ${className}` : ""}`}
      title={on ? "On your watchlist — click to remove" : "Add to watchlist"}
      aria-pressed={on}
      aria-label={on ? `Remove ${sym} from watchlist` : `Watch ${sym}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (on && openWatchlistOnSavedClick) {
          router.push("/watchlist");
          return;
        }
        setOn(toggleWatch(sym));
      }}
    >
      {on ? (
        <>
          <span className="watch-btn-mark" aria-hidden>
            ★
          </span>
          Saved
        </>
      ) : (
        <>
          <span className="watch-btn-mark" aria-hidden>
            +
          </span>
          Watch
        </>
      )}
    </button>
  );
}
