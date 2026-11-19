"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Compact filter toolbar shared by Shortlist, Smart Money and Quality Growth. */

export type Opt<T extends string> = { id: T; label: string; count?: number; title?: string };

const fmt = (n?: number) => (n == null ? "" : n.toLocaleString("en-IN"));

export function PageHead({ title, sub, children }: { title: string; sub: ReactNode; children?: ReactNode }) {
  return (
    <header className="fb-head">
      <div className="fb-head-text">
        <h2>{title}</h2>
        <p>{sub}</p>
      </div>
      {children ? (
        <details className="fb-how">
          <summary>How it works</summary>
          <div className="fb-how-body">{children}</div>
        </details>
      ) : null}
    </header>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="fb" role="toolbar">{children}</div>;
}

/** Segmented switch: a few mutually exclusive choices. */
export function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: Opt<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="fb-seg" role="group" aria-label={label}>
      {label ? <span className="fb-k">{label}</span> : null}
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={value === o.id ? "on" : ""}
          aria-pressed={value === o.id}
          title={o.title}
          onClick={() => onChange(o.id)}
        >
          {o.label}
          {o.count != null ? <span className="fb-n">{fmt(o.count)}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Labelled dropdown for one choice out of many. */
export function Pick<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Opt<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="fb-pick">
      <span className="fb-k">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} aria-label={label}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
            {o.count != null ? ` (${fmt(o.count)})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Dropdown with checkboxes: pick several (themes, investors). Empty = all. */
export function MultiPick({
  label,
  allLabel,
  values,
  options,
  onChange,
  searchable = false,
}: {
  label: string;
  allLabel: string;
  values: string[];
  options: Opt<string>[];
  onChange: (v: string[]) => void;
  /** Show a search box (long lists such as industries). */
  searchable?: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        ref.current.open = false;
        setOpen(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && ref.current) {
        ref.current.open = false;
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const chosen = options.filter((o) => values.includes(o.id));
  const summary = !chosen.length
    ? allLabel
    : chosen.length <= 2
      ? chosen.map((o) => o.label).join(", ")
      : `${chosen[0]!.label} +${chosen.length - 1}`;
  const toggle = (id: string) => onChange(values.includes(id) ? values.filter((x) => x !== id) : [...values, id]);
  return (
    <details ref={ref} className="fb-multi" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary aria-label={`${label}: ${summary}`}>
        <span className="fb-k">{label}</span>
        <span className="fb-v">{summary}</span>
        <span className="fb-caret" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="fb-pop" role="group" aria-label={label}>
        <div className="fb-pop-head">
          <span>{chosen.length ? `${chosen.length} selected` : allLabel}</span>
          {chosen.length ? (
            <button type="button" onClick={() => onChange([])}>
              Clear
            </button>
          ) : null}
        </div>
        {searchable ? (
          <input
            className="fb-search"
            placeholder="Search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label={`Search ${label}`}
          />
        ) : null}
        <ul>
          {options
            .filter((o) => !q.trim() || o.label.toLowerCase().includes(q.trim().toLowerCase()))
            .map((o) => (
            <li key={o.id}>
              <label title={o.title}>
                <input type="checkbox" checked={values.includes(o.id)} onChange={() => toggle(o.id)} />
                <span>{o.label}</span>
                {o.count != null ? <span className="fb-n">{fmt(o.count)}</span> : null}
              </label>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/** On/off filter pill. */
export function Toggle({
  label,
  checked,
  onChange,
  count,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  count?: number;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`fb-toggle${checked ? " on" : ""}`}
      aria-pressed={checked}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span className="fb-dot" aria-hidden />
      {label}
      {count != null ? <span className="fb-n">{fmt(count)}</span> : null}
    </button>
  );
}

/** Pushes what follows to the right end of the bar. */
export function Spacer() {
  return <span className="fb-spacer" />;
}
