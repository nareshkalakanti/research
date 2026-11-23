"use client";

import { useEffect } from "react";
import { Loading } from "@/components/Loading";

/** Legacy path — workspace tabs live on `/?tab=dashboard` to avoid remount flicker. */
export default function DashboardRedirectPage() {
  useEffect(() => {
    window.location.replace("/?tab=dashboard");
  }, []);
  return <Loading variant="page" label="Opening Dashboard" />;
}
