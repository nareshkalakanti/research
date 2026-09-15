"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

export type AppTab =
  | "scan"
  | "theme-scanner"
  | "governance"
  | "concall"
  | "marketiq"
  | "orderbookiq"
  | "boardroomiq"
  | "missing"
  | "research";

export const APP_TABS: { id: AppTab; label: string; short: string }[] = [
  { id: "theme-scanner", label: "Theme", short: "Theme" },
  { id: "scan", label: "Scan", short: "Scan" },
  { id: "governance", label: "Governance", short: "Governance" },
  { id: "concall", label: "ConcallIQ", short: "Concall" },
  { id: "marketiq", label: "MarketIQ", short: "Market" },
  { id: "orderbookiq", label: "OrderBookIQ", short: "Orders" },
  { id: "boardroomiq", label: "BoardRoomIQ", short: "Board" },
  { id: "research", label: "Research", short: "Research" },
  { id: "missing", label: "Missing data", short: "Missing" },
];

export const IQ_TABS: AppTab[] = [
  "concall",
  "marketiq",
  "orderbookiq",
  "boardroomiq",
];

export function tabFromParam(raw: string | null): AppTab {
  if (raw === "ht") return "scan";
  if (raw === "strategy" || raw === "buyback" || raw === "corporate") {
    return "concall";
  }
  if (raw === "categories") return "theme-scanner";
  if (raw && APP_TABS.some((t) => t.id === raw)) return raw as AppTab;
  return "theme-scanner";
}

function readTabFromLocation(): AppTab {
  if (typeof window === "undefined") return "theme-scanner";
  return tabFromParam(new URLSearchParams(window.location.search).get("tab"));
}

function buildTabSearch(next: AppTab, current: URLSearchParams): string {
  const params = new URLSearchParams(current.toString());
  if (next === "theme-scanner") params.delete("tab");
  else params.set("tab", next);
  if (next !== "concall") params.delete("view");
  if (next !== "orderbookiq") params.delete("ordersView");
  if (next !== "governance") {
    params.delete("personId");
    params.delete("din");
  }
  return params.toString();
}

function syncTabUrl(next: AppTab) {
  const params = new URLSearchParams(window.location.search);
  const qs = buildTabSearch(next, params);
  const path = window.location.pathname;
  const url = qs ? `${path}?${qs}` : path;
  if (`${path}${window.location.search}` !== url) {
    window.history.replaceState(window.history.state, "", url);
  }
}

type AppTabContextValue = {
  tab: AppTab;
  setTab: (next: AppTab) => void;
};

const AppTabContext = createContext<AppTabContextValue | null>(null);

export function AppTabProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [tab, setTabState] = useState<AppTab>(readTabFromLocation);

  useEffect(() => {
    const onPop = () => setTabState(readTabFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const setTab = useCallback(
    (next: AppTab) => {
      setTabState(next);
      syncTabUrl(next);
      startTransition(() => {
        const params = new URLSearchParams(window.location.search);
        const qs = buildTabSearch(next, params);
        router.replace(qs ? `/?${qs}` : "/", { scroll: false });
      });
    },
    [router],
  );

  const value = useMemo(() => ({ tab, setTab }), [tab, setTab]);

  return (
    <AppTabContext.Provider value={value}>{children}</AppTabContext.Provider>
  );
}

export function useAppTab(): AppTabContextValue {
  const ctx = useContext(AppTabContext);
  if (!ctx) throw new Error("useAppTab must be used within AppTabProvider");
  return ctx;
}
