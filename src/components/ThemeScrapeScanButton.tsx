"use client";

import { useCallback, useState } from "react";

type ScrapeApi = {
  rows?: unknown[];
  scrape?: {
    tried: number;
    saved: number;
    remaining: number;
    sector_pool: number;
  };
  error?: string;
  [key: string]: unknown;
};

type Props = {
  /** Base query params (scan, themes, market, etc.). */
  params: URLSearchParams;
  disabled?: boolean;
  label?: string;
  onProgress?: (detail: string | null) => void;
  onBatch: (json: ScrapeApi) => void;
  onDone?: () => void;
};

async function fetchScrapeBatch(params: URLSearchParams): Promise<ScrapeApi> {
  const p = new URLSearchParams(params);
  p.set("dynamicScrape", "1");
  p.set("scrapeLimit", "3");
  let res: Response;
  try {
    res = await fetch(`/api/companies?${p}`);
  } catch {
    throw new Error("Network error — is the dev server running?");
  }
  const raw = await res.text();
  if (!raw.trim()) throw new Error(`Empty response (${res.status})`);
  let json: ScrapeApi;
  try {
    json = JSON.parse(raw) as ScrapeApi;
  } catch {
    throw new Error(`Invalid JSON (${res.status})`);
  }
  if (!res.ok) {
    throw new Error(
      typeof json.error === "string" ? json.error : `Scan failed (${res.status})`,
    );
  }
  return json;
}

export function ThemeScrapeScanButton({
  params,
  disabled,
  label = "Scan",
  onProgress,
  onBatch,
  onDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (disabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      let remaining = 1;
      let round = 0;
      let prevRemaining = Number.POSITIVE_INFINITY;
      while (remaining > 0 && round < 8) {
        onProgress?.(
          remaining === 1 && round === 0
            ? "Scraping sector matches…"
            : `${remaining} left to scrape`,
        );
        const json = await fetchScrapeBatch(params);
        onBatch(json);
        if (!json.scrape || json.scrape.tried === 0) break;
        remaining = json.scrape.remaining;
        if (remaining >= prevRemaining && json.scrape.saved === 0) break;
        prevRemaining = remaining;
        round += 1;
      }
      onProgress?.(null);
      await onDone?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Scan failed";
      setError(msg);
      onProgress?.(null);
    } finally {
      setBusy(false);
    }
  }, [busy, disabled, onBatch, onDone, onProgress, params]);

  return (
    <div className="theme-scrape-scan-wrap">
      <button
        type="button"
        className="btn-scan-theme"
        disabled={disabled || busy}
        onClick={() => void run()}
        title="Scrape theme-sector websites and refresh matches"
      >
        {busy ? "Scanning…" : label}
      </button>
      {error ? <span className="theme-scrape-scan-error">{error}</span> : null}
    </div>
  );
}
