"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type AppTab =
  | "scan"
  | "theme-scanner"
  | "governance"
  | "marketiq"
  | "orderbookiq"
  | "boardroomiq"
  | "missing"
  | "research"
  | "watchlist"
  | "fund";

export const APP_TABS: { id: AppTab; label: string; short: string }[] = [
  { id: "theme-scanner", label: "Theme", short: "Theme" },
  { id: "scan", label: "Scan", short: "Scan" },
  { id: "governance", label: "Governance", short: "Governance" },
  { id: "fund", label: "Fund", short: "Fund" },
  { id: "marketiq", label: "MarketIQ", short: "Market" },
  { id: "orderbookiq", label: "OrderBookIQ", short: "Orders" },
  { id: "boardroomiq", label: "BoardRoomIQ", short: "Board" },
  { id: "research", label: "Research", short: "Research" },
  { id: "missing", label: "Missing data", short: "Missing" },
];

export const PAGE_TABS: { id: AppTab; label: string; short: string }[] = [
  { id: "watchlist", label: "Watchlist", short: "Watch" },
];

export const IQ_TABS: AppTab[] = [
  "marketiq",
  "orderbookiq",
  "boardroomiq",
];

function isPageTab(id: AppTab): boolean {
  return id === "watchlist" || id === "fund";
}

export function tabFromParam(raw: string | null): AppTab {
  if (raw === "ht") return "scan";
  if (
    raw === "strategy" ||
    raw === "buyback" ||
    raw === "corporate" ||
    raw === "concall"
  ) {
    return "fund";
  }
  if (raw === "categories") return "theme-scanner";
  if (raw && APP_TABS.some((t) => t.id === raw)) return raw as AppTab;
  return "theme-scanner";
}

function pathOnly(): string {
  const p = window.location.pathname.replace(/\/+$/, "");
  return p || "/";
}

export function readTabFromLocation(): AppTab {
  if (typeof window === "undefined") return "theme-scanner";
  const path = pathOnly();
  if (path === "/watchlist") return "watchlist";
  if (path === "/fund") return "fund";
  return tabFromParam(new URLSearchParams(window.location.search).get("tab"));
}

function buildHomeSearch(
  next: AppTab,
  current: URLSearchParams,
  ticker?: string | null,
): string {
  const params = new URLSearchParams(current.toString());
  if (next === "theme-scanner") params.delete("tab");
  else params.set("tab", next);
  if (next !== "orderbookiq") params.delete("ordersView");
  if (next !== "governance") {
    params.delete("personId");
    params.delete("din");
  }
  const t = (ticker || "").trim().toUpperCase();
  if (t && next === "research") {
    params.set("ticker", t);
  } else if (next !== "research") {
    params.delete("ticker");
  }
  return params.toString();
}

function urlForTab(next: AppTab, ticker?: string | null): string {
  if (next === "watchlist") return "/watchlist";
  if (next === "fund") return "/fund";
  const fromHome =
    pathOnly() === "/"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const qs = buildHomeSearch(next, fromHome, ticker);
  return qs ? `/?${qs}` : "/";
}

function currentUrl(): string {
  return `${pathOnly()}${window.location.search}`;
}

function syncTabUrl(
  next: AppTab,
  mode: "push" | "replace",
  ticker?: string | null,
) {
  const url = urlForTab(next, ticker);
  if (currentUrl() === url) return;
  if (mode === "push") window.history.pushState(window.history.state, "", url);
  else window.history.replaceState(window.history.state, "", url);
}

type AppTabContextValue = {
  tab: AppTab;
  setTab: (next: AppTab, opts?: { ticker?: string }) => void;
};

const AppTabContext = createContext<AppTabContextValue | null>(null);

export function AppTabProvider({ children }: { children: ReactNode }) {
  const [tab, setTabState] = useState<AppTab>(readTabFromLocation);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  useEffect(() => {
    const onPop = () => setTabState(readTabFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const setTab = useCallback((next: AppTab, opts?: { ticker?: string }) => {
    const prev = tabRef.current;
    setTabState(next);
    const pageHop = isPageTab(prev) || isPageTab(next);
    syncTabUrl(
      next,
      pageHop && prev !== next ? "push" : "replace",
      opts?.ticker,
    );
  }, []);

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

export function useOptionalAppTab(): AppTabContextValue | null {
  return useContext(AppTabContext);
}
