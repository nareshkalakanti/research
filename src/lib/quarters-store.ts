/**
 * Quarterly P&L panel — fetch on demand (no disk cache).
 */
import { fetchQuarterlyFundamentals } from "./yahoo-quarters";
import { buildQuarterPanel, type QuarterPanel } from "./quarter-panel";

export async function getQuarterPanel(
  ticker: string,
  market?: string | null,
): Promise<{
  panel: QuarterPanel | null;
  cached: boolean;
  source: string | null;
  symbol: string;
}> {
  const { quarters, symbol, source } = await fetchQuarterlyFundamentals(ticker, market);
  const panel = buildQuarterPanel(quarters);
  return {
    panel,
    cached: false,
    source,
    symbol,
  };
}
