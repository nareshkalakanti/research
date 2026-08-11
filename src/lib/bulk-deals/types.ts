export type DealType = "bulk" | "block";

export type BulkDealRow = {
  trade_date: string;
  symbol: string;
  security_name: string;
  client_name: string;
  side: string;
  quantity: number | null;
  price: number | null;
  deal_type: DealType;
  exchange: "NSE" | "BSE";
  fetched_at: string;
};
