"use client";

import { useEffect } from "react";
import { useSetAppTab } from "@/lib/app-tab";

/** Legacy link → Micro Monopolies (Board/Top no longer on Trend). */
export function MicrocapHighLowPanel() {
  const setTab = useSetAppTab();
  useEffect(() => {
    setTab("micro-sectors");
  }, [setTab]);
  return <div className="vx-card vx-empty">Opening Micro Monopolies…</div>;
}
