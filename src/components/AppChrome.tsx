"use client";

import { useEffect, useState } from "react";

import { APP_GROUPS, APP_TABS, groupOfTab, hrefForTab, useAppTab, type AppTab } from "@/lib/app-tab";
import { useAuth } from "@/lib/auth";
import { BrandMark } from "@/components/BrandMark";
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
  const group = groupOfTab(tab);
  // Last page opened in each group: clicking a group reopens it.
  useEffect(() => {
    try {
      localStorage.setItem(`app_group_last:${group.id}`, tab);
    } catch {
      /* private mode */
    }
  }, [group.id, tab]);
  const openGroup = (gid: string) => {
    const g = APP_GROUPS.find((x) => x.id === gid)!;
    let next: AppTab = g.tabs[0]!.id;
    try {
      const saved = localStorage.getItem(`app_group_last:${gid}`) as AppTab | null;
      if (saved && g.tabs.some((t) => t.id === saved)) next = saved;
    } catch {
      /* private mode */
    }
    setTab(next);
  };
  const plainClick = (e: React.MouseEvent) => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);

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
          <div className="tabs-group" role="group" aria-label="Sections">
            {APP_GROUPS.map((g) => (
              <a
                key={g.id}
                className={group.id === g.id ? "tab on" : "tab"}
                href={hrefForTab(g.tabs[0]!.id)}
                aria-current={group.id === g.id ? "page" : undefined}
                title={g.tabs.map((t) => t.label).join(" · ")}
                onClick={(e) => {
                  if (!plainClick(e)) return;
                  e.preventDefault();
                  openGroup(g.id);
                }}
              >
                <span className="tab-label-full">{g.label}</span>
                <span className="tab-label-short">{g.short}</span>
              </a>
            ))}
          </div>
        </nav>

        {group.tabs.length > 1 ? (
          <nav className="subtabs" aria-label={group.label}>
            {group.tabs.map((t) => (
              <a
                key={t.id}
                className={tab === t.id || (t.id === "dashboard" && tab === "governance") ? "subtab on" : "subtab"}
                href={hrefForTab(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                onClick={(e) => {
                  if (!plainClick(e)) return;
                  e.preventDefault();
                  setTab(t.id);
                }}
              >
                {t.label}
              </a>
            ))}
          </nav>
        ) : null}

        <div className="user-block">
          <RefreshButton />
          <ThemeToggle />
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
