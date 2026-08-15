"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  QuantNewsCompany,
  QuantNewsCompanyIn,
  QuantNewsdeskResult,
} from "@/lib/agents/newsdesk-types";

export type QuantNewsStats = {
  headlines: number;
  netTone: number;
  names: number;
};

/** Fetch Newsdesk headlines for Quant hits — UI is tags on the table, not a list. */
export function useQuantNewsdesk(
  companies: QuantNewsCompanyIn[],
  scanned: boolean,
  onStats?: (stats: QuantNewsStats | null, loading: boolean) => void,
): {
  byTicker: Record<string, QuantNewsCompany>;
  loading: boolean;
} {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QuantNewsdeskResult | null>(null);

  const key = companies
    .map((c) => c.ticker.toUpperCase())
    .sort()
    .join(",");

  useEffect(() => {
    if (!scanned || !companies.length) {
      setResult(null);
      setLoading(false);
      onStats?.(null, false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    onStats?.(null, true);

    void fetch("/api/quant/news", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companies }),
    })
      .then(async (res) => {
        const json = (await res.json()) as QuantNewsdeskResult & {
          ok?: boolean;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || json.ok === false) {
          setResult(null);
          onStats?.(null, false);
          return;
        }
        setResult(json);
        const withNews = json.companies.filter((c) => c.headlines.length).length;
        onStats?.(
          {
            headlines: json.headlines,
            netTone: json.netTone,
            names: withNews,
          },
          false,
        );
      })
      .catch(() => {
        if (cancelled) return;
        setResult(null);
        onStats?.(null, false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // companies identity is `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scanned]);

  const byTicker = useMemo(() => {
    const map: Record<string, QuantNewsCompany> = {};
    for (const c of result?.companies ?? []) {
      map[c.ticker.toUpperCase()] = c;
    }
    return map;
  }, [result]);
  return { byTicker, loading };
}
