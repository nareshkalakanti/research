"use client";

import type { ReactNode } from "react";
import { napkinUrl } from "@/lib/links";

/**
 * NP chip / link: opens Napkin for the ticker in a new browser tab.
 */
export function NapkinLink({
  ticker,
  className = "np-chip",
  title,
  children = "NP",
}: {
  ticker: string;
  className?: string;
  title?: string;
  children?: ReactNode;
}) {
  const t = (ticker || "").trim().toUpperCase();
  return (
    <a
      className={className}
      href={napkinUrl(t)}
      target="_blank"
      rel="noopener noreferrer"
      title={title ?? (t ? `Open ${t} in Napkin` : "Open in Napkin")}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  );
}
