"use client";

import { useState } from "react";

import { APP_TABS, hrefForTab, useAppTab, type AppTab } from "@/lib/app-tab";
import { useAuth } from "@/lib/auth";
import { BrandMark } from "@/components/BrandMark";
import { OllamaBar } from "@/components/OllamaBar";
import { ThemeToggle } from "@/components/ThemeToggle";

export type { AppTab };
export { APP_TABS };

/**
 * Shared topbar + footer. Tab switches stay on `/` + `?tab=` (history push)
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

  return (
    <div className="app">
      <header className="topbar">
        <a
          className="brand brand-btn"
          href="/"
          title="Research"
          onClick={(e) => {
            if (
              e.metaKey ||
              e.ctrlKey ||
              e.shiftKey ||
              e.altKey ||
              e.button !== 0
            ) {
              return;
            }
            e.preventDefault();
            setTab("napkin");
          }}
        >
          <BrandMark />
          <div className="brand-text">
            <div className="brand-name">Research</div>
          </div>
        </a>

        <nav className="tabs" aria-label="Main">
          <div className="tabs-group" role="group" aria-label="Research">
            {APP_TABS.map((t) => (
              <a
                key={t.id}
                className={tab === t.id ? "tab on" : "tab"}
                href={hrefForTab(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                title={t.label}
                onClick={(e) => {
                  if (
                    e.metaKey ||
                    e.ctrlKey ||
                    e.shiftKey ||
                    e.altKey ||
                    e.button !== 0
                  ) {
                    return;
                  }
                  e.preventDefault();
                  setTab(t.id);
                }}
              >
                <span className="tab-label-full">{t.label}</span>
                <span className="tab-label-short">{t.short}</span>
              </a>
            ))}
          </div>
        </nav>

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
