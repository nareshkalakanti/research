"use client";

import { useEffect, useState, type ComponentType } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { AppChrome } from "@/components/AppChrome";
import {
  AppTabProvider,
  IQ_TABS,
  useAppTab,
  type AppTab,
} from "@/lib/app-tab";
import { useAuth } from "@/lib/auth";

function PanelFallback() {
  return <div className="boot panel-boot">Loading…</div>;
}

const ThemeScanner = dynamic(
  () =>
    import("@/components/ThemeScanner").then((m) => m.ThemeScanner),
  { loading: PanelFallback, ssr: false },
);
const ScanPanel = dynamic(
  () => import("@/components/ScanPanel").then((m) => m.ScanPanel),
  { loading: PanelFallback, ssr: false },
);
const GovernanceMapPanel = dynamic(
  () =>
    import("@/components/GovernanceMapPanel").then(
      (m) => m.GovernanceMapPanel,
    ),
  { loading: PanelFallback, ssr: false },
);
const StrategyPanel = dynamic(
  () => import("@/components/StrategyPanel").then((m) => m.StrategyPanel),
  { loading: PanelFallback, ssr: false },
);
const MarketIqPanel = dynamic(
  () => import("@/components/MarketIqPanel").then((m) => m.MarketIqPanel),
  { loading: PanelFallback, ssr: false },
);
const OrderBookIqPanel = dynamic(
  () =>
    import("@/components/OrderBookIqPanel").then((m) => m.OrderBookIqPanel),
  { loading: PanelFallback, ssr: false },
);
const BoardRoomIqPanel = dynamic(
  () =>
    import("@/components/BoardRoomIqPanel").then((m) => m.BoardRoomIqPanel),
  { loading: PanelFallback, ssr: false },
);
const ResearchPanel = dynamic(
  () => import("@/components/ResearchPanel").then((m) => m.ResearchPanel),
  { loading: PanelFallback, ssr: false },
);
const MissingDataPanel = dynamic(
  () =>
    import("@/components/MissingDataPanel").then((m) => m.MissingDataPanel),
  { loading: PanelFallback, ssr: false },
);

const PANELS: Record<AppTab, ComponentType> = {
  "theme-scanner": ThemeScanner,
  scan: ScanPanel,
  governance: GovernanceMapPanel,
  concall: StrategyPanel,
  marketiq: MarketIqPanel,
  orderbookiq: OrderBookIqPanel,
  boardroomiq: BoardRoomIqPanel,
  research: ResearchPanel,
  missing: MissingDataPanel,
};

function preloadIqPanels() {
  void import("@/components/StrategyPanel");
  void import("@/components/MarketIqPanel");
  void import("@/components/OrderBookIqPanel");
  void import("@/components/BoardRoomIqPanel");
}

function AppShellPanels() {
  const { tab } = useAppTab();
  const [visited, setVisited] = useState<Set<AppTab>>(
    () => new Set<AppTab>([tab]),
  );

  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, [tab]);

  // Keep all IQ panels mounted once any IQ tab is opened — instant IQ switching.
  useEffect(() => {
    if (!IQ_TABS.includes(tab)) return;
    setVisited((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of IQ_TABS) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    preloadIqPanels();
  }, [tab]);

  useEffect(() => {
    const run = () => preloadIqPanels();
    if (typeof requestIdleCallback !== "undefined") {
      const id = requestIdleCallback(run);
      return () => cancelIdleCallback(id);
    }
    const t = window.setTimeout(run, 400);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="tab-panels">
      {[...visited].map((id) => {
        const Panel = PANELS[id];
        const active = id === tab;
        return (
          <div
            key={id}
            className={active ? "tab-panel is-active" : "tab-panel"}
            hidden={!active}
            inert={!active ? true : undefined}
          >
            <Panel />
          </div>
        );
      })}
    </div>
  );
}

export function AppShell() {
  const { user, ready } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, user, router]);

  // Legacy query redirects (one-time on load).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    if (t === "corporate") {
      params.set("tab", "concall");
      params.delete("view");
      router.replace(`/?${params.toString()}`, { scroll: false });
      return;
    }
    if (t === "concall" && params.get("view") === "board") {
      params.delete("view");
      router.replace(`/?${params.toString()}`, { scroll: false });
      return;
    }
    if (t === "categories") {
      params.delete("tab");
      const qs = params.toString();
      router.replace(qs ? `/?${qs}` : "/", { scroll: false });
    }
  }, [router]);

  if (!ready || !user) {
    return <div className="boot">Loading…</div>;
  }

  return (
    <AppTabProvider>
      <AppChrome>
        <AppShellPanels />
      </AppChrome>
    </AppTabProvider>
  );
}
