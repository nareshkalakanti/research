"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ResearchPanel } from "@/components/ResearchPanel";
import { GovernanceMapPanel } from "@/components/GovernanceMapPanel";
import { MissingDataPanel } from "@/components/MissingDataPanel";
import { MarketIqPanel } from "@/components/MarketIqPanel";
import { OrderBookIqPanel } from "@/components/OrderBookIqPanel";
import { BoardRoomIqPanel } from "@/components/BoardRoomIqPanel";
import { ScanPanel } from "@/components/ScanPanel";
import { StrategyPanel } from "@/components/StrategyPanel";
import { ThemeScanner } from "@/components/ThemeScanner";
import { useAuth } from "@/lib/auth";

type Tab =
  | "scan"
  | "theme-scanner"
  | "governance"
  | "concall"
  | "marketiq"
  | "orderbookiq"
  | "boardroomiq"
  | "missing"
  | "research";

const TABS: { id: Tab; label: string }[] = [
  { id: "theme-scanner", label: "Theme" },
  { id: "scan", label: "Scan" },
  { id: "governance", label: "Governance" },
  { id: "concall", label: "Concall" },
  { id: "marketiq", label: "MarketIQ" },
  { id: "orderbookiq", label: "OrderBookIQ" },
  { id: "boardroomiq", label: "BoardRoomIQ" },
  { id: "research", label: "Research" },
  { id: "missing", label: "Missing data" },
];

const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

function tabFromParam(raw: string | null): Tab {
  // Old deep-links
  if (raw === "ht") return "scan";
  if (raw === "strategy" || raw === "buyback" || raw === "corporate") {
    return "concall";
  }
  if (raw === "categories") return "theme-scanner";
  if (raw && TAB_IDS.has(raw)) return raw as Tab;
  return "theme-scanner";
}

export function AppShell() {
  const { user, ready, logout } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTabState] = useState<Tab>(() =>
    tabFromParam(searchParams.get("tab")),
  );
  const concallWide = tab === "concall";
  const researchWide = tab === "research";
  const wideMain = concallWide || researchWide;

  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, user, router]);

  useEffect(() => {
    setTabState(tabFromParam(searchParams.get("tab")));
  }, [searchParams]);

  // Legacy ?tab=corporate → Concall (DIN/extract UI removed)
  useEffect(() => {
    if (searchParams.get("tab") !== "corporate") return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "concall");
    params.delete("view");
    router.replace(`/?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  // Legacy ?view=board on Concall — extract tab removed
  useEffect(() => {
    if (searchParams.get("tab") !== "concall") return;
    if (searchParams.get("view") !== "board") return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("view");
    router.replace(`/?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  // Legacy ?tab=categories removed
  useEffect(() => {
    if (searchParams.get("tab") !== "categories") return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tab");
    const qs = params.toString();
    router.replace(qs ? `/?${qs}` : "/", { scroll: false });
  }, [router, searchParams]);

  const setTab = useCallback(
    (next: Tab) => {
      setTabState(next);
      const params = new URLSearchParams(searchParams.toString());
      if (next === "theme-scanner") params.delete("tab");
      else params.set("tab", next);
      if (next !== "concall") params.delete("view");
      const qs = params.toString();
      router.replace(qs ? `/?${qs}` : "/", { scroll: false });
    },
    [router, searchParams],
  );

  if (!ready || !user) {
    return <div className="boot">Loading…</div>;
  }

  return (
    <div className={wideMain ? "app app-corporate" : "app"}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">R</span>
          <div>
            <div className="brand-name">Research</div>
            <div className="brand-sub">India equities · theme scan</div>
          </div>
        </div>

        <nav className="tabs" aria-label="Main">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? "tab on" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="user-block">
          <span className="user-email">{user}</span>
          <button type="button" className="btn-ghost" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      <main className={wideMain ? "main main-corporate" : "main"}>
        {tab === "scan" ? (
          <ScanPanel />
        ) : tab === "missing" ? (
          <MissingDataPanel />
        ) : tab === "governance" ? (
          <GovernanceMapPanel />
        ) : tab === "concall" ? (
          <StrategyPanel />
        ) : tab === "marketiq" ? (
          <MarketIqPanel />
        ) : tab === "orderbookiq" ? (
          <OrderBookIqPanel />
        ) : tab === "boardroomiq" ? (
          <BoardRoomIqPanel />
        ) : tab === "research" ? (
          <ResearchPanel />
        ) : (
          <ThemeScanner />
        )}
      </main>
    </div>
  );
}
