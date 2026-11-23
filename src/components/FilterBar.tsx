"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

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
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<CSSProperties | null>(null);

  const placePop = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 340), window.innerWidth - 16);
    const maxH = Math.min(360, Math.max(200, window.innerHeight - 24));
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const spaceAbove = r.top - 8;
    const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
    const height = Math.min(maxH, openUp ? spaceAbove : spaceBelow);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    setPos(
      openUp
        ? { position: "fixed", left, bottom: window.innerHeight - r.top + 6, width, maxHeight: height, zIndex: 10050 }
        : { position: "fixed", left, top: r.bottom + 6, width, maxHeight: height, zIndex: 10050 },
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    placePop();
  }, [open, placePop, options.length, q]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => placePop();
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, placePop]);

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const chosen = options.filter((o) => values.includes(o.id));
  const summary = !chosen.length
    ? allLabel
    : chosen.length <= 2
      ? chosen.map((o) => o.label).join(", ")
      : `${chosen[0]!.label} +${chosen.length - 1}`;
  const toggle = (id: string) => onChange(values.includes(id) ? values.filter((x) => x !== id) : [...values, id]);
  const filtered = options.filter((o) => !q.trim() || o.label.toLowerCase().includes(q.trim().toLowerCase()));

  const panel =
    open && pos
      ? createPortal(
          <div ref={popRef} className="fb-pop fb-pop--portal" style={pos} role="group" aria-label={label}>
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
                autoFocus
              />
            ) : null}
            <ul>
              {!filtered.length ? (
                <li className="fb-pop-empty">{options.length ? "No matches." : "Loading industries…"}</li>
              ) : (
                filtered.map((o) => (
                  <li key={o.id}>
                    <label title={o.title}>
                      <input type="checkbox" checked={values.includes(o.id)} onChange={() => toggle(o.id)} />
                      <span>{o.label}</span>
                      {o.count != null ? <span className="fb-n">{fmt(o.count)}</span> : null}
                    </label>
                  </li>
                ))
              )}
            </ul>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={`fb-multi${open ? " fb-multi--open" : ""}`}>
      <button
        ref={btnRef}
        type="button"
        className="fb-multi-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${summary}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="fb-k">{label}</span>
        <span className="fb-v">{summary}</span>
        <span className="fb-caret" aria-hidden>
          ▾
        </span>
      </button>
      {panel}
    </div>
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

/**
 * Checkbox: when on, the Industry MultiPick is set to StockScans industries
 * from personal holdings. Off clears the industry filter (all).
 */
export function HoldingsIndustryCheck({
  values,
  onChange,
  available,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  /** When set, only holdings industries that exist in this list are applied. */
  available?: string[];
}) {
  const [holdIndustries, setHoldIndustries] = useState<string[]>([]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/holdings", { cache: "no-store" });
        const j = (await res.json()) as { ok?: boolean; industries?: string[]; count?: number };
        if (!live || !res.ok || j.ok === false) return;
        setHoldIndustries(j.industries ?? []);
        setCount(j.count ?? 0);
      } catch {
        /* keep empty */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const target = useMemo(() => {
    if (!holdIndustries.length) return [] as string[];
    if (!available?.length) return holdIndustries;
    const allow = new Set(available);
    return holdIndustries.filter((i) => allow.has(i));
  }, [holdIndustries, available]);

  const on =
    target.length > 0 &&
    values.length === target.length &&
    target.every((i) => values.includes(i));

  return (
    <button
      type="button"
      className={`fb-toggle fb-hold-ind${on ? " on" : ""}`}
      aria-pressed={on}
      disabled={!target.length}
      title={
        !holdIndustries.length
          ? "No holdings yet"
          : !target.length
            ? "Holdings industries are not in this list"
            : on
              ? `Showing ${target.length} holdings industries · click to clear`
              : `Select ${target.length} industries from your holdings (${count} stocks)`
      }
      onClick={() => onChange(on ? [] : target)}
    >
      <span className="fb-dot" aria-hidden />
      My holdings
      {target.length ? <span className="fb-n">{fmt(target.length)}</span> : null}
    </button>
  );
}

/** Pushes what follows to the right end of the bar. */
export function Spacer() {
  return <span className="fb-spacer" />;
}

export type ExchangeId = "all" | "NSE" | "NSE SME" | "BSE" | "BSE SME";
const EXCHANGES: Array<{ id: ExchangeId; label: string }> = [
  { id: "all", label: "All" },
  { id: "NSE", label: "NSE" },
  { id: "NSE SME", label: "NSE SME" },
  { id: "BSE", label: "BSE" },
  { id: "BSE SME", label: "BSE SME" },
];

/** Exact board match: NSE main · NSE SME · BSE main · BSE SME. */
export function exchangeMatch(market: string | null | undefined, ex: ExchangeId): boolean {
  if (ex === "all") return true;
  return (market || "NSE").trim().toUpperCase() === ex;
}

/** All · NSE · NSE SME · BSE · BSE SME switch, with counts when given. */
export function ExchangeSeg({
  value,
  onChange,
  markets,
}: {
  value: ExchangeId;
  onChange: (v: ExchangeId) => void;
  /** Rows' market strings, to show a count per board. */
  markets?: Array<string | null | undefined>;
}) {
  const counts = new Map<string, number>();
  for (const m of markets ?? []) {
    const k = (m || "NSE").trim().toUpperCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return (
    <Seg
      label="Exchange"
      value={value}
      onChange={onChange}
      options={EXCHANGES.map((e) => ({
        ...e,
        count: markets ? (e.id === "all" ? markets.length : counts.get(e.id) ?? 0) : undefined,
      }))}
    />
  );
}
