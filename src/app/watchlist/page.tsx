"use client";

import { useEffect } from "react";
import { Loading } from "@/components/Loading";

/** Legacy path — workspace tabs live on `/?tab=watchlist` to avoid remount flicker. */
export default function WatchlistRedirectPage() {
  useEffect(() => {
    window.location.replace("/?tab=watchlist");
  }, []);
  return <Loading variant="page" label="Opening Watchlist" />;
}
