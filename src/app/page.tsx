"use client";

import { Suspense } from "react";
import { WorkspaceApp } from "@/components/WorkspaceApp";

/**
 * Keep Suspense for useSearchParams children, but never swap the whole shell
 * for a page loader — Next 16.3 pushState restores could flash that fallback
 * (title → URL flicker). Null fallback keeps the chrome mounted.
 */
export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceApp />
    </Suspense>
  );
}
