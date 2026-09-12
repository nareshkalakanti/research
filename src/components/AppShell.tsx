"use client";

import { useEffect, useState, type ComponentType } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { AppChrome, useAppTab, type AppTab } from "@/components/AppChrome";
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

export function AppShell() {
  const { user, ready } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { tab } = useAppTab();
  const [visited, setVisited] = useState<Set<AppTab>>(
    () => new Set<AppTab>([tab]),
  );

  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, user, router]);

  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, [tab]);

  // Legacy query redirects
  useEffect(() => {
    const t = searchParams.get("tab");
    if (t === "corporate") {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", "concall");
      params.delete("view");
      router.replace(`/?${params.toString()}`, { scroll: false });
      return;
    }
    if (t === "concall" && searchParams.get("view") === "board") {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("view");
      router.replace(`/?${params.toString()}`, { scroll: false });
      return;
    }
    if (t === "categories") {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("tab");
      const qs = params.toString();
      router.replace(qs ? `/?${qs}` : "/", { scroll: false });
    }
  }, [router, searchParams]);

  if (!ready || !user) {
    return <div className="boot">Loading…</div>;
  }

  const wide = tab === "concall" || tab === "research";

  return (
    <AppChrome wide={wide}>
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
    </AppChrome>
  );
}
