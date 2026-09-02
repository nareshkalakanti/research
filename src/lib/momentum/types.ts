export type MomentumRow = {
  rank: number;
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  mcap_cr: number | null;
  price: number | null;
  return_6m: number | null;
  return_12m: number | null;
  std_dev_1y: number | null;
  momentum_score: number | null;
  sc: string;
  tv: string;
  web: string | null;
  fetched_at: string | null;
};

export type MomentumScanProgress = {
  pending: number;
  scanned: number;
  universe: number;
};
