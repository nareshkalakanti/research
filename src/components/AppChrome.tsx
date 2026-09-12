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

export const APP_TABS: { id: AppTab; label: string }[] = [
  { id: "theme-scanner", label: "Theme" },
  { id: "scan", label: "Scan" },
  { id: "governance", label: "Governance" },
  { id: "concall", label: "Concall" },
  { id: "marketiq", label: "MarketIQ" },
  { id: "orderbookiq", label: "OrderBookIQ" },
  { id: "boardroomiq", label: "BoardRoomIQ" },
  { id: "research", label: "Research" },
  { id: "missing", label: "Missing data" },
];

const ROUTES: { href: string; label: string; match: (p: string) => boolean }[] =
  [
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
 * (Orders / Watchlist).
 */
export function AppChrome({
  children,
  wide = false,
  layout,
}: {
  children: React.ReactNode;
  /** @deprecated prefer `layout` — true maps to corporate width */
  wide?: boolean;
  layout?: "default" | "wide" | "tracker";
}) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname() || "/";
  const { tab, setTab } = useAppTab();
  const onHome = pathname === "/";
  const shell =
    layout ?? (wide ? "wide" : "default");
  const mainClass =
    shell === "tracker"
      ? "main main-tracker"
      : shell === "wide"
        ? "main main-corporate"
        : "main";
  const appClass =
    shell === "default" ? "app" : "app app-corporate";

  return (
    <div className={appClass}>
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
          {APP_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={onHome && tab === t.id ? "tab on" : "tab"}
              onClick={() => {
                if (onHome) setTab(t.id);
                else {
                  router.push(
                    t.id === "theme-scanner" ? "/" : `/?tab=${t.id}`,
                  );
                }
              }}
            >
              {t.label}
            </button>
          ))}
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

      <main className={mainClass}>{children}</main>

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
