import { redirect } from "next/navigation";

/** Orders moved under OrderBookIQ — keep old URL working. */
export default function OrderTrackerPage() {
  redirect("/?tab=orderbookiq&ordersView=all");
}
