"use client";

import { Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AppChrome } from "@/components/AppChrome";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { useAuth } from "@/lib/auth";

function WatchlistBody() {
  const { user, ready } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, user, router]);

  if (!ready || !user) {
    return <div className="boot">Loading…</div>;
  }

  return (
    <AppChrome>
      <WatchlistPanel />
    </AppChrome>
  );
}

export default function WatchlistPage() {
  return (
    <Suspense fallback={<div className="boot">Loading…</div>}>
      <WatchlistBody />
    </Suspense>
  );
}
