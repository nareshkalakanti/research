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
