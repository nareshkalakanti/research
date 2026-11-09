"use client";

import { NapkinChecklistCard } from "@/components/napkin/NapkinChecklistCard";
import type { NapkinPerformance as Perf } from "@/lib/napkin/performance";

/** Quality screen (was Performance). */
export function NapkinPerformance({
  performance,
  defaultExpanded = false,
}: {
  performance?: Perf | null;
  defaultExpanded?: boolean;
}) {
  return (
    <NapkinChecklistCard
      title="Quality"
      performance={performance}
      defaultExpanded={defaultExpanded}
    />
  );
}
