"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type AppTab =
  | "dashboard"
  | "scan"
  | "pead"
  | "theme-scanner"
  | "governance"
  | "marketiq"
  | "orderbookiq"
  | "boardroomiq"
  | "missing"
  | "research"
  | "watchlist"
  | "napkin"
  | "concall-drift"
  | "rotation"
  | "signals";

/** Top nav tabs only — other panels stay wired but are not listed here. */
export const APP_TABS: { id: AppTab; label: string; short: string }[] = [
  { id: "napkin", label: "Napkin", short: "Napkin" },
  { id: "dashboard", label: "Dashboard", short: "Dash" },
  { id: "concall-drift", label: "Drift", short: "Drift" },
  { id: "pead", label: "PEAD", short: "PEAD" },
  { id: "scan", label: "Scan", short: "Scan" },
  { id: "rotation", label: "Rotation", short: "Rotate" },
  { id: "watchlist", label: "Watchlist", short: "Watch" },
  { id: "missing", label: "Data", short: "Data" },
  { id: "research", label: "Research", short: "Research" },
];

export const PAGE_TABS: { id: AppTab; label: string; short: string }[] = [];

/** Hidden from top nav; still reachable via `?tab=` / path and AppShell panels. */
export const IQ_TABS: AppTab[] = [
  "marketiq",
  "orderbookiq",
  "boardroomiq",
];

const HIDDEN_TABS: AppTab[] = [
  "governance",
  "theme-scanner",
  "signals",
  ...IQ_TABS,
];

function isPageTab(id: AppTab): boolean {
  return (
    id === "watchlist" || id === "dashboard" || id === "pead"
  );
}

export function tabFromParam(raw: string | null): AppTab {
  if (raw === "ht") return "scan";
  if (
    raw === "strategy" ||
    raw === "concall" ||
    raw === "drift" ||
    raw === "track" ||
    raw === "tracks" ||
    raw === "tracked"
  ) {
    return "concall-drift";
  }
  if (raw === "buyback" || raw === "corporate") {
    return "watchlist";
  }
  if (raw === "fund") return "watchlist";
  if (raw === "rights") return "dashboard";
  if (raw === "radar") return "dashboard";
  if (raw === "categories") return "theme-scanner";
  if (
    raw &&
    (APP_TABS.some((t) => t.id === raw) ||
      HIDDEN_TABS.includes(raw as AppTab))
  ) {
    return raw as AppTab;
  }
  return "napkin";
}

function pathOnly(): string {
  const p = window.location.pathname.replace(/\/+$/, "");
  return p || "/";
}

export function readTabFromLocation(): AppTab {
  if (typeof window === "undefined") return "napkin";
  const path = pathOnly();
  if (path === "/watchlist" || path === "/fund") return "watchlist";
  if (path === "/dashboard") return "dashboard";
  if (path === "/pead") return "pead";
  return tabFromParam(new URLSearchParams(window.location.search).get("tab"));
}

function buildHomeSearch(
  next: AppTab,
  current: URLSearchParams,
  ticker?: string | null,
): string {
  const params = new URLSearchParams(current.toString());
  if (next === "napkin") params.delete("tab");
  else params.set("tab", next);
  if (next !== "orderbookiq") params.delete("ordersView");
  if (next !== "governance") {
    params.delete("personId");
    params.delete("din");
  }
  const t = (ticker || "").trim().toUpperCase();
  if (next === "napkin") {
    params.delete("ticker");
  } else if (t && (next === "research" || next === "governance")) {
    params.set("ticker", t);
  } else if (next !== "research" && next !== "governance") {
    params.delete("ticker");
  }
  return params.toString();
}

export function hrefForTab(next: AppTab): string {
  if (next === "watchlist") return "/watchlist";
  if (next === "dashboard") return "/dashboard";
  if (next === "pead") return "/pead";
  if (next === "napkin") return "/";
  return `/?tab=${encodeURIComponent(next)}`;
}

function urlForTab(next: AppTab, ticker?: string | null): string {
  if (next === "watchlist") return "/watchlist";
  if (next === "dashboard") return "/dashboard";
  if (next === "pead") return "/pead";
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

const TabStateContext = createContext<AppTab | null>(null);
const TabSetContext = createContext<AppTabContextValue["setTab"] | null>(null);

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

  return (
    <TabSetContext.Provider value={setTab}>
      <TabStateContext.Provider value={tab}>{children}</TabStateContext.Provider>
    </TabSetContext.Provider>
  );
}

export function useAppTab(): AppTabContextValue {
  const tab = useContext(TabStateContext);
  const setTab = useContext(TabSetContext);
  if (tab == null || !setTab) {
    throw new Error("useAppTab must be used within AppTabProvider");
  }
  return { tab, setTab };
}

export function useSetAppTab(): AppTabContextValue["setTab"] {
  const setTab = useContext(TabSetContext);
  if (!setTab) {
    throw new Error("useSetAppTab must be used within AppTabProvider");
  }
  return setTab;
}

export function useOptionalSetAppTab(): AppTabContextValue["setTab"] | null {
  return useContext(TabSetContext);
}

export function useOptionalAppTab(): AppTabContextValue | null {
  const tab = useContext(TabStateContext);
  const setTab = useContext(TabSetContext);
  if (tab == null || !setTab) return null;
  return { tab, setTab };
}
