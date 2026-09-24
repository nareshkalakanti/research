import type { AppTab } from "@/lib/app-tab";

type Origin = { from: string; returnTab?: AppTab };

export type GovOpenRequest =
  | ({ kind: "company"; ticker: string } & Origin)
  | ({ kind: "director"; personId: string; name: string } & Origin);

const EVENT = "gov-open-request";
let pending: GovOpenRequest | null = null;

/** Ask the Governance panel to drill into a company or director. */
export function requestGovOpen(req: GovOpenRequest) {
  pending = req;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/** Subscribe to open requests; delivers any request queued before mount. */
export function onGovOpen(handler: (req: GovOpenRequest) => void): () => void {
  const deliver = () => {
    const req = pending;
    pending = null;
    if (req) handler(req);
  };
  deliver();
  window.addEventListener(EVENT, deliver);
  return () => window.removeEventListener(EVENT, deliver);
}
