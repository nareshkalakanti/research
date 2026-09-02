"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AgentsPanel } from "@/components/AgentsPanel";
import { GovernanceMapPanel } from "@/components/GovernanceMapPanel";
import { MissingDataPanel } from "@/components/MissingDataPanel";
import { ScanPanel } from "@/components/ScanPanel";
import { StrategyShell } from "@/components/StrategyShell";
import { ThemeScanner } from "@/components/ThemeScanner";
import { useAuth } from "@/lib/auth";

type Tab =
  | "scan"
  | "theme-scanner"
  | "governance"
  | "strategy"
  | "agents"
  | "missing";

const TABS: { id: Tab; label: string }[] = [
  { id: "theme-scanner", label: "Theme Scanner" },
  { id: "scan", label: "Scan" },
  { id: "governance", label: "Governance" },
  { id: "strategy", label: "Strategy" },
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

      <main className="main">
        {tab === "scan" ? (
          <ScanPanel />
        ) : tab === "missing" ? (
          <MissingDataPanel />
        ) : tab === "governance" ? (
          <GovernanceMapPanel />
        ) : tab === "strategy" ? (
          <StrategyShell />
        ) : tab === "agents" ? (
          <AgentsPanel />
        ) : (
          <ThemeScanner />
        )}
      </main>
    </div>
  );
}
