"use client";

import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
export const THEME_KEY = "research-theme";

/** Applied before first paint by the inline script in layout.tsx (no white flash). */
export const THEME_BOOT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t!=="light"&&t!=="dark")t="dark";document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.dataset.theme="dark";}})();`;

function current(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Sun / moon switch in the top bar. Dark is the default; the choice is remembered. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    const id = window.setTimeout(() => setTheme(current()), 0);
    return () => window.clearTimeout(id);
  }, []);
  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: still switches for this visit */
    }
    setTheme(next);
  };
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button type="button" className="theme-toggle" onClick={flip} aria-label={label} title={label}>
      {theme === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" fill="currentColor" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="4.2" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
          </g>
        </svg>
      )}
    </button>
  );
}
