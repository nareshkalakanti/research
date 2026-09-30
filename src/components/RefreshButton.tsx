"use client";

type Props = {
  onRefresh: () => void | Promise<void>;
  busy?: boolean;
};

export function RefreshButton({ onRefresh, busy }: Props) {
  return (
    <button
      type="button"
      className="btn-refresh"
      disabled={busy}
      onClick={() => void onRefresh()}
      title="Reload list and refresh live prices for this page"
    >
      {busy ? "Refreshing…" : "Refresh"}
    </button>
  );
}

/** Compact ↻ for a graph/card. */
export function BoxRefreshButton({
  onRefresh,
  busy,
  title = "Reload this graph from saved boards",
}: {
  onRefresh: () => void | Promise<void>;
  busy?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="btn-box-refresh"
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        void onRefresh();
      }}
      title={title}
      aria-label={title}
    >
      {busy ? "…" : "↻"}
    </button>
  );
}
