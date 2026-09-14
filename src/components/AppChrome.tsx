"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";

export type AppTab =
  | "scan"
  | "theme-scanner"
  | "governance"
  | "concall"
  | "marketiq"
  | "orderbookiq"
  | "boardroomiq"
  | "missing"
  | "research";

export const APP_TABS: { id: AppTab; label: string; short?: string }[] = [
  { id: "theme-scanner", label: "Theme" },
  { id: "scan", label: "Scan" },
  { id: "governance", label: "Governance", short: "Gov" },
  { id: "concall", label: "Concall" },
  { id: "marketiq", label: "MarketIQ", short: "Market" },
  { id: "orderbookiq", label: "OrderBookIQ", short: "BookIQ" },
  { id: "boardroomiq", label: "BoardRoomIQ", short: "BoardIQ" },
  { id: "research", label: "Research" },
  { id: "missing", label: "Missing data", short: "Missing" },
];

const ROUTES: { href: string; label: string; match: (p: string) => boolean }[] =
  [
    { href: "/fund", label: "Fund", match: (p) => p === "/fund" },
    { href: "/order-tracker", label: "Orders", match: (p) => p === "/order-tracker" },
    { href: "/watchlist", label: "Watchlist", match: (p) => p === "/watchlist" },
  ];

function tabFromParam(raw: string | null): AppTab {
  if (raw === "ht") return "scan";
  if (raw === "strategy" || raw === "buyback" || raw === "corporate") {
    return "concall";
  }
  if (raw === "categories") return "theme-scanner";
  if (raw && APP_TABS.some((t) => t.id === raw)) return raw as AppTab;
  return "theme-scanner";
}

export function useAppTab(): {
  tab: AppTab;
  setTab: (next: AppTab) => void;
} {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = tabFromParam(searchParams.get("tab"));

  const setTab = useCallback(
    (next: AppTab) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "theme-scanner") params.delete("tab");
      else params.set("tab", next);
      if (next !== "concall") params.delete("view");
      if (next !== "governance") {
        params.delete("personId");
        params.delete("din");
      }
      const qs = params.toString();
      router.replace(qs ? `/?${qs}` : "/", { scroll: false });
    },
    [router, searchParams],
  );

  return { tab, setTab };
}

/**
 * Shared topbar + footer for home tabs and standalone routes
 * (Orders / Watchlist / Fund). All pages use the same wide shell.
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
          <span className="brand-mark">R</span>
          <div>
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
                title={t.short ? t.label : undefined}
                onClick={() => {
                  if (onHome) setTab(t.id);
                  else {
                    router.push(
                      t.id === "theme-scanner" ? "/" : `/?tab=${t.id}`,
                    );
                  }
                }}
              >
                {t.short ? (
                  <>
                    <span className="tab-label-full">{t.label}</span>
                    <span className="tab-label-short">{t.short}</span>
                  </>
                ) : (
                  t.label
                )}
              </button>
            ))}
          </div>
          <span className="tabs-sep" aria-hidden />
          <div className="tabs-group tabs-group-routes" role="group" aria-label="Workspace">
            {ROUTES.map((r) => (
              <button
                key={r.href}
                type="button"
                className={r.match(pathname) ? "tab on" : "tab"}
                onClick={() => router.push(r.href)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </nav>

        <div className="user-block">
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
