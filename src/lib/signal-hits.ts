/**
 * Client loaders for breakout signals — BB W / TQ W (IQ Master) and
 * "crossed above 200 DMA today" (quote tape, daily closes).
 * Shared by the watchlist dashboard and business-group cards.
 */

export type IqDashRow = {
  ticker: string;
  company: string;
  market: string | null;
  price: number | null;
  market_cap_cr: number | null;
  sector: string | null;
  has_bb_w?: boolean;
  has_tq?: boolean;
  tq_score?: number | null;
};

export async function loadIqRows(syms: string[]): Promise<IqDashRow[]> {
  const CHUNK = 40;
  const collected: IqDashRow[] = [];
  for (let i = 0; i < syms.length; i += CHUNK) {
    const chunk = syms.slice(i, i + CHUNK);
    const res = await fetch(
      `/api/iq-master?tickers=${encodeURIComponent(chunk.join(","))}`,
    );
    const json = (await res.json()) as { ok?: boolean; rows?: IqDashRow[] };
    collected.push(...(json.rows ?? []));
  }
  const byTicker = new Map(collected.map((r) => [r.ticker.toUpperCase(), r]));
  return syms.map((t) => {
    const hit = byTicker.get(t.toUpperCase());
    return (
      hit ?? {
        ticker: t,
        company: t,
        market: null,
        price: null,
        market_cap_cr: null,
        sector: null,
        has_bb_w: false,
        has_tq: false,
        tq_score: null,
      }
    );
  });
}

type DmaHit = {
  crossed: boolean;
  price: number | null;
  /** 200-week SMA cross — only filled when `weekly` is requested. */
  crossedW?: boolean;
};

export async function loadCrossed200Dma(
  rows: IqDashRow[],
  opts?: {
    weekly?: boolean;
    /** Called after each batch — (checked, total). */
    onProgress?: (done: number, total: number) => void;
  },
): Promise<Map<string, DmaHit>> {
  const hits = new Map<string, DmaHit>();
  const CHUNK = 8;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (row) => {
        const key = row.ticker.toUpperCase();
        try {
          const q = new URLSearchParams({ ticker: row.ticker });
          if (row.market) q.set("market", row.market);
          if (opts?.weekly) q.set("weekly", "1");
          const res = await fetch(`/api/quote-tape?${q}`, {
            signal: AbortSignal.timeout(30_000),
          });
          const json = (await res.json()) as {
            ok?: boolean;
            tape?: {
              price: number | null;
              crossed_above_200dma?: boolean;
              crossed_above_200wma?: boolean;
            };
          };
          if (!json.ok || !json.tape) {
            hits.set(key, { crossed: false, price: null });
            return;
          }
          hits.set(key, {
            crossed: !!json.tape.crossed_above_200dma,
            price: json.tape.price ?? null,
            crossedW: !!json.tape.crossed_above_200wma,
          });
        } catch {
          hits.set(key, { crossed: false, price: null });
        }
      }),
    );
    opts?.onProgress?.(Math.min(rows.length, i + CHUNK), rows.length);
  }
  return hits;
}

export type SignalHit = {
  ticker: string;
  crossed_200dma: boolean;
  bb_w: boolean;
  tq_w: boolean;
  tq_score: number | null;
};

/** All three signals for a ticker list (BB W / TQ W first, then 200 DMA). */
export async function loadSignalHits(
  tickers: string[],
  opts?: { onProgress?: (done: number, total: number) => void },
): Promise<Map<string, SignalHit>> {
  const syms = [...new Set(tickers.map((t) => t.trim().toUpperCase()))].filter(
    Boolean,
  );
  const out = new Map<string, SignalHit>();
  if (!syms.length) return out;
  const iq = await loadIqRows(syms);
  const dma = await loadCrossed200Dma(iq, { onProgress: opts?.onProgress });
  for (const r of iq) {
    const t = r.ticker.toUpperCase();
    out.set(t, {
      ticker: t,
      crossed_200dma: !!dma.get(t)?.crossed,
      bb_w: !!r.has_bb_w,
      tq_w: !!r.has_tq,
      tq_score: r.tq_score ?? null,
    });
  }
  return out;
}
