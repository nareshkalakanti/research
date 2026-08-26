"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SavedSearchRow, SavedSearchScope } from "@/lib/saved-searches";

type Props = {
  scope: SavedSearchScope;
  pattern: string;
  themeIds?: string[];
  onApply: (search: SavedSearchRow) => void;
  activeId?: number | null;
};

function chipTitle(s: SavedSearchRow): string {
  const parts = [
    s.pattern.trim() || null,
    s.theme_ids.length ? `${s.theme_ids.length} theme(s)` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : s.name;
}

export function SavedSearchesBar({
  scope,
  pattern,
  themeIds = [],
  onApply,
  activeId = null,
}: Props) {
  const [searches, setSearches] = useState<SavedSearchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;

  const canSave =
    pattern.trim().length > 0 || (scope === "theme" && themeIds.length > 0);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/saved-searches");
      const j = (await res.json()) as {
        ok?: boolean;
        searches?: SavedSearchRow[];
      };
      if (res.ok && j.ok) setSearches(j.searches ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const cancelSave = useCallback(() => {
    setSaving(false);
    setSaveName("");
    setError(null);
  }, []);

  const submitSave = useCallback(async () => {
    setError(null);
    const name = saveName.trim();
    if (!name) {
      setError("Name required");
      return;
    }
    try {
      const res = await fetch("/api/saved-searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          pattern: pattern.trim(),
          theme_ids: scope === "theme" ? themeIds : [],
          scope,
        }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        error?: string;
        search?: SavedSearchRow;
      };
      if (!res.ok || !j.ok || !j.search) {
        setError(j.error || "Could not save");
        return;
      }
      setSaveName("");
      setSaving(false);
      await reload();
      onApplyRef.current(j.search);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  }, [pattern, reload, saveName, scope, themeIds]);

  async function onDelete(id: number) {
    await fetch(`/api/saved-searches?id=${id}`, { method: "DELETE" });
    await reload();
  }

  if (loading && !searches.length && !canSave && !saving) return null;
  if (!loading && !searches.length && !canSave && !saving) return null;

  return (
    <div className="saved-kw-row" aria-label="Saved keywords">
      <span className="saved-kw-label">Saved</span>
      <div className="saved-kw-track">
        {searches.map((s) => (
          <div
            key={s.id}
            className={`saved-kw-pill${activeId === s.id ? " on" : ""}`}
            title={chipTitle(s)}
          >
            <button
              type="button"
              className="saved-kw-pill-label"
              onClick={() => onApplyRef.current(s)}
            >
              {s.name}
              {s.theme_ids.length ? (
                <span className="saved-kw-badge">{s.theme_ids.length}</span>
              ) : null}
            </button>
            <button
              type="button"
              className="saved-kw-x"
              aria-label={`Remove ${s.name}`}
              onClick={() => void onDelete(s.id)}
            >
              ×
            </button>
          </div>
        ))}

        {saving ? (
          <div className="saved-kw-inline">
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitSave();
                }
                if (e.key === "Escape") cancelSave();
              }}
              placeholder="Name"
              autoFocus
              aria-label="Saved search name"
            />
            <button
              type="button"
              className="saved-kw-inline-ok"
              onClick={() => void submitSave()}
            >
              Save
            </button>
            <button
              type="button"
              className="saved-kw-inline-cancel"
              onClick={cancelSave}
            >
              ×
            </button>
          </div>
        ) : canSave ? (
          <button
            type="button"
            className="saved-kw-add"
            title="Save current search"
            aria-label="Save current search"
            onClick={() => {
              setSaving(true);
              setSaveName(pattern.trim().split("|")[0]?.trim() ?? "");
              setError(null);
            }}
          >
            +
          </button>
        ) : null}
      </div>
      {error ? <span className="saved-kw-error">{error}</span> : null}
    </div>
  );
}
