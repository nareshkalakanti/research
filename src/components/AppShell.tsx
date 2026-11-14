"use client";

import { Loading } from "@/components/Loading";
import { memo, useEffect, useState, type ComponentType } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { AppChrome } from "@/components/AppChrome";
import {
  AppTabProvider,
  useAppTab,
  type AppTab,
} from "@/lib/app-tab";
import { useAuth } from "@/lib/auth";

function PanelFallback() {
  // Quiet placeholder inside an already-mounted chrome — avoid full-page flash.
  return <Loading variant="page" />;
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

const WatchlistPanel = dynamic(
  () => import("@/components/WatchlistPanel").then((m) => m.WatchlistPanel),
  { loading: PanelFallback, ssr: false },
);

const ListedVenturePanel = dynamic(
  () =>
    import("@/components/ListedVentureScreen").then((m) => m.ListedVenturePanel),
  { loading: PanelFallback, ssr: false },
);

const FamilyDashboard = dynamic(
  () => import("@/components/FamilyDashboard").then((m) => m.FamilyDashboard),
  { loading: PanelFallback, ssr: false },
);

const NapkinPanel = dynamic(
  () => import("@/components/napkin/NapkinPanel").then((m) => m.NapkinPanel),
  { loading: PanelFallback, ssr: false },
);

const ConcallDriftPanel = dynamic(
  () =>
    import("@/components/ConcallDriftPanel").then((m) => m.ConcallDriftPanel),
  { loading: PanelFallback, ssr: false },
);

const SectorRotationPanel = dynamic(
  () =>
    import("@/components/SectorRotationPanel").then(
      (m) => m.SectorRotationPanel,
    ),
  { loading: PanelFallback, ssr: false },
);

const ValuePickrSignalsPanel = dynamic(
  () =>
    import("@/components/ValuePickrSignalsPanel").then(
      (m) => m.ValuePickrSignalsPanel,
    ),
  { loading: PanelFallback, ssr: false },
);

const PANELS: Record<AppTab, ComponentType> = {
  dashboard: FamilyDashboard,
  "theme-scanner": ThemeScanner,
  scan: ScanPanel,
  governance: GovernanceMapPanel,
  napkin: NapkinPanel,
  "concall-drift": ConcallDriftPanel,
  signals: ValuePickrSignalsPanel,
  rotation: SectorRotationPanel,
  marketiq: MarketIqPanel,
  orderbookiq: OrderBookIqPanel,
  boardroomiq: BoardRoomIqPanel,
  research: ResearchPanel,
  missing: MissingDataPanel,
  watchlist: WatchlistPanel,
  lv: ListedVenturePanel,
};

const KeptPanel = memo(function KeptPanel({
  Panel,
}: {
  Panel: ComponentType;
}) {
  return <Panel />;
});

function preloadPanelModules() {
  void import("@/components/WatchlistPanel");
  void import("@/components/ScanPanel");
  void import("@/components/ThemeScanner");
  void import("@/components/GovernanceMapPanel");
}

function AppShellPanels() {
  const { tab } = useAppTab();
  const [visited, setVisited] = useState<Set<AppTab>>(
    () => new Set<AppTab>([tab]),
  );

  useEffect(() => {
    setVisited((prev) => {
      const next = new Set(prev);
      // Drop Research when leaving so open researcher state does not linger.
      if (tab !== "research") next.delete("research");
      if (next.has(tab)) return next.size === prev.size ? prev : next;
      next.add(tab);
      return next;
    });
  }, [tab]);

  useEffect(() => {
    const run = () => preloadPanelModules();
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
        if (!Panel) return null;
        const active = id === tab;
        return (
          <div
            key={id}
            className={active ? "tab-panel is-active" : "tab-panel"}
            hidden={!active}
            inert={!active ? true : undefined}
          >
            <KeptPanel Panel={Panel} />
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

  // Legacy query redirects (one-time on load) — history only, do not remount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    if (t === "corporate" || t === "buyback") {
      window.history.replaceState(window.history.state, "", "/watchlist");
      return;
    }
    if (t === "pead") {
      params.delete("tab");
      const qs = params.toString();
      window.history.replaceState(window.history.state, "", qs ? `/?${qs}` : "/");
      return;
    }
    if (t === "concall" || t === "strategy" || t === "drift") {
      params.set("tab", "concall-drift");
      const qs = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        qs ? `/?${qs}` : "/?tab=concall-drift",
      );
      return;
    }
    if (t === "categories") {
      params.set("tab", "theme-scanner");
      const qs = params.toString();
      window.history.replaceState(window.history.state, "", qs ? `/?${qs}` : "/");
      return;
    }
    if (t === "radar") {
      params.delete("tab");
      const qs = params.toString();
      window.history.replaceState(window.history.state, "", qs ? `/?${qs}` : "/");
    }
  }, []);

  if (!ready || !user) {
    return <Loading variant="page" />;
  }

  return (
    <AppTabProvider>
      <AppChrome>
        <AppShellPanels />
      </AppChrome>
    </AppTabProvider>
  );
}
