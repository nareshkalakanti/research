"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { APP_GROUPS, APP_TABS, groupOfTab, hrefForTab, useAppTab, type AppGroup, type AppGroupItem, type AppTab } from "@/lib/app-tab";
import { useAuth } from "@/lib/auth";
import { BrandMark } from "@/components/BrandMark";
import { TickerSuggest } from "@/components/TickerSuggest";
import { ThemeToggle } from "@/components/ThemeToggle";
import { napkinUrl } from "@/lib/links";

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
  /** Open dropdown: its group id and where to draw it (the nav strip scrolls, so the menu is fixed to the window). */
  const [menu, setMenu] = useState<{ id: string; left: number; top: number } | null>(null);
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

  const userLabel = user ? user.split("@")[0] || user : null;
  const userInitial = userLabel ? userLabel.slice(0, 1).toUpperCase() : "?";

  return (
    <div className="app">
      <header className="topbar">
        <a
          className="brand brand-btn"
          href="/"
          title="Research"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            setTab("napkin");
          }}
        >
          <BrandMark />
          <div className="brand-text">
            <div className="brand-name">Research</div>
            <div className="brand-sub">India equities</div>
          </div>
        </a>

        <HeaderSearch />

        <nav className="tabs" aria-label="Main">
          <div className="tabs-group" role="group" aria-label="Sections">
            {APP_GROUPS.map((g) =>
              g.tabs.length > 1 ? (
                <button
                  key={g.id}
                  type="button"
                  className={group.id === g.id ? "tab on" : "tab"}
                  title={g.label}
                  aria-label={g.label}
                  aria-haspopup="menu"
                  aria-expanded={menu?.id === g.id}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu((m) => (m?.id === g.id ? null : { id: g.id, left: r.left, top: r.bottom + 6 }));
                  }}
                >
                  <GroupIcon gid={g.id} />
                  <span className="tab-label">{g.short}</span>
                  <span className="tab-caret" aria-hidden>
                    ▾
                  </span>
                </button>
              ) : (
                <a
                  key={g.id}
                  className={group.id === g.id ? "tab on" : "tab"}
                  href={hrefForTab(g.tabs[0]!.id)}
                  title={g.label}
                  aria-label={g.label}
                  aria-current={group.id === g.id ? "page" : undefined}
                  onClick={(e) => {
                    if (!plainClick(e)) return;
                    e.preventDefault();
                    setMenu(null);
                    openGroup(g.id);
                  }}
                >
                  <GroupIcon gid={g.id} />
                  <span className="tab-label">{g.short}</span>
                </a>
              ),
            )}
          </div>
        </nav>

        {menu ? (
          <GroupMenu
            group={APP_GROUPS.find((g) => g.id === menu.id)!}
            current={tab}
            at={menu}
            onClose={() => setMenu(null)}
            onPick={(item) => {
              setMenu(null);
              setTab(item.id);
              // In-page view (e.g. Value's ?v=): apply after tab URL write so Ranking clears stale ?v=.
              if (item.view) {
                const { param, value } = item.view;
                window.setTimeout(() => {
                  const url = new URL(window.location.href);
                  if (value == null) url.searchParams.delete(param);
                  else url.searchParams.set(param, value);
                  const href = `${url.pathname}${url.search}${url.hash}`;
                  if (href !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
                    window.history.replaceState(window.history.state, "", href);
                  }
                  window.dispatchEvent(new PopStateEvent("popstate"));
                }, 0);
              }
            }}
          />
        ) : null}

        <div className="user-block">
          <RefreshButton />
          <ThemeToggle />
          {user ? (
            <>
              <span className="user-pill" title={user}>
                <span className="user-avatar" aria-hidden>
                  {userInitial}
                </span>
                <span className="user-email">{userLabel}</span>
              </span>
              <button type="button" className="btn-ghost btn-logout" onClick={logout}>
                Log out
              </button>
            </>
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

const GROUP_ICON: Record<string, string> = {
  napkin: "M4 19V5M4 19h16M8 15V9M12 15v-3M16 15V7",
  markets: "M3 17l6-6 4 4 8-8M15 7h6v6",
  microcap: "M3 17h18M5 17V9M9 17V6M13 17v-4M17 17V8",
  "price-action": "M3 12h4l3-8 4 16 3-8h4",
  momentum: "M3 17l5-5 4 4 9-9M14 7h7v7",
  value: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  drift: "M4 6h16M4 12h10M4 18h14",
  governance: "M12 3l9 4v6c0 5-4 8-9 9-5-1-9-4-9-9V7l9-4z",
  research: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2",
};

function GroupIcon({ gid }: { gid: string }) {
  return (
    <svg className="tab-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={GROUP_ICON[gid] ?? "M4 4h16v16H4z"} />
    </svg>
  );
}

/** Global stock search → opens Napkin for that ticker in a new tab. */
function HeaderSearch() {
  const [q, setQ] = useState("");

  const go = (raw: string) => {
    const t = raw.trim().toUpperCase();
    if (!t) return;
    setQ(t);
    window.open(napkinUrl(t), "_blank", "noopener,noreferrer");
  };

  return (
    <div className="top-search">
      <span className="top-search-ico" aria-hidden>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
      </span>
      <TickerSuggest
        value={q}
        onChange={setQ}
        onSelect={(hit) => go(hit.ticker)}
        onSubmit={(ticker) => go(ticker)}
        placeholder="Search any stock"
        className="top-search-input"
        submitLabel="napkin"
      />
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
      <span className="btn-refresh-label sr-only">Refresh</span>
    </button>
  );
}

/** Small line icons for the pages listed in a dropdown (shape only; colour from the text). */
const ICON: Partial<Record<AppTab, string>> = {
  research: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2",
  scanner: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  "screener-in": "M4 4h16v4H4zM4 10h10v10H4zM16 10h4v10h-4z",
  portfolio: "M3 8h18v11H3zM8 8V5h8v3M3 13h18",
  watchlist: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  picks: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
  scan: "M3 12h4l3-8 4 16 3-8h4",
  "momentum-money": "M3 17l5-5 4 4 9-9M14 7h7v7",
  ipo2: "M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2l.9-5.5-4-3.9 5.5-.8z",
  value: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  breakouts: "M3 17l6-6 4 4 8-8M15 7h6v6",
  microcap: "M3 17h18M5 17V9M9 17V6M13 17v-4M17 17V8",
  "micro-sectors": "M4 6h4v12H4zM10 10h4v8h-4zM16 4h4v14h-4z",
  "micro-highlow": "M4 14h4v6H4zM10 8h4v12h-4zM16 4h4v16h-4z",
  rotation: "M3 3v18h18M7 15l4-4 3 3 5-6",
};

/** Icons for in-page views listed in a dropdown (Value's ?v=). */
const VIEW_ICON: Record<string, string> = {
  cycle: "M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4",
  valuation: "M12 3v18M5 8l7-5 7 5M5 8l-2 6h4zM19 8l-2 6h4z",
  earnings: "M3 20h18M6 16v-5M10 16V8M14 16v-3M18 16V6",
  winds: "M3 8h11a3 3 0 1 0-3-3M3 16h15a3 3 0 1 1-3 3M3 12h8",
  top: "M4 14h4v6H4zM10 8h4v12h-4zM16 4h4v16h-4z",
};

/** Dropdown for a top-menu section with several pages: a titled list with an icon per page. */
function GroupMenu({
  group,
  current,
  at,
  onClose,
  onPick,
}: {
  group: AppGroup;
  current: AppTab;
  at: { left: number; top: number };
  onClose: () => void;
  onPick: (item: AppGroupItem) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: at.left, top: at.top, maxH: 0 });

  // Portal to body — topbar's backdrop-filter otherwise traps position:fixed and clips the list.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const width = el.offsetWidth || 260;
    const height = el.offsetHeight || 280;
    const left = Math.max(pad, Math.min(at.left, window.innerWidth - width - pad));
    const spaceBelow = window.innerHeight - at.top - pad;
    const spaceAbove = at.top - pad - 48;
    const openUp = spaceBelow < height && spaceAbove > spaceBelow;
    const maxH = Math.max(160, openUp ? spaceAbove : spaceBelow);
    const top = openUp ? Math.max(pad, at.top - Math.min(height, maxH) - 6) : at.top;
    setPos({ left, top, maxH });
  }, [at.left, at.top, group.id]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (ref.current?.contains(el) || el.closest("[aria-haspopup='menu']")) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  // Value-style groups mix in-page views with other pages (Portfolio) — separate those visually.
  const primaryId = group.tabs[0]!.id;
  const hasViews = group.tabs.some((t) => t.view);
  const mainTabs = hasViews ? group.tabs.filter((t) => t.id === primaryId) : group.tabs;
  const extraTabs = hasViews ? group.tabs.filter((t) => t.id !== primaryId) : [];
  const sections = extraTabs.length ? [mainTabs, extraTabs] : [group.tabs];

  const menu = (
    <div
      ref={ref}
      className="nav-menu"
      role="menu"
      aria-label={group.label}
      style={{ left: pos.left, top: pos.top, maxHeight: pos.maxH || undefined }}
    >
      <div className="nav-menu-title">{group.label}</div>
      {sections.map((section, si) => (
        <div key={si} className={si > 0 ? "nav-menu-section" : undefined} role="group">
          {section.map((t) => {
            const viewNow = t.view ? new URLSearchParams(window.location.search).get(t.view.param) : null;
            const on =
              (current === t.id && (!t.view || (viewNow ?? null) === t.view.value)) ||
              (t.id === "dashboard" && current === "governance");
            const href = t.view?.value
              ? `${hrefForTab(t.id)}&${t.view.param}=${encodeURIComponent(t.view.value)}`
              : hrefForTab(t.id);
            return (
              <a
                key={`${t.id}:${t.view?.value ?? t.label}`}
                role="menuitem"
                className={on ? "nav-menu-item on" : "nav-menu-item"}
                href={href}
                aria-current={on ? "page" : undefined}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  onPick(t);
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={(t.view?.value ? VIEW_ICON[t.view.value] : undefined) ?? ICON[t.id] ?? "M4 4h16v16H4z"} />
                </svg>
                <span>{t.label}</span>
              </a>
            );
          })}
        </div>
      ))}
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(menu, document.body);
}
