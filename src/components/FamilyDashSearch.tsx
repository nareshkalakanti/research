"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type DashSuggestHit =
  | { kind: "group"; key: string; label: string; detail: string }
  | { kind: "person"; person_id: string; label: string; detail: string }
  | { kind: "ticker"; ticker: string; label: string; detail: string };

type Props = {
  value: string;
  onChange: (q: string) => void;
  placeholder?: string;
  disabled?: boolean;
  hits: DashSuggestHit[];
  loading?: boolean;
  onPick: (hit: DashSuggestHit) => void;
};

export function FamilyDashSearch({
  value,
  onChange,
  placeholder,
  disabled,
  hits,
  loading,
  onPick,
}: Props) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const q = value.trim();
  const showPanel = open && q.length >= 1;

  useEffect(() => {
    setMounted(true);
  }, []);

  const updatePos = useCallback(() => {
    const el = fieldRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 320), 440);
    let left = r.left;
    if (left + width > window.innerWidth - 12) {
      left = Math.max(12, window.innerWidth - width - 12);
    }
    setPos({ top: r.bottom + 6, left, width });
  }, []);

  useLayoutEffect(() => {
    if (!showPanel) {
      setPos(null);
      return;
    }
    updatePos();
  }, [showPanel, hits.length, updatePos]);

  useEffect(() => {
    if (!showPanel) return;
    const onWin = () => updatePos();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [showPanel, updatePos]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if ((t as Element).closest?.(".ticker-suggest-portal")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pick = (hit: DashSuggestHit) => {
    onPick(hit);
    setOpen(false);
  };

  const panel =
    mounted && showPanel && pos
      ? createPortal(
          <div
            className="ticker-suggest-portal"
            style={{ top: pos.top, left: pos.left, width: pos.width }}
          >
            <div className="ticker-suggest-panel" role="presentation">
              {hits.length ? (
                <ul
                  id={listId}
                  className="ticker-suggest-list"
                  role="listbox"
                >
                  {hits.map((h, i) => (
                    <li
                      key={`${h.kind}-${h.kind === "ticker" ? h.ticker : h.kind === "person" ? h.person_id : h.key}`}
                      role="option"
                      aria-selected={i === active}
                      className={`ticker-suggest-item${i === active ? " is-active" : ""}`}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(h);
                      }}
                    >
                      <div className="ticker-suggest-main">
                        <div className="ticker-suggest-top">
                          <span className="ticker-suggest-sym">{h.label}</span>
                          <span className="ticker-suggest-mkt">
                            {h.kind === "group"
                              ? "Group"
                              : h.kind === "person"
                                ? "Person"
                                : "Stock"}
                          </span>
                        </div>
                        <div className="ticker-suggest-name">{h.detail}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : loading ? (
                <div className="ticker-suggest-empty">Searching…</div>
              ) : (
                <div className="ticker-suggest-empty">
                  No matches for <strong>{q}</strong>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      className={`ticker-suggest fam-dash-suggest${showPanel ? " is-open" : ""}`}
      ref={wrapRef}
    >
      <div className="ticker-suggest-field" ref={fieldRef}>
        <input
          type="search"
          className="fam-dash-search"
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listId}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => {
            if (q.length >= 1) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!hits.length) return;
              setOpen(true);
              setActive((i) => (i + 1) % hits.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              if (!hits.length) return;
              setActive((i) => (i - 1 + hits.length) % hits.length);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              return;
            }
            if (e.key === "Enter" && hits[active]) {
              e.preventDefault();
              pick(hits[active]!);
            }
          }}
        />
      </div>
      {panel}
    </div>
  );
}
