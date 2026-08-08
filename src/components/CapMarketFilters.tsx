"use client";

export const CAPS = ["All", "NC", "MIC", "SC", "MC", "LC"] as const;
export type CapFilter = (typeof CAPS)[number];

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
            className={`chip tag-chip tag-cap-${c.toLowerCase()} ${cap === c ? "on" : ""}`}
            onClick={() => onCap(c)}
          >
            {c}
          </button>
        ))}
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
