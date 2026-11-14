"use client";

import { Loading } from "@/components/Loading";
import type { ReactNode } from "react";
import { QuarterPanel } from "@/components/QuarterPanel";
import type { ExpandQuarterData } from "@/lib/use-expand-quarters";

type Props = {
  data: ExpandQuarterData;
  price?: number | null;
  compact?: boolean;
  headExtra?: ReactNode;
  richQoq?: boolean;
};

function sourceLabel(source: string | null): string | null {
  if (!source || source === "yahoo") return null;
  if (source === "yahoo+screener") {
    return "Consolidated P&L from Screener.in (cached 7d) · OP matches Screener";
  }
  if (source === "screener") return "Quarterly from Screener.in consolidated (cached 7d)";
  if (source === "groww") return "Quarterly from Groww (₹ Cr)";
  return `Source: ${source}`;
}

export function ExpandQuarters({
  data,
  price,
  compact = false,
  headExtra,
  richQoq = false,
}: Props) {
  const { panel, yoy, source, loading, error } = data;

  if (loading) {
    return <Loading label="Loading quarterly" variant="inline" />;
  }
  if (error) {
    return <p className="q-empty">{error}</p>;
  }
  if (!panel?.labels?.length) {
    return <p className="q-empty">No quarterly data available.</p>;
  }

  const sourceNote = compact ? null : sourceLabel(source);

  return (
    <div className="about-quarters">
      <QuarterPanel
        panel={panel}
        yoy={yoy}
        price={price}
        sourceNote={sourceNote}
        compact={compact}
        headExtra={headExtra}
        richQoq={richQoq}
      />
    </div>
  );
}
