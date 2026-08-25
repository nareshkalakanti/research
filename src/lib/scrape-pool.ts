/** Throttled HTTP + serialized SQLite writes for website scraping. */

const GLOBAL_FETCH_MAX = 12;
const PER_HOST_MAX = 2;
const HOST_START_GAP_MS = 60;

let globalFetchActive = 0;
const hostFetchActive = new Map<string, number>();
const hostLastStart = new Map<string, number>();

function hostKey(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

async function waitForFetchSlot(origin: string): Promise<void> {
  for (;;) {
    const hostActive = hostFetchActive.get(origin) ?? 0;
    if (
      globalFetchActive < GLOBAL_FETCH_MAX &&
      hostActive < PER_HOST_MAX
    ) {
      const now = Date.now();
      const last = hostLastStart.get(origin) ?? 0;
      const gap = HOST_START_GAP_MS - (now - last);
      if (gap > 0) {
        await new Promise((r) => setTimeout(r, gap));
      }
      globalFetchActive += 1;
      hostFetchActive.set(origin, hostActive + 1);
      hostLastStart.set(origin, Date.now());
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function releaseFetchSlot(origin: string): void {
  globalFetchActive = Math.max(0, globalFetchActive - 1);
  const next = (hostFetchActive.get(origin) ?? 1) - 1;
  if (next <= 0) hostFetchActive.delete(origin);
  else hostFetchActive.set(origin, next);
}

/** Limit outbound website fetches — global cap + per-origin cap. */
export async function withWebsiteFetch<T>(
  url: string,
  fn: () => Promise<T>,
): Promise<T> {
  const origin = hostKey(url);
  await waitForFetchSlot(origin);
  try {
    return await fn();
  } finally {
    releaseFetchSlot(origin);
  }
}

let writeChain: Promise<void> = Promise.resolve();

/** Serialize scrape DB writes to avoid SQLITE_BUSY under parallel workers. */
export async function withScrapeWriteLock<T>(
  fn: () => T | Promise<T>,
): Promise<T> {
  const prev = writeChain;
  let release!: () => void;
  writeChain = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Fixed-size worker pool — stable under load. */
export async function runConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const workers = Math.min(Math.max(1, concurrency), items.length);
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export const SCRAPE_BATCH_DEFAULT = 12;
export const SCRAPE_BATCH_MAX = 24;
export const SCRAPE_CONCURRENCY_DEFAULT = 5;
export const SCRAPE_CONCURRENCY_MAX = 6;
export const SCRAPE_PAGE_FETCH_CONCURRENCY = 4;
