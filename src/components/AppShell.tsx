"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AgentsPanel } from "@/components/AgentsPanel";
import { GovernanceMapPanel } from "@/components/GovernanceMapPanel";
import { InvestorsPanel } from "@/components/InvestorsPanel";
import { MissingDataPanel } from "@/components/MissingDataPanel";
import { ScanPanel } from "@/components/ScanPanel";
import { ThemeScanner } from "@/components/ThemeScanner";
import { WatchingPanel } from "@/components/WatchingPanel";
import { useAuth } from "@/lib/auth";

type Tab =
  | "watching"
  | "scan"
  | "theme-scanner"
  | "governance"
  | "investors"
  | "agents"
  | "missing";

const TABS: { id: Tab; label: string }[] = [
  { id: "watching", label: "Watching" },
  { id: "scan", label: "Scan" },
  { id: "theme-scanner", label: "Theme Scanner" },
  { id: "governance", label: "Governance" },
  { id: "investors", label: "Investors" },
  { id: "agents", label: "Agents" },
  { id: "missing", label: "Missing data" },
];

export function AppShell() {
  const { user, ready, logout } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("theme-scanner");

  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, user, router]);

  if (!ready || !user) {
    return <div className="boot">Loading…</div>;
  }

  return (
    <div className="app">
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

      <main className={tab === "investors" ? "main main-wide" : "main"}>
        {tab === "watching" ? (
          <WatchingPanel />
        ) : tab === "scan" ? (
          <ScanPanel />
        ) : tab === "missing" ? (
          <MissingDataPanel />
        ) : tab === "governance" ? (
          <GovernanceMapPanel />
        ) : tab === "investors" ? (
          <InvestorsPanel />
        ) : tab === "agents" ? (
          <AgentsPanel />
        ) : (
          <ThemeScanner />
        )}
      </main>
    </div>
  );
}
