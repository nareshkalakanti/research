"use client";

import { napkinUrl } from "@/lib/links";

/** NP (Napkin) chip — TradingView is the ticker/name link, not a second chip. */
export function StockLinks({ ticker }: { ticker: string; market?: string | null }) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <a
      className="np-chip"
      href={napkinUrl(ticker)}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${ticker} in Napkin`}
      onClick={stop}
    >
      NP
    </a>
  );
}
