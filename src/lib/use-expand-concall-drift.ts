"use client";

import { useEffect, useRef, useState } from "react";
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

/**
 * Loads concall-drift review when expanded. Minimise must not cancel or clear —
 * the request keeps running and results land when ready.
 */
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
  const genRef = useRef(0);
  const paramsRef = useRef({
    ticker,
    price,
    materialsRev,
    earn_at: drift?.earn_at,
    concall_at: drift?.concall_at,
    drift_pct: drift?.drift_pct,
    baseline_close: drift?.baseline_close,
    earn_subject: drift?.earn_subject,
    quarter_fy: drift?.quarter_fy,
  });

  useEffect(() => {
    const next = {
      ticker,
      price,
      materialsRev,
      earn_at: drift?.earn_at,
      concall_at: drift?.concall_at,
      drift_pct: drift?.drift_pct,
      baseline_close: drift?.baseline_close,
      earn_subject: drift?.earn_subject,
      quarter_fy: drift?.quarter_fy,
    };
    const prev = paramsRef.current;
    const changed =
      prev.ticker !== next.ticker ||
      prev.price !== next.price ||
      prev.materialsRev !== next.materialsRev ||
      prev.earn_at !== next.earn_at ||
      prev.concall_at !== next.concall_at ||
      prev.drift_pct !== next.drift_pct ||
      prev.baseline_close !== next.baseline_close ||
      prev.earn_subject !== next.earn_subject ||
      prev.quarter_fy !== next.quarter_fy;
    paramsRef.current = next;
    if (!changed) return;
    genRef.current += 1;
    if (!ticker || !drift?.earn_at) {
      setReview(null);
      setLoading(false);
      setError(null);
      setSetupHint(null);
    }
  }, [
    ticker,
    price,
    materialsRev,
    drift?.earn_at,
    drift?.concall_at,
    drift?.drift_pct,
    drift?.baseline_close,
    drift?.earn_subject,
    drift?.quarter_fy,
  ]);

  useEffect(() => {
    if (!enabled || !ticker || !drift?.earn_at) return;

    const gen = ++genRef.current;
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
        if (gen !== genRef.current) return;
        if (!text.trim()) {
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
          setError("Invalid server response — try again");
          return;
        }
        if (!r.ok || !j.ok || !j.review) {
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
        if (gen !== genRef.current) return;
        setError(
          err instanceof Error && /timeout|aborted/i.test(err.message)
            ? "Concall analysis timed out — try again"
            : "Network error — could not load concall review",
        );
      })
      .finally(() => {
        if (gen === genRef.current) setLoading(false);
      });
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
