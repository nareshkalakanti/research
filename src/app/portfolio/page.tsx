"use client";

import { Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AppChrome } from "@/components/AppChrome";
import { AppTabProvider } from "@/lib/app-tab";
import { useAuth } from "@/lib/auth";
import { HoldingsMvPanel } from "@/components/HoldingsMvPanel";

function Gate() {
  const { user, ready } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, user, router]);
  if (!ready || !user) return <div className="boot">Loading…</div>;
  return (
    <AppTabProvider>
      <AppChrome>
        <HoldingsMvPanel />
      </AppChrome>
    </AppTabProvider>
  );
}

export default function PortfolioPage() {
  return (
    <Suspense fallback={<div className="boot">Loading…</div>}>
      <Gate />
    </Suspense>
  );
}
