import { resolveQuarterPanelData } from "@/lib/quarter-metrics-compute";
import { loadMetricsMap } from "@/lib/metrics";
import { formatQuarterBriefBlock } from "@/lib/quarter-panel";

export async function loadQuarterDossier(
  ticker: string,
  market: string | null,
  priceOverride?: number | null,
): Promise<string | null> {
  const result = await resolveQuarterPanelData(ticker, market, priceOverride);
  if (!result.ok || !result.panel || !result.snapshot) return null;

  return formatQuarterBriefBlock(result.panel, {
    forward_pe: result.snapshot.forward_pe,
    yoy: {
      sales_yoy: result.snapshot.sales_yoy,
      np_yoy: result.snapshot.np_yoy,
      eps_yoy: result.snapshot.eps_yoy,
      ebidt_yoy: result.snapshot.extras?.ebidt_yoy ?? null,
    },
    extras: result.snapshot.extras ?? null,
    price: result.price ?? loadMetricsMap().get(ticker.toUpperCase())?.price ?? null,
  });
}
