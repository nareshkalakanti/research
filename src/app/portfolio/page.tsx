"use client";

import { Loading } from "@/components/Loading";
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
  if (!ready || !user) return <Loading variant="page" />;
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
    <Suspense fallback={<Loading variant="page" />}>
      <Gate />
    </Suspense>
  );
}
