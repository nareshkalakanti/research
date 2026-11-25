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
  // Quiet placeholder — never full-page Loading (that flickered the chrome on tab switch).
  return <Loading variant="block" label="Loading" rows={2} />;
}

const StrategyPanel = dynamic(
  () => import("@/components/StrategyPanel").then((m) => m.StrategyPanel),
  { loading: PanelFallback, ssr: false },
);
const GovernanceMapPanel = dynamic(
  () =>
    import("@/components/GovernanceMapPanel").then(
      (m) => m.GovernanceMapPanel,
    ),
  { loading: PanelFallback, ssr: false },
);
const ResearchPanel = dynamic(
  () => import("@/components/ResearchPanel").then((m) => m.ResearchPanel),
  { loading: PanelFallback, ssr: false },
);

const WatchlistPanel = dynamic(
  () => import("@/components/WatchlistPanel").then((m) => m.WatchlistPanel),
  { loading: PanelFallback, ssr: false },
);

const ValuePanel = dynamic(
  () => import("@/components/ValuePanel").then((m) => m.ValuePanel),
  { loading: PanelFallback, ssr: false },
);

const PortfolioPanel = dynamic(
  () => import("@/components/PortfolioPanel").then((m) => m.PortfolioPanel),
  { loading: PanelFallback, ssr: false },
);

const ScannerPanel = dynamic(
  () => import("@/components/ScannerPanel").then((m) => m.ScannerPanel),
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

const PriceActionPanel = dynamic(
  () => import("@/components/PriceActionPanel").then((m) => m.PriceActionPanel),
  { loading: PanelFallback, ssr: false },
);

const BreakoutsPanel = dynamic(
  () => import("@/components/BreakoutsPanel").then((m) => m.BreakoutsPanel),
  { loading: PanelFallback, ssr: false },
);

const PANELS: Record<AppTab, ComponentType> = {
  dashboard: FamilyDashboard,
  scan: StrategyPanel,
  governance: GovernanceMapPanel,
  napkin: NapkinPanel,
  "concall-drift": ConcallDriftPanel,
  rotation: SectorRotationPanel,
  "price-action": PriceActionPanel,
  breakouts: BreakoutsPanel,
  research: ResearchPanel,
  watchlist: WatchlistPanel,
  scanner: ScannerPanel,
  value: ValuePanel,
  portfolio: PortfolioPanel,
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
  void import("@/components/StrategyPanel");
  void import("@/components/GovernanceMapPanel");
}

function AppShellPanels() {
  const { tab } = useAppTab();
  const [visited, setVisited] = useState<Set<AppTab>>(
    () => new Set<AppTab>([tab]),
  );

  // Keep the open tab in `visited` during render (not only in useEffect) so a
  // refresh on /?tab=value does not paint a blank panel before effects run.
  const panels = visited.has(tab) ? visited : new Set([...visited, tab]);

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

  // Keep Scanner data (results, ROCE/ROE) and Screener fund lists fresh while the app is open: ping on load and
  // every 30 min; the server only runs what is due and skips if busy.
  useEffect(() => {
    const ping = () => {
      void fetch("/api/baskets-refresh", { method: "POST" }).catch(() => {
        /* best effort */
      });
    };
    const first = window.setTimeout(ping, 20_000);
    const every = window.setInterval(ping, 30 * 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, []);

  // Top-bar Refresh: remount the open tab now; every other tab kept in memory
  // is marked stale and remounts when next opened (one at a time, not all at once).
  const [nonce, setNonce] = useState<Partial<Record<AppTab, number>>>({});
  const [stale, setStale] = useState<Set<AppTab>>(() => new Set());
  useEffect(() => {
    const onRefresh = () => {
      setNonce((n) => ({ ...n, [tab]: (n[tab] ?? 0) + 1 }));
      setStale(new Set([...visited].filter((t) => t !== tab)));
    };
    window.addEventListener("app:refresh", onRefresh);
    return () => window.removeEventListener("app:refresh", onRefresh);
  }, [tab, visited]);
  // Opening a stale tab: remount it so it reloads its data.
  const [lastTab, setLastTab] = useState(tab);
  if (lastTab !== tab) {
    setLastTab(tab);
    if (stale.has(tab)) {
      setNonce((n) => ({ ...n, [tab]: (n[tab] ?? 0) + 1 }));
      setStale((prev) => {
        const next = new Set(prev);
        next.delete(tab);
        return next;
      });
    }
  }

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
      {[...panels].map((id) => {
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
            <KeptPanel key={nonce[id] ?? 0} Panel={Panel} />
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
      window.history.replaceState(window.history.state, "", "/?tab=watchlist");
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
