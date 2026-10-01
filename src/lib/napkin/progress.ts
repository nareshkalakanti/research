export type NapkinStepStatus = "pending" | "running" | "done" | "skip" | "fail";

export type NapkinStepId =
  | "yahoo"
  | "napkin"
  | "nse_session"
  | "nse_anns"
  | "bse"
  | "ir"
  | "classify"
  | "pdf"
  | "qwen"
  | "concall";

export type NapkinStepEvent = {
  id: NapkinStepId;
  status: NapkinStepStatus;
  label: string;
  detail?: string;
  ms?: number;
};

export const NAPKIN_FLOW_STEPS: Array<{ id: NapkinStepId; label: string }> = [
  { id: "yahoo", label: "Yahoo financials" },
  { id: "napkin", label: "Napkin engine" },
  { id: "nse_session", label: "NSE session" },
  { id: "nse_anns", label: "NSE filings" },
  { id: "bse", label: "BSE" },
  { id: "ir", label: "Company IR" },
  { id: "classify", label: "Classify · dedupe · pick" },
  { id: "pdf", label: "PDF extract" },
  { id: "qwen", label: "Local Qwen" },
  { id: "concall", label: "Management track record" },
];
