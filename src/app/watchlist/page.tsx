"use client";

import { Suspense } from "react";
import { WorkspaceApp } from "@/components/WorkspaceApp";

export default function WatchlistPage() {
  return (
    <Suspense fallback={<div className="boot">Loading…</div>}>
      <WorkspaceApp />
    </Suspense>
  );
}
