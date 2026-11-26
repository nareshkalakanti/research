"use client";

import dynamic from "next/dynamic";
import { Loading } from "@/components/Loading";
import { useUrlEnumParam } from "@/lib/url-enum-param";

const ScanPanel = dynamic(() => import("@/components/ScanPanel").then((m) => m.ScanPanel), {
  loading: () => <Loading variant="block" />,
  ssr: false,
});
const Ipo2Panel = dynamic(() => import("@/components/Ipo2Panel").then((m) => m.Ipo2Panel), {
  loading: () => <Loading variant="block" />,
  ssr: false,
});

const Ipo2RulesPanel = dynamic(() => import("@/components/Ipo2RulesPanel").then((m) => m.Ipo2RulesPanel), {
  loading: () => <Loading variant="block" />,
  ssr: false,
});

const VIEWS = ["signals", "ipo2", "ipo2rules"] as const;

/** Strategy tab: signal scans (BB / TQ / EMA / RSI), the IPO2 (IPO V2.0) base-and-entry screen and its rules. */
export function StrategyPanel() {
  const [view, setView] = useUrlEnumParam("strat", VIEWS, "signals");
  return (
    <div className="strategy-panel">
      <div className="vx-tabs strategy-views" role="tablist" aria-label="Strategy views">
        {(
          [
            ["signals", "Signals"],
            ["ipo2", "IPO2"],
            ["ipo2rules", "IPO V2.0 rules"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? "on" : ""} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </div>
      {view === "ipo2" ? <Ipo2Panel /> : view === "ipo2rules" ? <Ipo2RulesPanel /> : <ScanPanel />}
    </div>
  );
}
