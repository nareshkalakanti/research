"use client";

import { NapkinLink } from "@/components/NapkinLink";

/** NP (Napkin) chip — TradingView is the ticker/name link, not a second chip. */
export function StockLinks({ ticker }: { ticker: string; market?: string | null }) {
  return <NapkinLink ticker={ticker} />;
}
