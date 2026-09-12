"use client";

import { Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AppChrome } from "@/components/AppChrome";
import { OrderTrackerPanel } from "@/components/OrderTrackerPanel";
import { useAuth } from "@/lib/auth";

function OrderTrackerBody() {
  const { user, ready } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, user, router]);

  if (!ready || !user) {
    return <div className="boot">Loading…</div>;
  }

  return (
    <AppChrome layout="tracker">
      <OrderTrackerPanel standalone />
    </AppChrome>
  );
}

export default function OrderTrackerPage() {
  return (
    <Suspense fallback={<div className="boot">Loading…</div>}>
      <OrderTrackerBody />
    </Suspense>
  );
}
