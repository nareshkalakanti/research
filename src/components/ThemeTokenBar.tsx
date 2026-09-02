"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  intent?: string;
  tokens: string[];
  original: string[];
  engine?: "llm" | "corpus";
  detail?: string;
  busy?: boolean;
  onChange: (tokens: string[]) => void;
  onApply: () => void;
  onReset: () => void;
};

function sameTokens(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t.toLowerCase() === (b[i] ?? "").toLowerCase());
}

export function ThemeTokenBar({
  intent,
  tokens,
  original,
  engine,
  detail,
  busy,
  onChange,
  onApply,
  onReset,
}: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [addValue, setAddValue] = useState("");
  const addRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const dirty = !sameTokens(tokens, original);

  useEffect(() => {
    if (editing == null) return;
    editRef.current?.focus();
    editRef.current?.select();
  }, [editing]);

  function commitEdit() {
    if (editing == null) return;
    const next = draft.trim().replace(/\s+/g, " ");
    const copy = [...tokens];
    if (!next) copy.splice(editing, 1);
    else copy[editing] = next.slice(0, 48);
    onChange(dedupe(copy));
    setEditing(null);
    setDraft("");
  }

  function addToken(raw: string) {
    const next = raw.trim().replace(/\s+/g, " ").slice(0, 48);
    if (next.length < 2) return;
    onChange(dedupe([...tokens, next]));
    setAddValue("");
  }

  return (
    <section className="token-studio" aria-label="Retrieval tokens">
      <header className="token-studio-head">
        <div className="token-studio-copy">
          <p className="token-studio-kicker">
            {engine === "corpus" ? "Your tokens" : "Model tokens"}
            {intent ? <span> · {intent}</span> : null}
          </p>
          <p className="token-studio-lead">
            Matched against messy About pages. Remove noise, add jargon — the
            list updates as you edit. Then apply if you want a full refresh.
          </p>
        </div>
        <div className="token-studio-actions">
          <button
            type="button"
            className="token-studio-ghost"
            disabled={busy || (!dirty && sameTokens(tokens, original))}
            onClick={onReset}
          >
            Reset
          </button>
          <button
            type="button"
            className="token-studio-apply"
            disabled={busy || !dirty || tokens.length === 0}
            onClick={onApply}
          >
            {busy ? "Updating…" : "Apply tokens"}
          </button>
        </div>
      </header>

      <div className="token-studio-chips">
        {tokens.map((token, i) => (
          <div
            key={`${token}-${i}`}
            className={`token-pill ${editing === i ? "is-editing" : ""}`}
          >
            {editing === i ? (
              <input
                ref={editRef}
                className="token-pill-input"
                value={draft}
                aria-label="Edit token"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitEdit();
                  }
                  if (e.key === "Escape") {
                    setEditing(null);
                    setDraft("");
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="token-pill-label"
                title="Click to edit"
                onClick={() => {
                  setEditing(i);
                  setDraft(token);
                }}
              >
                {token}
              </button>
            )}
            <button
              type="button"
              className="token-pill-x"
              aria-label={`Remove ${token}`}
              disabled={busy}
              onClick={() => onChange(tokens.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}

        <form
          className="token-add"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            addToken(addValue);
            addRef.current?.focus();
          }}
        >
          <button
            type="submit"
            className="token-add-plus"
            aria-label="Add token"
            disabled={tokens.length >= 24}
          >
            +
          </button>
          <input
            ref={addRef}
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            placeholder={tokens.length >= 24 ? "Remove one to add" : "Add token"}
            aria-label="Add retrieval token"
            maxLength={48}
            disabled={tokens.length >= 24}
          />
        </form>
      </div>

      {detail ? <p className="token-studio-detail">{detail}</p> : null}
    </section>
  );
}

function dedupe(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const s = raw.trim().replace(/\s+/g, " ");
    if (s.length < 2) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 24) break;
  }
  return out;
}
