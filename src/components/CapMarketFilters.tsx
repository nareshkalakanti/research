"use client";

export const CAPS = ["All", "NC", "TI", "MIC", "SC", "MC", "LC"] as const;
export type CapFilter = (typeof CAPS)[number];

export const CAP_TITLE: Record<CapFilter, string> = {
  All: "All market caps",
  NC: "No cap data (missing mcap)",
  TI: "Tiny · under ₹100 Cr",
  MIC: "Micro · ₹100–500 Cr",
  SC: "Small · ₹500–5,000 Cr",
  MC: "Mid · ₹5,000–20,000 Cr",
  LC: "Large · ₹20,000 Cr+",
};

type Props = {
  cap: CapFilter;
  onCap: (cap: CapFilter) => void;
  /** Optional inline SME chip (governance). Scanner uses List dropdown instead. */
  sme?: boolean;
  onSme?: (sme: boolean) => void;
  showSme?: boolean;
  /** Single-row inline mode — no label row wrapper */
  inline?: boolean;
  /** Unique-symbol counts per cap tier (excludes "All"). */
  capCounts?: Partial<Record<CapFilter, number>>;
  smeCount?: number;
  allCount?: number;
};

function ChipCount({ n }: { n?: number }) {
  if (n == null) return null;
  return <span className="chip-count">{n.toLocaleString("en-IN")}</span>;
}

export function CapMarketFilters({
  cap,
  onCap,
  sme = false,
  onSme,
  showSme = false,
  inline = false,
  capCounts,
  smeCount,
  allCount,
}: Props) {
  const chips = (
    <>
      {CAPS.map((c) => (
        <button
          key={c}
          type="button"
          title={CAP_TITLE[c]}
          className={`chip tag-chip tag-cap-${c.toLowerCase()} ${cap === c ? "on" : ""}`}
          onClick={() => {
            if (c !== "All" && cap === c) onCap("All");
            else onCap(c);
          }}
        >
          {c}
          <ChipCount
            n={
              c === "All"
                ? allCount
                : capCounts?.[c as Exclude<CapFilter, "All">]
            }
          />
        </button>
      ))}
      {cap !== "All" ? (
        <button
          type="button"
          className="chip tag-chip tag-cap-clear"
          title="Clear cap filter"
          onClick={() => onCap("All")}
        >
          ×
        </button>
      ) : null}
      {showSme && onSme ? (
        <button
          type="button"
          className={`chip tag-chip tag-mkt-sme ${sme ? "on" : ""}`}
          onClick={() => onSme(!sme)}
          title="NSE / BSE SME listings only"
        >
          SME
          <ChipCount n={smeCount} />
        </button>
      ) : null}
    </>
  );

  if (inline) return chips;

  return (
    <div className="chip-row">
      <span className="chip-label">Cap</span>
      {chips}
    </div>
  );
}
