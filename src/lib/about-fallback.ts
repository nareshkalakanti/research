export function isWebsiteUnreachableStatus(
  status: string | null | undefined,
): boolean {
  const s = (status || "").toLowerCase();
  return s === "not_found" || s === "failed" || s === "unreachable";
}
