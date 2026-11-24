import type { AppTab } from "@/lib/app-tab";

/** Simple 24×24 stroke icons for the side navigation (no icon library). */
const PATHS: Partial<Record<AppTab, string>> = {
  // Napkin: note with lines
  napkin: "M6 3h9l4 4v14H6z M15 3v4h4 M9 12h7 M9 16h5",
  // Governance: three people
  dashboard: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6 M17 11a2.5 2.5 0 1 0 0-5 M16 14.2c2.9.4 5 2.9 5 5.8",
  // Value: trophy
  value: "M8 4h8v5a4 4 0 0 1-8 0z M8 6H5a3 3 0 0 0 3 4 M16 6h3a3 3 0 0 1-3 4 M12 13v4 M8 20h8 M10 17h4",
  // Trend: line chart
  rotation: "M4 19h16 M4 15l5-5 4 3 7-7 M16 6h4v4",
  // Price Action: bar chart
  "price-action": "M5 20V11 M10 20V5 M15 20v-7 M20 20V8",
  // Portfolio: folder
  portfolio: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  // Drift: microphone
  "concall-drift": "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M6 11a6 6 0 0 0 12 0 M12 17v4 M9 21h6",
  // Scan: magnifier
  scan: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4",
  // Watchlist: eye
  watchlist: "M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  // Scanner: filter funnel
  scanner: "M4 5h16l-6 7v6l-4 2v-8z",
  // Research: open book
  research: "M3 5h6a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H3z M21 5h-6a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h7z",
};

export function NavIcon({ tab }: { tab: AppTab }) {
  const d = PATHS[tab] ?? "M5 5h14v14H5z";
  return (
    <svg
      className="side-nav-icon"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}
