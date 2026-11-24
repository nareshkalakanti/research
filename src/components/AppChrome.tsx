"use client";

import { useState } from "react";

import { APP_TABS, hrefForTab, useAppTab, type AppTab } from "@/lib/app-tab";
import { useAuth } from "@/lib/auth";
import { BrandMark } from "@/components/BrandMark";
import { NavIcon } from "@/components/NavIcon";
import { OllamaBar } from "@/components/OllamaBar";
import { ThemeToggle } from "@/components/ThemeToggle";

export type { AppTab };
export { APP_TABS };

/**
 * Shared left navigation, slim top bar and footer. Tab switches stay on `/` + `?tab=` (history push)
 * so Back works and AppShell is not remounted.
 */
export function AppChrome({
  children,
  wide: _wide = false,
  layout: _layout,
}: {
  children: React.ReactNode;
  /** @deprecated all pages share the same width now */
  wide?: boolean;
  /** @deprecated all pages share the same width now */
  layout?: "default" | "wide" | "tracker";
}) {
  const { user, logout } = useAuth();
  const { tab, setTab } = useAppTab();

  const go = (e: React.MouseEvent, id: AppTab) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    setTab(id);
  };
  const current = APP_TABS.find((t) => t.id === tab);

  return (
    <div className="app app--side">
      <aside className="side-nav" aria-label="Main">
        <a
          className="side-nav-brand"
          href="/"
          title="Research · India equities"
          onClick={(e) => go(e, "napkin")}
        >
          <BrandMark />
        </a>
        <nav className="side-nav-list">
          {APP_TABS.map((t) => (
            <a
              key={t.id}
              className={tab === t.id ? "side-nav-item on" : "side-nav-item"}
              href={hrefForTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              title={t.label}
              onClick={(e) => go(e, t.id)}
            >
              <NavIcon tab={t.id} />
              <span className="side-nav-label">{t.label}</span>
            </a>
          ))}
        </nav>
      </aside>

      <div className="app-body">
        <header className="topbar topbar--slim">
          <div className="topbar-title">
            <span className="brand-name">{current?.label ?? "Research"}</span>
            <span className="brand-sub">Research · India equities</span>
          </div>
          <div className="user-block">
            <RefreshButton />
            <ThemeToggle />
            <OllamaBar />
            {user ? (
              <span className="user-email" title={user}>
                {user}
              </span>
            ) : null}
            {user ? (
              <button type="button" className="btn-ghost btn-logout" onClick={logout}>
                Log out
              </button>
            ) : null}
          </div>
        </header>

        <main className="main">{children}</main>

        <footer className="app-footer">
          <span>Research · local data</span>
          <span className="app-footer-sep" aria-hidden>
            ·
          </span>
          <span>Refresh NSE/BSE only when you need live filings</span>
        </footer>
      </div>
    </div>
  );
}

/**
 * Refresh: clear the server's cached lists/prices, then reload the open tab's
 * data (AppShell remounts the active panel on "app:refresh").
 */
function RefreshButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost btn-refresh"
      disabled={busy}
      aria-busy={busy}
      title="Reload this page's data (clears cached lists and prices)"
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/refresh", { method: "POST" });
        } catch {
          /* still reload the panel */
        }
        window.dispatchEvent(new Event("app:refresh"));
        window.setTimeout(() => setBusy(false), 600);
      }}
    >
      <span className={busy ? "btn-refresh-icon spin" : "btn-refresh-icon"} aria-hidden>
        ↻
      </span>
      <span className="btn-refresh-label">Refresh</span>
    </button>
  );
}
