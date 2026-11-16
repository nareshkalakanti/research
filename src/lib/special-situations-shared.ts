/** Special Situations themes — shared with the browser (no server imports). */

export const SS_BUCKETS = [
  { id: "ma", label: "Mergers & acquisitions", hint: "Acquisitions, mergers, open offers, delistings" },
  { id: "spin", label: "Spin-offs / demergers", hint: "Demergers and business transfers" },
  { id: "distress", label: "Distressed", hint: "Rating cuts, auditor exits, defaults, delayed results" },
  { id: "bankruptcy", label: "Bankruptcy / turnarounds", hint: "Insolvency (CIRP), resolution plans, settlements" },
  { id: "liquidation", label: "Liquidations", hint: "Liquidation and winding up" },
  { id: "catalyst", label: "Catalyst-driven", hint: "Order wins, capacity, buybacks, approvals, asset sales" },
] as const;

export type SsBucket = (typeof SS_BUCKETS)[number]["id"];
