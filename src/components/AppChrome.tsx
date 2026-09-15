"use client";

import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { APP_TABS, useAppTab, type AppTab } from "@/lib/app-tab";
import { BrandMark } from "@/components/BrandMark";
import { OllamaBar } from "@/components/OllamaBar";

export type { AppTab };
export { APP_TABS };

const ROUTES: {
  href: string;
  label: string;
  short: string;
  match: (p: string) => boolean;
}[] = [
  {
    href: "/watchlist",
    label: "Watchlist",
    short: "Watch",
    match: (p) => p === "/watchlist",
  },
  { href: "/fund", label: "Fund", short: "Fund", match: (p) => p === "/fund" },
];

/**
 * Shared topbar + footer for home tabs and standalone routes
 * (Watchlist / Fund). All pages use the same wide shell.
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
  const router = useRouter();
  const pathname = usePathname() || "/";
  const { tab, setTab } = useAppTab();
  const onHome = pathname === "/";

  return (
    <div className="app">
      <header className="topbar">
        <button
          type="button"
          className="brand brand-btn"
          onClick={() => router.push("/")}
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
                className={onHome && tab === t.id ? "tab on" : "tab"}
                title={t.label}
                onClick={() => {
                  if (onHome) setTab(t.id);
                  else {
                    router.push(
                      t.id === "theme-scanner" ? "/" : `/?tab=${t.id}`,
                    );
                  }
                }}
              >
                <span className="tab-label-full">{t.label}</span>
                <span className="tab-label-short">{t.short}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="tabs-routes" role="group" aria-label="Workspace">
          {ROUTES.map((r) => (
            <button
              key={r.href}
              type="button"
              className={r.match(pathname) ? "tab on" : "tab"}
              title={r.label}
              onClick={() => router.push(r.href)}
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
