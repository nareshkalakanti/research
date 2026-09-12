"use client";

import { useState, type ReactNode } from "react";

/**
 * Collapsible tip / recommendation block (OrderBook Recommendation,
 * BoardRoom How it works, etc.). Collapsed by default.
 */
export function IqHintPanel({
  title,
  children,
  defaultOpen = false,
  className,
  "aria-label": ariaLabel,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={`iq-hint${open ? "" : " is-collapsed"}${
        className ? ` ${className}` : ""
      }`}
      aria-label={ariaLabel || title}
    >
      <button
        type="button"
        className="iq-hint-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="iq-hint-title">{title}</span>
        <span className="iq-hint-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="iq-hint-chip">{open ? "Minimise" : "Expand"}</span>
      </button>
      <div
        className="iq-hint-body"
        hidden={!open}
        inert={!open ? true : undefined}
      >
        {children}
      </div>
    </section>
  );
}
