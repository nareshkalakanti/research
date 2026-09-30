"use client";

import { usePathname } from "next/navigation";
import { APP_TABS, hrefForTab, useAppTab } from "@/lib/app-tab";
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
  const { tab } = useAppTab();
  const path = usePathname();

  return (
    <div className="app">
      <header className="topbar">
        <a
          className="brand brand-btn"
          href="/dashboard"
          title="Dashboard"
        >
          <BrandMark />
          <div className="brand-text">
            <div className="brand-name">Research</div>
            <div className="brand-sub">India equities · theme scan</div>
          </div>
        </a>

        <nav className="tabs" aria-label="Main">
          <div className="tabs-group" role="group" aria-label="Research">
            {APP_TABS.map((t) => (
              <a
                key={t.id}
                className={tab === t.id ? "tab on" : "tab"}
                href={hrefForTab(t.id)}
                target="_blank"
                rel="noopener noreferrer"
                title={`${t.label} · new tab`}
              >
                <span className="tab-label-full">{t.label}</span>
                <span className="tab-label-short">{t.short}</span>
              </a>
            ))}
            <a
              className={(path ?? "").startsWith("/portfolio") ? "tab on" : "tab"}
              href="/portfolio"
              target="_blank"
              rel="noopener noreferrer"
              title="Holdings mean-variance · new tab"
            >
              <span className="tab-label-full">Portfolio</span>
              <span className="tab-label-short">P*</span>
            </a>
          </div>
        </nav>

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
