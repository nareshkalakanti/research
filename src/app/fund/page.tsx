import { redirect } from "next/navigation";

export default function FundPage() {
  redirect("/?tab=watchlist");
}
