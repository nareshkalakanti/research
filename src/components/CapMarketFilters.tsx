"use client";

export const CAPS = ["All", "NC", "TI", "MIC", "SC", "MC", "LC"] as const;
export type CapFilter = (typeof CAPS)[number];

const CAP_TITLE: Record<CapFilter, string> = {
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
  sme: boolean;
  onSme: (sme: boolean) => void;
};

export function CapMarketFilters({ cap, onCap, sme, onSme }: Props) {
  return (
    <>
      <div className="chip-row">
        <span className="chip-label">Cap</span>
        {CAPS.map((c) => (
          <button
            key={c}
            type="button"
            title={CAP_TITLE[c]}
            className={`chip tag-chip tag-cap-${c.toLowerCase()} ${cap === c ? "on" : ""}`}
            onClick={() => {
              // Clicking the active band clears back to All.
              if (c !== "All" && cap === c) onCap("All");
              else onCap(c);
            }}
          >
            {c}
          </button>
        ))}
        {cap !== "All" ? (
          <button
            type="button"
            className="chip tag-chip tag-cap-clear"
            title="Clear cap filter"
            onClick={() => onCap("All")}
          >
            Clear
          </button>
        ) : null}
      </div>
      <div className="chip-row">
        <span className="chip-label">Market</span>
        <button
          type="button"
          className={`chip tag-chip tag-mkt-all ${!sme ? "on" : ""}`}
          onClick={() => onSme(false)}
        >
          All
        </button>
        <button
          type="button"
          className={`chip tag-chip tag-mkt-sme ${sme ? "on" : ""}`}
          onClick={() => onSme(true)}
        >
          SME
        </button>
      </div>
    </>
  );
}
