/** Fresh cross above 200 DMA: prior close at/below the average, last price above. */

export function crossedAbove200Dma(tape: {
  price: number | null;
  dma200: number | null;
  prev_close: number | null;
} | null): boolean {
  if (!tape) return false;
  if (tape.price == null || tape.dma200 == null || tape.prev_close == null) {
    return false;
  }
  return tape.prev_close <= tape.dma200 && tape.price > tape.dma200;
}
