"use client";

import { useCallback, useEffect, useState } from "react";

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: Set<string> | null = null;
let inflight: Promise<Set<string>> | null = null;

function notify() {
  for (const fn of listeners) fn();
}

async function loadReviewSet(force = false): Promise<Set<string>> {
  if (!force && cached) return cached;
  if (!force && inflight) return inflight;
  const req = (async () => {
    const res = await fetch("/api/portfolio-review?tickers=1", { cache: "no-store" });
    const j = (await res.json()) as { ok?: boolean; tickers?: string[] };
    if (!res.ok || j.ok === false) throw new Error("review tickers failed");
    cached = new Set((j.tickers ?? []).map((t) => t.toUpperCase()));
    return cached;
  })();
  if (!force) inflight = req;
  try {
    return await req;
  } finally {
    if (inflight === req) inflight = null;
  }
}

function subscribeReview(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function markInReview(tickers: string[]) {
  const next = new Set(cached ?? []);
  for (const t of tickers) next.add(t.toUpperCase());
  cached = next;
  notify();
}

function markOutOfReview(ticker: string) {
  const next = new Set(cached ?? []);
  next.delete(ticker.toUpperCase());
  cached = next;
  notify();
}

/** Call after Portfolio review add/remove/clear so + chips stay in sync. */
export function invalidateReviewMembership(): void {
  cached = null;
  notify();
  void loadReviewSet(true).then(notify).catch(() => {});
}

/** Icon-only + / ✓ — toggles Value → Portfolio review. No tab switch. */
export function ReviewPlusButton({ ticker }: { ticker: string }) {
  const t = ticker.trim().toUpperCase();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!t) {
      setOn(false);
      return;
    }
    if (cached) {
      setOn(cached.has(t));
      return;
    }
    void loadReviewSet()
      .then((s) => setOn(s.has(t)))
      .catch(() => {});
  }, [t]);

  useEffect(() => {
    refresh();
    return subscribeReview(refresh);
  }, [refresh]);

  if (!t || /^BSE\d{5,6}$/i.test(t) || /^\d{5,6}$/.test(t)) return null;

  return (
    <button
      type="button"
      className={`vx-plus${on ? " is-on" : ""}${busy ? " is-busy" : ""}`}
      title={on ? "On Portfolio review — click to remove" : "Add to Portfolio review"}
      aria-pressed={on}
      aria-label={on ? `Remove ${t} from Portfolio review` : `Add ${t} to Portfolio review`}
      disabled={busy}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (busy) return;
        setBusy(true);
        const removing = on;
        // Optimistic UI — roll back if the request fails.
        if (removing) {
          markOutOfReview(t);
          setOn(false);
        } else {
          markInReview([t]);
          setOn(true);
        }
        void (async () => {
          try {
            const res = await fetch("/api/portfolio-review", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(removing ? { remove: t } : { add: [t] }),
            });
            const j = (await res.json()) as {
              ok?: boolean;
              error?: string;
              found?: string[];
            };
            if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
            if (!removing && j.found?.length) markInReview(j.found);
          } catch {
            if (removing) {
              markInReview([t]);
              setOn(true);
            } else {
              markOutOfReview(t);
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
