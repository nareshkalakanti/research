"use client";

import { Loading } from "@/components/Loading";
import { Suspense } from "react";
import { WorkspaceApp } from "@/components/WorkspaceApp";

export default function WatchlistPage() {
  return (
    <Suspense fallback={<Loading variant="page" />}>
      <WorkspaceApp />
    </Suspense>
  );
}
