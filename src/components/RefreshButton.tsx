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
      title="Reload data from disk (clears server cache)"
    >
      {busy ? "Refreshing…" : "Refresh"}
    </button>
  );
}
