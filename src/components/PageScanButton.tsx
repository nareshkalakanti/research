"use client";

/**
 * On-page Scan: clear server list caches (same as top-bar Refresh), then reload this panel.
 * Signal keeps its own Scan bar — do not use this there.
 */
export function PageScanButton({
  busy,
  onScanned,
  title = "Rebuild this page from saved prices (clears the screen cache)",
}: {
  busy?: boolean;
  onScanned: () => void | Promise<void>;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="vx-btn vx-btn--scan"
      disabled={busy}
      title={title}
      onClick={async () => {
        try {
          await fetch("/api/refresh", { method: "POST" });
        } catch {
          /* still reload */
        }
        await onScanned();
      }}
    >
      {busy ? "Scanning…" : "Scan"}
    </button>
  );
}
