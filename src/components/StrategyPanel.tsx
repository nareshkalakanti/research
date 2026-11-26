"use client";

import dynamic from "next/dynamic";
import { Loading } from "@/components/Loading";

const ScanPanel = dynamic(() => import("@/components/ScanPanel").then((m) => m.ScanPanel), {
  loading: () => <Loading variant="block" />,
  ssr: false,
});

/** Strategy tab: signal scans (BB / TQ / EMA / RSI). */
export function StrategyPanel() {
  return (
    <div className="strategy-panel">
      <ScanPanel />
    </div>
  );
}
