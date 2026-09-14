"use client";

import { Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AppChrome } from "@/components/AppChrome";
import { FundPanel } from "@/components/FundPanel";
import { useAuth } from "@/lib/auth";

function FundBody() {
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
      <FundPanel />
    </AppChrome>
  );
}

export default function FundPage() {
  return (
    <Suspense fallback={<div className="boot">Loading…</div>}>
      <FundBody />
    </Suspense>
  );
}
