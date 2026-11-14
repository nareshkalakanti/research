"use client";

import { useMemo } from "react";
import type { FamilyRow } from "@/components/FamilyMapCards";
import { Loading } from "@/components/Loading";
import {
  WatchlistDashboard,
  type DashSourceEntry,
} from "@/components/WatchlistDashboard";

/** Groups smaller than this are single listings, not houses — skip them. */
const MIN_HOUSE_COS = 2;

/**
 * Group signals — the watchlist dashboard (Scan signals → 200 DMA ↑ daily,
 * BB W, TQ W) run over every business-group stock, with the group as "From".
 */
export function GroupSignalsTable({
  rows,
  loading,
  onOpenGroup,
}: {
  rows: FamilyRow[];
  loading?: boolean;
  chartUrl?: (ticker: string) => string;
  onOpenGroup?: (key: string, name: string) => void;
}) {
  const { entries, keyByLabel } = useMemo(() => {
    const groupsByTicker = new Map<string, string[]>();
    const keyByLabel = new Map<string, string>();
    const seen = new Set<string>();
    for (const f of rows) {
      const key = f.group_id || f.family_name;
      if (seen.has(key)) continue;
      seen.add(key);
      const tickers = [
        ...new Set(f.companies.map((c) => c.ticker.trim().toUpperCase())),
      ].filter(Boolean);
      if (tickers.length < MIN_HOUSE_COS) continue;
      keyByLabel.set(f.family_name, key);
      for (const t of tickers) {
        const list = groupsByTicker.get(t);
        if (list) {
          if (!list.includes(f.family_name)) list.push(f.family_name);
        } else {
          groupsByTicker.set(t, [f.family_name]);
        }
      }
    }
    const entries: DashSourceEntry[] = [...groupsByTicker.entries()].map(
      ([ticker, sources]) => ({ ticker, sources }),
    );
    return { entries, keyByLabel };
  }, [rows]);

  if (loading && !rows.length) {
    return <Loading label="Loading business groups" variant="block" />;
  }

  return (
    <WatchlistDashboard
      entries={entries}
      storeKey="group-dash-scan-v1"
      sourceLabel="Group"
      onSource={(label) => onOpenGroup?.(keyByLabel.get(label) ?? label, label)}
    />
  );
}
