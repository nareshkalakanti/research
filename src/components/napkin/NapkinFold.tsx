"use client";

import { useState, type ReactNode } from "react";

/**
 * A Napkin section the reader can hide: a small "Hide" control above it, or a one-line bar
 * with its title when hidden. Open by default; the choice is remembered per section.
 */
export function NapkinFold({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const key = `napkin_fold:${id}`;
  // Napkin renders in the browser only (no server render), so the saved choice can be read up front.
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== "0";
    } catch {
      return true;
    }
  });
  const set = (v: boolean) => {
    setOpen(v);
    try {
      if (v) localStorage.removeItem(key);
      else localStorage.setItem(key, "0");
    } catch {
      /* private mode */
    }
  };
  if (!open)
    return (
      <button type="button" className="napkin-fold-bar" aria-expanded={false} onClick={() => set(true)}>
        <span>{title}</span>
        <em>Show ▾</em>
      </button>
    );
  return (
    <div className="napkin-fold">
      <div className="napkin-fold-head">
        <button type="button" aria-expanded onClick={() => set(false)} title={`Hide ${title}`}>
          Hide {title} ▴
        </button>
      </div>
      {children}
    </div>
  );
}
