"use client";

import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";

export default function HomePage() {
  return (
    <Suspense fallback={<div className="boot">Loading…</div>}>
      <AppShell />
    </Suspense>
  );
}
