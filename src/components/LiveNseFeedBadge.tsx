"use client";

import type { NseFeedStatus } from "@/lib/nse-feed-status-types";
import { formatNseFeedAge } from "@/lib/nse-feed-status-types";

type Props = {
  status: NseFeedStatus | null | undefined;
  compact?: boolean;
};

function buildTitle(status: NseFeedStatus): string {
  const parts = [status.detail];
  const scanAge = formatNseFeedAge(status.last_scan_at);
  if (scanAge) parts.push(`Last earn/concall scan ${scanAge}`);
  const checked = formatNseFeedAge(status.checked_at);
  if (checked) parts.push(`Checked ${checked}`);
  return parts.join(" · ");
}

export function LiveNseFeedBadge({ status, compact }: Props) {
  if (!status) return null;

  const live = status.live;
  const label = live
    ? compact
      ? "Live"
      : "Live NSE feed"
    : compact
      ? "Offline"
      : "NSE feed offline";

  return (
    <span
      className={`live-nse-feed ${live ? "live-nse-feed--on" : "live-nse-feed--off"}`}
      title={buildTitle(status)}
    >
      <span className="live-nse-feed-dot" aria-hidden />
      {label}
    </span>
  );
}
