"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type AppTab =
  | "dashboard"
  | "scan"
  | "governance"
  | "research"
  | "watchlist"
  | "napkin"
  | "concall-drift"
  | "rotation"
  | "price-action"
  | "breakouts"
  | "momentum-money"
  | "scanner"
  | "value"
  | "portfolio";

/** Top nav tabs only — other panels stay wired but are not listed here. */
export const APP_TABS: { id: AppTab; label: string; short: string }[] = [
  { id: "napkin", label: "Napkin", short: "Napkin" },
  { id: "dashboard", label: "Governance", short: "Gov" },
  { id: "value", label: "Value", short: "Value" },
  { id: "rotation", label: "Trend", short: "Trend" },
  { id: "price-action", label: "Price Action", short: "PA" },
  { id: "breakouts", label: "Breakouts", short: "BO" },
  { id: "momentum-money", label: "Momentum & Money", short: "M&M" },
  { id: "portfolio", label: "Portfolio", short: "Port" },
  { id: "concall-drift", label: "Drift", short: "Drift" },
  { id: "scan", label: "Strategy", short: "Strategy" },
  { id: "watchlist", label: "Watchlist", short: "Watch" },
  { id: "scanner", label: "Scanner", short: "Scanner" },
  { id: "research", label: "Research", short: "Research" },
];

export const PAGE_TABS: { id: AppTab; label: string; short: string }[] = [];

/**
 * Top nav groups. Every page keeps its own tab id and URL (`?tab=…`); the header shows the
 * groups and a sub-tab row for the open group's pages.
 */
export type AppGroup = { id: string; label: string; short: string; tabs: Array<{ id: AppTab; label: string }> };
export const APP_GROUPS: AppGroup[] = [
  { id: "napkin", label: "Napkin", short: "Napkin", tabs: [{ id: "napkin", label: "Napkin" }] },
  {
    id: "markets",
    label: "Markets",
    short: "Mkts",
    tabs: [
      { id: "rotation", label: "Trend" },
      { id: "price-action", label: "Price Action" },
      { id: "breakouts", label: "Breakouts" },
    ],
  },
  {
    id: "strategies",
    label: "Strategies",
    short: "Strat",
    tabs: [
      { id: "momentum-money", label: "Momentum & Money" },
      { id: "scan", label: "Signals" },
    ],
  },
  {
    id: "screens",
    label: "Screens",
    short: "Screens",
    tabs: [
      { id: "scanner", label: "Scanner" },
      { id: "value", label: "Value" },
      { id: "concall-drift", label: "Drift" },
    ],
  },
  {
    id: "portfolio",
    label: "Portfolio",
    short: "Port",
    tabs: [
      { id: "portfolio", label: "Portfolio" },
      { id: "watchlist", label: "Watchlist" },
    ],
  },
  {
    id: "research",
    label: "Research",
    short: "Research",
    tabs: [
      { id: "research", label: "Research" },
      { id: "dashboard", label: "Governance" },
    ],
  },
];

/** The group a tab belongs to (Governance's hidden company / person view sits under Research). */
export function groupOfTab(tab: AppTab): AppGroup {
  if (tab === "governance") return APP_GROUPS.find((g) => g.id === "research")!;
  return APP_GROUPS.find((g) => g.tabs.some((t) => t.id === tab)) ?? APP_GROUPS[0]!;
}

/** Hidden from top nav; opened from Dashboard and Napkin person / company links. */
const HIDDEN_TABS: AppTab[] = ["governance"];

export function tabFromParam(raw: string | null): AppTab {
  if (raw === "ht") return "scan";
  // Removed tabs (Quality Growth, Shortlist, Smart Money, Special) open the Scanner.
  if (
    raw === "nano" ||
    raw === "momentum" ||
    raw === "quality" ||
    raw === "shortlist" ||
    raw === "smart-money" ||
    raw === "special"
  )
    return "scanner";
  if (raw === "review" || raw === "port" || raw === "portfolio-review") {
    return "portfolio";
  }
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
  params.delete("ordersView");
  if (next !== "value") {
    params.delete("v");
    params.delete("ind");
  }
  if (next !== "dashboard") params.delete("d");
  if (next !== "concall-drift") params.delete("drift");
  if (next !== "rotation") params.delete("rot");
  if (next !== "scan") {
    params.delete("scan");
    params.delete("strat");
  }
  if (next !== "watchlist") params.delete("wl");
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

/** All workspace tabs stay on `/` so AppShell does not remount (no flicker). */
export function hrefForTab(next: AppTab): string {
  if (next === "napkin") return "/";
  return `/?tab=${encodeURIComponent(next)}`;
}

function urlForTab(next: AppTab, ticker?: string | null): string {
  // Always home + ?tab= — never /watchlist or /dashboard path hops (those remounted the shell).
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

const APP_TITLE = "Research · India equities";

function syncTabUrl(
  next: AppTab,
  mode: "push" | "replace",
  ticker?: string | null,
) {
  const url = urlForTab(next, ticker);
  if (currentUrl() === url) return;
  if (mode === "push") window.history.pushState(window.history.state, "", url);
  else window.history.replaceState(window.history.state, "", url);
  // Re-assert after History updates so Chrome does not flash the raw URL as the tab title.
  if (document.title !== APP_TITLE) document.title = APP_TITLE;
}

type AppTabContextValue = {
  tab: AppTab;
  setTab: (next: AppTab, opts?: { ticker?: string }) => void;
};

const TabStateContext = createContext<AppTab | null>(null);
const TabSetContext = createContext<AppTabContextValue["setTab"] | null>(null);

export function AppTabProvider({ children }: { children: ReactNode }) {
  // Local state drives the UI. History push/replace keeps Back working.
  // (useSearchParams often does not re-render after our pushState.)
  const [tab, setTabState] = useState<AppTab>("napkin");
  const tabRef = useRef(tab);
  tabRef.current = tab;

  useLayoutEffect(() => {
    const fromUrl = readTabFromLocation();
    if (fromUrl !== tabRef.current) setTabState(fromUrl);
  }, []);

  useEffect(() => {
    const onPop = () => setTabState(readTabFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const setTab = useCallback((next: AppTab, opts?: { ticker?: string }) => {
    const prev = tabRef.current;
    if (next === prev && !opts?.ticker) return;
    setTabState(next);
    // Push when changing tabs so browser Back works. Stay on `/?tab=` (no path hop)
    // so AppShell does not remount. Same-tab updates (ticker) replace.
    syncTabUrl(next, next !== prev ? "push" : "replace", opts?.ticker);
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
