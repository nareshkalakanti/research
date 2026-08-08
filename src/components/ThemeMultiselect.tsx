"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Theme, ThemeGroup } from "@/lib/types";

type Props = {
  groups: ThemeGroup[];
  selected: string[];
  onChange: (ids: string[]) => void;
};

export function ThemeMultiselect({ groups, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const label =
    selected.length === 0
      ? "Select themes…"
      : selected.length === 1
        ? groups.flatMap((g) => g.themes).find((t) => t.id === selected[0])
            ?.name ?? "1 theme"
        : `${selected.length} themes`;

  const query = q.trim().toLowerCase();

  const filteredGroups = useMemo(() => {
    if (!query) return groups;
    return groups
      .map((g) => ({
        ...g,
        themes: g.themes.filter((t) => {
          const hay = `${t.name} ${t.display_pattern} ${g.blog_theme}`.toLowerCase();
          return hay.includes(query);
        }),
      }))
      .filter((g) => g.themes.length > 0);
  }, [groups, query]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQ("");
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setQ("");
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      // Focus search when panel opens
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  function toggle(id: string) {
    if (selectedSet.has(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  }

  function toggleGroup(themes: Theme[]) {
    const ids = themes.map((t) => t.id);
    const allOn = ids.every((id) => selectedSet.has(id));
    if (allOn) onChange(selected.filter((id) => !ids.includes(id)));
    else onChange([...new Set([...selected, ...ids])]);
  }

  function isGroupOpen(blog: string) {
    if (query) return true; // auto-expand matches while searching
    return expanded[blog] === true;
  }

  return (
    <div className="theme-multi" ref={rootRef}>
      <button
        type="button"
        className="theme-multi-trigger"
        onClick={() =>
          setOpen((o) => {
            if (o) setQ("");
            return !o;
          })
        }
        aria-expanded={open}
      >
        <span>{label}</span>
        <span className="chev">{open ? "▴" : "▾"}</span>
      </button>

      {open ? (
        <div className="theme-multi-panel">
          <div className="theme-multi-search">
            <span className="search-icon" aria-hidden>
              ⌕
            </span>
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search themes…"
              aria-label="Search themes"
            />
            {q ? (
              <button
                type="button"
                className="theme-search-clear"
                onClick={() => setQ("")}
                aria-label="Clear search"
              >
                ×
              </button>
            ) : null}
          </div>
          <div className="theme-multi-actions">
            <button
              type="button"
              onClick={() => {
                onChange([]);
              }}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() =>
                onChange(
                  filteredGroups.flatMap((g) => g.themes.map((t) => t.id)),
                )
              }
            >
              Select all{query ? " matches" : ""}
            </button>
          </div>
          {filteredGroups.length === 0 ? (
            <p className="theme-multi-empty">No themes match “{q.trim()}”.</p>
          ) : (
            filteredGroups.map((g) => {
              const isOpen = isGroupOpen(g.blog_theme);
              return (
                <div key={g.blog_theme} className="theme-group">
                  <div className="theme-group-head">
                    <button
                      type="button"
                      className="theme-group-toggle"
                      onClick={() =>
                        setExpanded((e) => ({
                          ...e,
                          [g.blog_theme]: !isOpen,
                        }))
                      }
                    >
                      <span className="chev small">{isOpen ? "▾" : "▸"}</span>
                      {g.blog_theme}
                      <span className="count">{g.themes.length}</span>
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => toggleGroup(g.themes)}
                    >
                      {g.themes.every((t) => selectedSet.has(t.id))
                        ? "None"
                        : "All"}
                    </button>
                  </div>
                  {isOpen ? (
                    <ul className="theme-list">
                      {g.themes.map((t) => (
                        <li key={t.id}>
                          <label className="theme-item">
                            <input
                              type="checkbox"
                              checked={selectedSet.has(t.id)}
                              onChange={() => toggle(t.id)}
                            />
                            <span className="theme-item-body">
                              <span className="theme-item-name">{t.name}</span>
                              <span className="theme-item-pattern">
                                {t.display_pattern}
                              </span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
