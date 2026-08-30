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
  url: string;
  provider: MaterialSourceProvider;
  imported: boolean;
};
