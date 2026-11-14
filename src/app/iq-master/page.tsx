"use client";

import { Loading } from "@/components/Loading";
import { Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";

/** IQMaster removed — keep bookmarks working. */
export default function IqMasterRedirectPage() {
  return (
    <Suspense fallback={<Loading variant="page" />}>
      <Redirect />
    </Suspense>
  );
}

function Redirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/watchlist");
  }, [router]);
  return <div className="boot">Redirecting to Watchlist…</div>;
}
