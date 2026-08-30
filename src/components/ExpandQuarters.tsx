"use client";

import { QuarterPanel } from "@/components/QuarterPanel";
import type { ExpandQuarterData } from "@/lib/use-expand-quarters";

type Props = {
  data: ExpandQuarterData;
  price?: number | null;
};

export function ExpandQuarters({ data, price }: Props) {
  const { panel, yoy, loading, error } = data;

  if (loading) {
    return <p className="q-empty">Loading quarterly…</p>;
  }
  if (error) {
    return <p className="q-empty">{error}</p>;
  }
  if (!panel?.labels?.length) {
    return <p className="q-empty">No quarterly data available.</p>;
  }

  return (
    <div className="about-quarters">
      <QuarterPanel panel={panel} yoy={yoy} price={price} />
    </div>
  );
}
