"use client";

import { useEffect, useState } from "react";
import type {
  ConcallDriftContext,
  ConcallDriftReview,
} from "@/lib/concall-drift-review";

export type ExpandConcallDriftData = {
  review: ConcallDriftReview | null;
  loading: boolean;
  error: string | null;
  setupHint: string | null;
};

export function useExpandConcallDrift(
  ticker: string,
  price: number | null | undefined,
  drift: ConcallDriftContext | null | undefined,
  enabled: boolean,
  materialsRev = 0,
): ExpandConcallDriftData {
  const [review, setReview] = useState<ConcallDriftReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupHint, setSetupHint] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !ticker || !drift?.earn_at) {
      setReview(null);
      setLoading(false);
      setError(null);
      setSetupHint(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSetupHint(null);

    void fetch("/api/concall-drift-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker,
        price: price != null && Number.isFinite(price) ? price : null,
        drift,
      }),
      signal: AbortSignal.timeout(120_000),
    })
      .then(async (r) => {
        const text = await r.text();
        if (cancelled) return;
        if (!text.trim()) {
          setReview(null);
          setError("Empty response from server — try again");
          return;
        }
        let j: {
          ok?: boolean;
          review?: ConcallDriftReview | null;
          error?: string;
          hint?: string;
        };
        try {
          j = JSON.parse(text) as typeof j;
        } catch {
          setReview(null);
          setError("Invalid server response — try again");
          return;
        }
        if (!r.ok || !j.ok || !j.review) {
          setReview(null);
          const msg = j.error || "Could not analyze concall";
          setError(
            /unexpected end|incomplete json/i.test(msg)
              ? "AI response was cut off — try again"
              : msg,
          );
          setSetupHint(j.hint ?? null);
          return;
        }
        setReview(j.review);
      })
      .catch((err) => {
        if (!cancelled) {
          setReview(null);
          setError(
            err instanceof Error && /timeout|aborted/i.test(err.message)
              ? "Concall analysis timed out — try again"
              : "Network error — could not load concall review",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    ticker,
    price,
    drift?.earn_at,
    drift?.concall_at,
    drift?.drift_pct,
    drift?.baseline_close,
    drift?.earn_subject,
    drift?.quarter_fy,
    materialsRev,
  ]);

  return { review, loading, error, setupHint };
}
