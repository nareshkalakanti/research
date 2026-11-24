"use client";

import { useState, useSyncExternalStore } from "react";

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
  // Sidebar hidden / shown, remembered across visits.
  const navHidden = useSyncExternalStore(subscribeNav, readNavHidden, () => false);
  const toggleNav = () => writeNavHidden(!navHidden);

  return (
    <div className={navHidden ? "app app--side nav-hidden" : "app app--side"}>
      <aside className="side-nav" aria-label="Main" hidden={navHidden}>
        <a
          className="side-nav-brand"
          href="/"
          title="Research"
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
            <button
              type="button"
              className="side-nav-toggle"
              onClick={toggleNav}
              aria-expanded={!navHidden}
              title={navHidden ? "Show menu" : "Hide menu"}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="M4 6h16 M4 12h16 M4 18h16" />
              </svg>
            </button>
            <span className="brand-name">{current?.label ?? "Research"}</span>
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

const NAV_KEY = "side-nav-hidden";
const navListeners = new Set<() => void>();
/** Used when localStorage is blocked, so the toggle still works for this visit. */
let navHiddenMem = false;

function subscribeNav(cb: () => void): () => void {
  navListeners.add(cb);
  return () => navListeners.delete(cb);
}

function readNavHidden(): boolean {
  try {
    return window.localStorage.getItem(NAV_KEY) === "1";
  } catch {
    return navHiddenMem;
  }
}

function writeNavHidden(hidden: boolean): void {
  navHiddenMem = hidden;
  try {
    window.localStorage.setItem(NAV_KEY, hidden ? "1" : "0");
  } catch {
    /* storage blocked: navHiddenMem keeps the choice for this visit */
  }
  navListeners.forEach((cb) => cb());
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
