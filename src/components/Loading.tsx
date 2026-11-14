/**
 * Shared loading state — spinner + label, with skeleton rows for panels.
 *
 * - `page`:   full-height centred (route / app boot)
 * - `block`:  panel placeholder with shimmering skeleton rows (default)
 * - `inline`: compact spinner + label inside a card or table cell
 */
export function Loading({
  label = "Loading",
  variant = "block",
  rows = 3,
  className,
}: {
  label?: string;
  variant?: "page" | "block" | "inline";
  /** Skeleton rows for `block`. */
  rows?: number;
  className?: string;
}) {
  const text = label.replace(/[.…]+$/, "");
  const cls = ["ld", `ld--${variant}`, className].filter(Boolean).join(" ");
  return (
    <div className={cls} role="status" aria-live="polite" aria-busy="true">
      <div className="ld-head">
        <span className="ld-spin" aria-hidden />
        <span className="ld-label">{text}</span>
      </div>
      {variant === "block" && rows > 0 ? (
        <div className="ld-skel" aria-hidden>
          {Array.from({ length: rows }, (_, i) => (
            <span
              key={i}
              className="ld-bar"
              style={{ width: `${[92, 78, 64, 85, 70][i % 5]}%` }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
