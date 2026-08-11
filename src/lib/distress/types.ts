export type DistressListId = "seeds" | "holdings" | "nse" | "nse-sme";

export function isDistressScanList(list: DistressListId): boolean {
  return list === "nse" || list === "nse-sme";
}
