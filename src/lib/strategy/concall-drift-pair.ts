import type { NseCorpEvent } from "../nse-corp-events";

const DAY_MS = 86_400_000;
/** Concall schedule often filed up to 2 weeks before results. */
const MAX_BEFORE_EARN_MS = 14 * DAY_MS;
/** Transcript often files 2–6 weeks after results. */
const MAX_AFTER_EARN_MS = 45 * DAY_MS;

function pairScore(earnTs: number, concallTs: number): number | null {
  const delta = concallTs - earnTs;
  if (delta < -MAX_BEFORE_EARN_MS || delta > MAX_AFTER_EARN_MS) return null;
  if (delta >= 0) {
    // Same-cycle concall on/after results — closest after earn wins.
    return delta;
  }
  // Scheduled intimation before results — prefer closest to earn date.
  return MAX_AFTER_EARN_MS + Math.abs(delta);
}

function concallQuality(c: NseCorpEvent): number {
  const s = `${c.title} ${c.subject || ""}`.toLowerCase();
  if (/transcript/.test(s)) return 0;
  if (/audio recording|recording of/.test(s)) return 1;
  if (/intimation|schedule of|invitation|upcoming/.test(s)) return 3;
  return 2;
}

/** Pair each earn with the best NSE concall / investor-meet filing in the cycle. */
export function pairEarnConcall(events: NseCorpEvent[]): Array<{
  earn: NseCorpEvent;
  concall: NseCorpEvent | null;
}> {
  const earns = events.filter((e) => e.kind === "earn");
  const concalls = events.filter((e) => e.kind === "concall");

  return earns.map((earn) => {
    const earnTs = Date.parse(earn.announced_at);
    let best: NseCorpEvent | null = null;
    let bestScore = Infinity;
    let bestQuality = Infinity;

    for (const c of concalls) {
      const cTs = Date.parse(c.announced_at);
      const score = pairScore(earnTs, cTs);
      if (score == null) continue;
      const quality = concallQuality(c);
      if (
        !best ||
        quality < bestQuality ||
        (quality === bestQuality && score < bestScore)
      ) {
        best = c;
        bestScore = score;
        bestQuality = quality;
      }
    }

    return { earn, concall: best };
  });
}
