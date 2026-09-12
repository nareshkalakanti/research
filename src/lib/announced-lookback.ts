/** Market-wide announced discovery lookback (calendar days). */

/** ~6 months — NSE/BSE are queried one calendar day at a time. */
export const ANNOUNCED_MAX_DAYS = 180;

/** UI + CLI presets: short interactive, then 1/3/6 month pulls. */
export const ANNOUNCED_DAY_OPTIONS = [
  1, 2, 3, 5, 7, 30, 90, 180,
] as const;

export function clampAnnouncedDays(daysBack: number): number {
  const n = Number(daysBack);
  if (!Number.isFinite(n)) return 1;
  return Math.min(ANNOUNCED_MAX_DAYS, Math.max(1, Math.round(n)));
}
