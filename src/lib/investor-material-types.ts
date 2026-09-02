export type InvestorMaterialKind = "concall" | "ppt" | "transcript" | "other";

export type MaterialSourceProvider =
  | "screener_concalls"
  | "screener_announcements"
  | "bse_announcements"
  | "nse_announcements"
  | "trendlyne_analyst_calls";

export type DiscoveredMaterialSource = {
  id: string;
  kind: InvestorMaterialKind;
  title: string;
  period: string | null;
  /** ISO timestamp when known — used to pick the newest filing, not month-year. */
  announced_at?: string | null;
  url: string;
  provider: MaterialSourceProvider;
  imported: boolean;
};
