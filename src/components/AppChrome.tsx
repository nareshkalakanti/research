"use client";

import { APP_TABS, PAGE_TABS, useAppTab, type AppTab } from "@/lib/app-tab";
import { useAuth } from "@/lib/auth";
import { BrandMark } from "@/components/BrandMark";
import { OllamaBar } from "@/components/OllamaBar";

export type { AppTab };
export { APP_TABS };

/**
 * Shared topbar + footer. Tab/page switches stay in the same client shell
 * (history API only) so panels are not remounted.
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
        <button
          type="button"
          className="brand brand-btn"
          onClick={() => setTab("theme-scanner")}
          title="Home"
        >
          <BrandMark />
          <div className="brand-text">
            <div className="brand-name">Research</div>
            <div className="brand-sub">India equities · theme scan</div>
          </div>
        </button>

        <nav className="tabs" aria-label="Main">
          <div className="tabs-group" role="group" aria-label="Research">
            {APP_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={tab === t.id ? "tab on" : "tab"}
                title={t.label}
                onClick={() => setTab(t.id)}
              >
                <span className="tab-label-full">{t.label}</span>
                <span className="tab-label-short">{t.short}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="tabs-routes" role="group" aria-label="Workspace">
          {PAGE_TABS.map((r) => (
            <button
              key={r.id}
              type="button"
              className={tab === r.id ? "tab on" : "tab"}
              title={r.label}
              onClick={() => setTab(r.id)}
            >
              <span className="tab-label-full">{r.label}</span>
              <span className="tab-label-short">{r.short}</span>
            </button>
          ))}
        </div>

        <div className="user-block">
          <OllamaBar />
          {user ? <span className="user-email">{user}</span> : null}
          {user ? (
            <button type="button" className="btn-ghost" onClick={logout}>
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
