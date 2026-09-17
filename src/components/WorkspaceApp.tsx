"use client";

import dynamic from "next/dynamic";

export const WorkspaceApp = dynamic(
  () => import("@/components/AppShell").then((m) => m.AppShell),
  { ssr: false, loading: () => <div className="boot">Loading…</div> },
);
