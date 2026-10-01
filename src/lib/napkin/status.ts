export type NapkinDataStatus = "complete" | "partial" | "insufficient";

export function napkinDataStatus(input: {
  pe: number | null | undefined;
  requiredCagr: number | null | undefined;
  price: number | null | undefined;
  revenue: number | null | undefined;
  netProfit: number | null | undefined;
  eps: number | null | undefined;
  threeYearCagrAvailable: boolean;
  fiveYearCagrAvailable: boolean;
}): NapkinDataStatus {
  if (input.pe == null || !Number.isFinite(input.pe) || input.pe <= 0) {
    return "insufficient";
  }
  if (input.requiredCagr == null || !Number.isFinite(input.requiredCagr)) {
    return "insufficient";
  }
  const currentOk = [input.price, input.revenue, input.netProfit, input.eps].every(
    (v) => v != null && Number.isFinite(v),
  );
  if (currentOk && input.threeYearCagrAvailable && input.fiveYearCagrAvailable) {
    return "complete";
  }
  return "partial";
}

export function napkinStatusLabel(status: NapkinDataStatus): string {
  if (status === "complete") return "DATA COMPLETE";
  if (status === "partial") return "PARTIAL DATA";
  return "INSUFFICIENT DATA";
}
