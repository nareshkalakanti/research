import type { InvestorMaterialKind } from "./investor-material-types";

const KIND_LABEL: Record<InvestorMaterialKind, string> = {
  concall: "CONCALL",
  transcript: "TRANSCRIPT",
  ppt: "PPT",
  other: "RESULTS",
};

export function materialHeadline(input: {
  kind: InvestorMaterialKind;
  title?: string;
  period?: string | null;
}): string {
  return [
    KIND_LABEL[input.kind] || input.kind.toUpperCase(),
    input.title || "Untitled",
    input.period ? `(${input.period})` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function sourceLabel(input: {
  kind: InvestorMaterialKind;
  period?: string | null;
}): string {
  const kind =
    input.kind === "ppt" ? "PPT" : input.kind === "concall" ? "concall" : input.kind;
  return input.period ? `${input.period} ${kind}` : kind;
}
