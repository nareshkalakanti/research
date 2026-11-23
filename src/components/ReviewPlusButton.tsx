"use client";

import { useCallback, useEffect, useState } from "react";
import { PORTFOLIO_BAG, type ReviewBag } from "@/lib/portfolio-review-types";

type Listener = () => void;

type BagCache = {
  listeners: Set<Listener>;
  cached: Set<string> | null;
  inflight: Promise<Set<string>> | null;
  /** Bumped by each load and local change, so a slower old response can't win. */
  seq: number;
};

const bags = new Map<ReviewBag, BagCache>();

function cacheFor(bag: ReviewBag): BagCache {
  let hit = bags.get(bag);
  if (!hit) {
    hit = { listeners: new Set(), cached: null, inflight: null, seq: 0 };
    bags.set(bag, hit);
  }
  return hit;
}

function notify(bag: ReviewBag) {
  for (const fn of cacheFor(bag).listeners) fn();
}

async function loadReviewSet(bag: ReviewBag, force = false): Promise<Set<string>> {
  const state = cacheFor(bag);
  if (!force && state.cached) return state.cached;
  if (!force && state.inflight) return state.inflight;
  const seq = ++state.seq;
  const req = (async () => {
    const res = await fetch(
      `/api/portfolio-review?tickers=1&bag=${encodeURIComponent(bag)}`,
      { cache: "no-store" },
    );
    const j = (await res.json()) as { ok?: boolean; tickers?: string[] };
    if (!res.ok || j.ok === false) throw new Error("review tickers failed");
    const fresh = new Set((j.tickers ?? []).map((t) => t.toUpperCase()));
    if (seq === state.seq) state.cached = fresh;
    return state.cached ?? fresh;
  })();
  if (!force) state.inflight = req;
  try {
    return await req;
  } finally {
    if (state.inflight === req) state.inflight = null;
  }
}

/** Reload from the server; tell the UI only if the list actually changed. */
function refetchMembership(bag: ReviewBag) {
  const before = cacheFor(bag).cached;
  void loadReviewSet(bag, true)
    .then((after) => {
      const same =
        before != null &&
        before.size === after.size &&
        [...after].every((t) => before.has(t));
      if (!same) notify(bag);
    })
    .catch(() => {});
}

const SYNC_CHANNEL = "portfolio-membership";
let syncChannel: BroadcastChannel | null = null;
let syncStarted = false;

/** Keep open browser tabs in step: on a change elsewhere, and on returning to a tab. */
function startTabSync() {
  if (syncStarted || typeof window === "undefined") return;
  syncStarted = true;
  if ("BroadcastChannel" in window) {
    syncChannel = new BroadcastChannel(SYNC_CHANNEL);
    syncChannel.onmessage = () => refetchMembership(PORTFOLIO_BAG);
  }
  window.addEventListener("focus", () => refetchMembership(PORTFOLIO_BAG));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refetchMembership(PORTFOLIO_BAG);
  });
}

function announceMembershipChange() {
  syncChannel?.postMessage("changed");
}

function subscribeReview(bag: ReviewBag, fn: Listener): () => void {
  startTabSync();
  const state = cacheFor(bag);
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

function markInReview(bag: ReviewBag, tickers: string[]) {
  const state = cacheFor(bag);
  state.seq += 1;
  const next = new Set(state.cached ?? []);
  for (const t of tickers) next.add(t.toUpperCase());
  state.cached = next;
  notify(bag);
}

function markOutOfReview(bag: ReviewBag, ticker: string) {
  const state = cacheFor(bag);
  state.seq += 1;
  const next = new Set(state.cached ?? []);
  next.delete(ticker.toUpperCase());
  state.cached = next;
  notify(bag);
}

/** Subscribe to Portfolio membership changes. */
export function subscribeReviewMembership(
  fn: Listener,
  bag: ReviewBag = PORTFOLIO_BAG,
): () => void {
  return subscribeReview(bag, fn);
}

/** Call after Portfolio add/remove/clear so + chips stay in sync. */
export function invalidateReviewMembership(bag: ReviewBag = PORTFOLIO_BAG): void {
  const state = cacheFor(bag);
  state.cached = null;
  notify(bag);
  void loadReviewSet(bag, true).then(() => notify(bag)).catch(() => {});
  announceMembershipChange();
}

/** Icon-only + / ✓ — toggles Portfolio. No tab switch. */
export function ReviewPlusButton({
  ticker,
  bag = PORTFOLIO_BAG,
}: {
  ticker: string;
  bag?: ReviewBag;
}) {
  const t = ticker.trim().toUpperCase();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  // Always write to the Portfolio page bag.
  const targetBag = PORTFOLIO_BAG;
  void bag;

  const refresh = useCallback(() => {
    if (!t) {
      setOn(false);
      return;
    }
    const state = cacheFor(targetBag);
    if (state.cached) {
      setOn(state.cached.has(t));
      return;
    }
    void loadReviewSet(targetBag)
      .then((s) => setOn(s.has(t)))
      .catch(() => {});
  }, [t, targetBag]);

  useEffect(() => {
    refresh();
    return subscribeReview(targetBag, refresh);
  }, [refresh, targetBag]);

  if (!t || /^BSE\d{5,6}$/i.test(t) || /^\d{5,6}$/.test(t)) return null;

  const label = "Portfolio";

  return (
    <button
      type="button"
      className={`vx-plus${on ? " is-on" : ""}${busy ? " is-busy" : ""}`}
      title={on ? `On ${label} — click to remove` : `Add to ${label}`}
      aria-pressed={on}
      aria-label={on ? `Remove ${t} from ${label}` : `Add ${t} to ${label}`}
      disabled={busy}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (busy) return;
        setBusy(true);
        const removing = on;
        if (removing) {
          markOutOfReview(targetBag, t);
          setOn(false);
        } else {
          markInReview(targetBag, [t]);
          setOn(true);
        }
        void (async () => {
          try {
            const res = await fetch("/api/portfolio-review", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                removing
                  ? { remove: t, bag: targetBag }
                  : { add: [t], bag: targetBag },
              ),
            });
            const j = (await res.json()) as {
              ok?: boolean;
              error?: string;
              found?: string[];
            };
            if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
            if (!removing && j.found?.length) markInReview(targetBag, j.found);
            refetchMembership(targetBag);
            announceMembershipChange();
            // Value / Trend hide Portfolio names — nudge them to refetch.
            window.dispatchEvent(new CustomEvent("portfolio-review-changed"));
          } catch {
            if (removing) {
              markInReview(targetBag, [t]);
              setOn(true);
            } else {
              markOutOfReview(targetBag, t);
              setOn(false);
            }
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      {on ? "✓" : "+"}
    </button>
  );
}

export type { ReviewBag };
